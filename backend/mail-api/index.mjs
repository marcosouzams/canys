// API do webmail canys.com.br — roda como Lambda atrás de uma Function URL.
//
// Autenticação:
//   - Usuários (email + senha) guardados em users/<local>.json (hash scrypt).
//   - POST /auth/register exige o token de administração (env AUTH_TOKEN).
//   - POST /auth/login devolve um token de sessão (HMAC, 30 dias) que vai no
//     header `x-auth-token` das demais rotas. O token de administração também
//     é aceito nesse header (para scripts/testes).
//
// Modelo de pastas:
//   - Recebidos ficam fisicamente em inbox/<id> (MIME cru); a pasta LÓGICA
//     (inbox|spam|trash|archive) vive no meta/<id>.json, junto com read e
//     starred. Spam é classificado automaticamente pelo verdito do SES.
//   - Enviados são JSON em sent/ (folder: sent|trash).
//   - Rascunhos são JSON em drafts/.
//
// Rotas:
//   POST /auth/register   { email, password, adminToken }
//   POST /auth/login      { email, password } -> { token, email }
//   GET  /emails?folder=inbox|starred|drafts|sent|spam|trash|archive
//   GET  /email?key=<s3key>
//   GET  /attachment?key=&index=N
//   POST /send            { to, subject, text, html?, attachments?, fromLocal?, draftKey? }
//   POST /draft           { key?, to, subject, text, html, attachments? } -> { key }
//   POST /batch           { keys: [], action: trash|delete|move|read|unread|star|unstar, folder? }

import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import PostalMime from 'postal-mime';

const BUCKET = process.env.BUCKET;
const DOMAIN = process.env.DOMAIN || 'canys.com.br';
const AUTH_TOKEN = process.env.AUTH_TOKEN;
const LIST_LIMIT = 50;
const META_SCAN_LIMIT = 300; // quantos metas hidratar por listagem
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PAYLOAD_BYTES = 4_500_000;

const s3 = new S3Client({});
const ses = new SESv2Client({});

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  },
  body: JSON.stringify(body),
});

// Rate limit de autenticação (melhor esforço, por container da Lambda):
// 5 falhas seguidas bloqueiam a chave por 15 minutos.
const authFailures = new Map();
const AUTH_MAX_FAILURES = 5;
const AUTH_LOCK_MS = 15 * 60 * 1000;

function authLockedMinutes(key) {
  const f = authFailures.get(key);
  if (f && f.count >= AUTH_MAX_FAILURES && Date.now() < f.until) {
    return Math.ceil((f.until - Date.now()) / 60000);
  }
  return 0;
}
function noteAuthFailure(key) {
  const f = authFailures.get(key) || { count: 0, until: 0 };
  f.count++;
  f.until = Date.now() + AUTH_LOCK_MS;
  authFailures.set(key, f);
}
const clearAuthFailures = (key) => authFailures.delete(key);
// pequena espera em falhas para encarecer força bruta
const failureDelay = () => new Promise((r) => setTimeout(r, 300 + Math.random() * 500));

const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

// ---------- sessões ----------

function makeSession(local) {
  const payload = Buffer.from(
    JSON.stringify({ u: local, exp: Date.now() + SESSION_TTL_MS })
  ).toString('base64url');
  const sig = createHmac('sha256', AUTH_TOKEN).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function checkSession(token) {
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', AUTH_TOKEN).update(payload).digest('base64url');
  if (!safeEqual(expected, sig)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    return data.exp > Date.now() ? data.u : null;
  } catch {
    return null;
  }
}

function authenticate(event) {
  const token = event.headers?.['x-auth-token'] ?? '';
  if (!token) return null;
  if (safeEqual(token, AUTH_TOKEN)) return { master: true };
  const user = checkSession(token);
  return user ? { user } : null;
}

// ---------- usuários ----------

const normalizeLocal = (email) =>
  String(email || '')
    .trim()
    .toLowerCase()
    .replace('@' + DOMAIN, '');

const validLocal = (local) => /^[a-z0-9][a-z0-9._-]{0,29}$/.test(local);

const userKey = (local) => `users/${local}.json`;

async function handleRegister(body) {
  const { email, password, adminToken } = body;
  const lockedMin = authLockedMinutes('register');
  if (lockedMin) {
    return json(429, { error: `muitas tentativas; tente de novo em ${lockedMin} min` });
  }
  if (!safeEqual(adminToken || '', AUTH_TOKEN)) {
    noteAuthFailure('register');
    await failureDelay();
    return json(403, { error: 'token de administração inválido' });
  }
  clearAuthFailures('register');
  const local = normalizeLocal(email);
  if (!validLocal(local)) {
    return json(400, { error: 'endereço inválido (use letras, números, ponto, hífen)' });
  }
  if (String(password || '').length < 8) {
    return json(400, { error: 'a senha precisa ter pelo menos 8 caracteres' });
  }
  if (await getJsonObject(userKey(local))) {
    return json(409, { error: 'esse usuário já existe' });
  }
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  await putJson(userKey(local), {
    local,
    salt,
    hash,
    createdAt: new Date().toISOString(),
  });
  return json(200, { ok: true, email: `${local}@${DOMAIN}`, token: makeSession(local) });
}

async function handleLogin(body) {
  const local = normalizeLocal(body.email);
  const lockedMin = authLockedMinutes(`login:${local}`);
  if (lockedMin) {
    return json(429, { error: `muitas tentativas; tente de novo em ${lockedMin} min` });
  }
  const user = validLocal(local) ? await getJsonObject(userKey(local)) : null;
  const password = String(body.password || '');
  if (!user || !safeEqual(scryptSync(password, user.salt, 32).toString('hex'), user.hash)) {
    noteAuthFailure(`login:${local}`);
    await failureDelay();
    return json(401, { error: 'e-mail ou senha incorretos' });
  }
  clearAuthFailures(`login:${local}`);
  return json(200, { token: makeSession(local), email: `${local}@${DOMAIN}` });
}

// ---------- helpers S3 ----------

async function getObject(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return Buffer.from(await res.Body.transformToByteArray());
}

async function getJsonObject(key) {
  try {
    return JSON.parse((await getObject(key)).toString('utf-8'));
  } catch {
    return null;
  }
}

const putJson = (key, value) =>
  s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: JSON.stringify(value),
      ContentType: 'application/json',
    })
  );

const deleteObject = (key) =>
  s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));

const metaKeyFor = (inboxKey) => 'meta/' + inboxKey.slice('inbox/'.length) + '.json';

const addressToString = (addr) =>
  !addr ? '' : addr.name ? `${addr.name} <${addr.address}>` : (addr.address ?? '');

async function parseRaw(key) {
  const raw = await getObject(key);
  return new PostalMime().parse(raw);
}

async function listKeys(prefix, max) {
  const res = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, MaxKeys: 1000 })
  );
  return (res.Contents || [])
    .filter((o) => o.Size > 0)
    .sort((a, b) => b.LastModified - a.LastModified)
    .slice(0, max);
}

// ---------- metas ----------

const sesVerdictFailed = (headers, name) =>
  (headers || []).some(
    (h) => h.key?.toLowerCase() === name && /fail/i.test(String(h.value || ''))
  );

async function inboxMeta(inboxKey, lastModified) {
  const metaKey = metaKeyFor(inboxKey);
  const cached = await getJsonObject(metaKey);
  if (cached) {
    // migração leve: metas antigos sem os campos novos
    if (!cached.folder) cached.folder = 'inbox';
    if (cached.starred === undefined) cached.starred = false;
    return cached;
  }

  let meta;
  try {
    const mail = await parseRaw(inboxKey);
    const isSpam =
      sesVerdictFailed(mail.headers, 'x-ses-spam-verdict') ||
      sesVerdictFailed(mail.headers, 'x-ses-virus-verdict');
    meta = {
      key: inboxKey,
      subject: mail.subject || '(sem assunto)',
      from: addressToString(mail.from),
      date: mail.date || lastModified,
      snippet: (mail.text || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      attachments: (mail.attachments || []).filter((a) => a.disposition !== 'inline').length,
      read: false,
      folder: isSpam ? 'spam' : 'inbox',
      starred: false,
    };
  } catch (err) {
    console.error('parse failed for', inboxKey, err);
    meta = {
      key: inboxKey,
      subject: '(e-mail ilegível)',
      from: '',
      date: lastModified,
      snippet: '',
      attachments: 0,
      read: false,
      folder: 'inbox',
      starred: false,
    };
  }
  await putJson(metaKey, meta);
  return meta;
}

// ---------- listagem ----------

async function allInboxMetas() {
  const objects = await listKeys('inbox/', META_SCAN_LIMIT);
  return Promise.all(objects.map((o) => inboxMeta(o.Key, o.LastModified?.toISOString())));
}

async function allSentRecords() {
  const objects = await listKeys('sent/', META_SCAN_LIMIT);
  const records = await Promise.all(objects.map((o) => getJsonObject(o.Key)));
  return records.filter(Boolean).map((r) => ({
    key: r.key,
    to: r.to,
    from: r.from,
    subject: r.subject,
    date: r.date,
    snippet: r.snippet ?? (r.text || '').slice(0, 140),
    attachments: r.attachments || 0,
    folder: r.folder || 'sent',
    starred: !!r.starred,
    read: true,
    origin: 'sent',
  }));
}

async function handleListEmails(folder) {
  if (folder === 'drafts') {
    const objects = await listKeys('drafts/', META_SCAN_LIMIT);
    const records = await Promise.all(objects.map((o) => getJsonObject(o.Key)));
    const items = records.filter(Boolean).map((r) => ({
      key: r.key,
      to: r.to,
      subject: r.subject,
      date: r.date,
      snippet: (r.text || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      attachments: (r.attachments || []).length,
      folder: 'drafts',
      read: true,
      starred: false,
      origin: 'draft',
    }));
    return json(200, { items: items.slice(0, LIST_LIMIT) });
  }

  if (folder === 'sent') {
    const items = (await allSentRecords()).filter((r) => r.folder !== 'trash');
    return json(200, { items: items.slice(0, LIST_LIMIT) });
  }

  const metas = await allInboxMetas();
  let items;
  if (folder === 'starred') {
    items = metas.filter((m) => m.starred && m.folder !== 'trash' && m.folder !== 'spam');
  } else if (folder === 'trash') {
    const sentTrash = (await allSentRecords()).filter((r) => r.folder === 'trash');
    items = metas
      .filter((m) => m.folder === 'trash')
      .concat(sentTrash)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
  } else {
    items = metas.filter((m) => (m.folder || 'inbox') === folder);
  }

  // contadores para os badges da sidebar
  const counts = {
    inboxUnread: metas.filter((m) => (m.folder || 'inbox') === 'inbox' && !m.read).length,
    spam: metas.filter((m) => m.folder === 'spam').length,
  };
  return json(200, { items: items.slice(0, LIST_LIMIT), counts });
}

// ---------- leitura ----------

async function handleGetEmail(key) {
  if (key.startsWith('sent/') || key.startsWith('drafts/')) {
    const record = await getJsonObject(key);
    if (!record) return json(404, { error: 'não encontrado' });
    return json(200, record);
  }
  const mail = await parseRaw(key);

  let html = mail.html || null;
  const usedCids = new Set();
  if (html) {
    const byCid = new Map();
    for (const a of mail.attachments || []) {
      if (a.contentId) byCid.set(a.contentId.replace(/[<>]/g, ''), a);
    }
    html = html.replace(/cid:([^"')\s>]+)/gi, (match, id) => {
      const att = byCid.get(id);
      if (!att) return match;
      usedCids.add(id);
      return `data:${att.mimeType};base64,${Buffer.from(att.content).toString('base64')}`;
    });
  }

  const attachments = (mail.attachments || [])
    .map((a, i) => ({ ...a, index: i }))
    .filter((a) => !(a.contentId && usedCids.has(a.contentId.replace(/[<>]/g, ''))))
    .map((a) => ({
      index: a.index,
      filename: a.filename || `anexo-${a.index + 1}`,
      mimeType: a.mimeType,
      size: a.content?.byteLength ?? 0,
    }));

  const meta = await getJsonObject(metaKeyFor(key));

  return json(200, {
    key,
    subject: mail.subject || '(sem assunto)',
    from: addressToString(mail.from),
    to: (mail.to || []).map(addressToString).join(', '),
    date: mail.date,
    html,
    text: mail.text || null,
    attachments,
    folder: meta?.folder || 'inbox',
    starred: !!meta?.starred,
  });
}

async function handleGetAttachment(key, index) {
  const mail = await parseRaw(key);
  const att = (mail.attachments || [])[index];
  if (!att) return json(404, { error: 'anexo não encontrado' });
  return json(200, {
    filename: att.filename || `anexo-${index + 1}`,
    mimeType: att.mimeType,
    contentBase64: Buffer.from(att.content).toString('base64'),
  });
}

// ---------- envio (MIME raw) ----------

const encodeHeaderWord = (s) =>
  /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf-8').toString('base64')}?=`;

const foldB64 = (b64) => b64.replace(/(.{76})/g, '$1\r\n');

const b64Part = (headers, contentBase64) =>
  headers.join('\r\n') +
  '\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
  foldB64(contentBase64) +
  '\r\n';

function extractInlineImages(html) {
  const images = [];
  const out = html.replace(
    /src="data:(image\/[a-z0-9+.-]+);base64,([^"]+)"/gi,
    (_m, mimeType, contentBase64) => {
      const cid = `img${images.length + 1}.${randomBytes(6).toString('hex')}@${DOMAIN}`;
      images.push({ cid, mimeType, contentBase64 });
      return `src="cid:${cid}"`;
    }
  );
  return { html: out, images };
}

function buildRawEmail({ from, to, subject, text, html, inlineImages, attachments }) {
  const boundary = (tag) => `----=_${tag}_${randomBytes(8).toString('hex')}`;

  const textPart = b64Part(
    ['Content-Type: text/plain; charset=UTF-8'],
    Buffer.from(text, 'utf-8').toString('base64')
  );

  let body;
  let contentType;

  if (html) {
    const altB = boundary('alt');
    const htmlPart = b64Part(
      ['Content-Type: text/html; charset=UTF-8'],
      Buffer.from(html, 'utf-8').toString('base64')
    );
    body = `--${altB}\r\n${textPart}--${altB}\r\n${htmlPart}--${altB}--\r\n`;
    contentType = `multipart/alternative; boundary="${altB}"`;

    if (inlineImages.length) {
      const relB = boundary('rel');
      let rel = `--${relB}\r\nContent-Type: ${contentType}\r\n\r\n${body}`;
      for (const img of inlineImages) {
        rel +=
          `--${relB}\r\n` +
          b64Part(
            [
              `Content-Type: ${img.mimeType}`,
              `Content-ID: <${img.cid}>`,
              'Content-Disposition: inline',
            ],
            img.contentBase64
          );
      }
      body = rel + `--${relB}--\r\n`;
      contentType = `multipart/related; boundary="${relB}"`;
    }
  } else {
    body = null;
    contentType = null;
  }

  if (attachments.length) {
    const mixB = boundary('mix');
    let mix = contentType
      ? `--${mixB}\r\nContent-Type: ${contentType}\r\n\r\n${body}`
      : `--${mixB}\r\n${textPart}`;
    for (const att of attachments) {
      const filename = encodeHeaderWord(att.filename || 'anexo');
      mix +=
        `--${mixB}\r\n` +
        b64Part(
          [
            `Content-Type: ${att.mimeType || 'application/octet-stream'}`,
            `Content-Disposition: attachment; filename="${filename}"`,
          ],
          att.contentBase64
        );
    }
    body = mix + `--${mixB}--\r\n`;
    contentType = `multipart/mixed; boundary="${mixB}"`;
  }

  const headers = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodeHeaderWord(subject)}`,
    'MIME-Version: 1.0',
  ];
  if (!contentType) {
    return Buffer.from(
      headers.join('\r\n') +
        '\r\nContent-Type: text/plain; charset=UTF-8' +
        '\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
        foldB64(Buffer.from(text, 'utf-8').toString('base64')) +
        '\r\n',
      'utf-8'
    );
  }
  headers.push(`Content-Type: ${contentType}`);
  return Buffer.from(headers.join('\r\n') + '\r\n\r\n' + body, 'utf-8');
}

async function handleSend(body, auth) {
  const { to, subject, text } = body;
  if (!to || !subject || (!text && !body.html)) {
    return json(400, { error: 'campos obrigatórios: to, subject e text/html' });
  }
  const defaultLocal = auth.user || 'contato';
  const local = (body.fromLocal || defaultLocal).toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const fromAddr = `${local}@${DOMAIN}`;
  // usa o nome de exibição do perfil do remetente, se houver
  const senderProfile = await getJsonObject(userKey(local));
  const displayName = String(senderProfile?.displayName || '').trim().replace(/["<>]/g, '');
  // no cabeçalho MIME o nome vai codificado; no registro de enviados, legível
  const from = displayName ? `${encodeHeaderWord(displayName)} <${fromAddr}>` : fromAddr;
  const fromDisplay = displayName ? `${displayName} <${fromAddr}>` : fromAddr;
  const recipients = String(to)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!recipients.length) return json(400, { error: 'nenhum destinatário válido' });

  let html = body.html || null;
  let inlineImages = [];
  if (html) ({ html, images: inlineImages } = extractInlineImages(html));

  const attachments = (Array.isArray(body.attachments) ? body.attachments : []).filter(
    (a) => a && a.contentBase64
  );

  const raw = buildRawEmail({
    from,
    to: recipients,
    subject,
    text: text || '',
    html,
    inlineImages,
    attachments,
  });
  if (raw.length > MAX_PAYLOAD_BYTES) {
    return json(413, { error: 'mensagem grande demais (limite ~4 MB com anexos)' });
  }

  let res;
  try {
    res = await ses.send(
      new SendEmailCommand({
        Destination: { ToAddresses: recipients },
        Content: { Raw: { Data: raw } },
      })
    );
  } catch (err) {
    if (err.name === 'MessageRejected' && /not verified/i.test(err.message || '')) {
      return json(400, {
        error:
          'destinatário não verificado: o SES ainda está em sandbox (aguardando aprovação da AWS). ' +
          'Por enquanto só é possível enviar para @' + DOMAIN + ' e endereços verificados.',
      });
    }
    throw err;
  }

  const sentAt = new Date().toISOString();
  const key = `sent/${sentAt.replace(/[:.]/g, '-')}-${res.MessageId.slice(0, 8)}.json`;
  await putJson(key, {
    key,
    messageId: res.MessageId,
    from: fromDisplay,
    to: recipients.join(', '),
    subject,
    text: text || '',
    html: body.html || null,
    date: sentAt,
    snippet: (text || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    attachments: attachments.length,
    folder: 'sent',
  });

  // enviar a partir de um rascunho descarta o rascunho
  if (typeof body.draftKey === 'string' && /^drafts\/[^/]+$/.test(body.draftKey)) {
    await deleteObject(body.draftKey).catch(() => {});
  }
  await recordContacts(recipients);
  return json(200, { ok: true, messageId: res.MessageId });
}

// ---------- rascunhos ----------

async function handleDraft(body) {
  const key =
    typeof body.key === 'string' && /^drafts\/[^/]+$/.test(body.key)
      ? body.key
      : `drafts/${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}.json`;
  const attachments = (Array.isArray(body.attachments) ? body.attachments : []).filter(
    (a) => a && a.contentBase64
  );
  const record = {
    key,
    to: String(body.to || ''),
    subject: String(body.subject || ''),
    text: String(body.text || ''),
    html: body.html || null,
    attachments,
    fromLocal: String(body.fromLocal || ''),
    date: new Date().toISOString(),
    folder: 'drafts',
  };
  if (JSON.stringify(record).length > MAX_PAYLOAD_BYTES) {
    return json(413, { error: 'rascunho grande demais' });
  }
  await putJson(key, record);
  return json(200, { ok: true, key });
}

// ---------- contatos ----------

const CONTACTS_KEY = 'contacts.json';
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

async function loadContacts() {
  let contacts = await getJsonObject(CONTACTS_KEY);
  if (!contacts) {
    // backfill único a partir do histórico de enviados
    contacts = {};
    const objects = await listKeys('sent/', META_SCAN_LIMIT);
    const records = await Promise.all(objects.map((o) => getJsonObject(o.Key)));
    for (const r of records.filter(Boolean)) {
      for (const addr of String(r.to || '').split(',').map((s) => s.trim().toLowerCase())) {
        if (!validEmail(addr)) continue;
        contacts[addr] = contacts[addr] || { email: addr, name: '', count: 0, lastUsed: r.date || '' };
        contacts[addr].count++;
        if ((r.date || '') > (contacts[addr].lastUsed || '')) contacts[addr].lastUsed = r.date;
      }
    }
    await putJson(CONTACTS_KEY, contacts);
  }
  return contacts;
}

async function recordContacts(recipients) {
  try {
    const contacts = await loadContacts();
    const now = new Date().toISOString();
    for (const addr of recipients.map((s) => s.toLowerCase())) {
      if (!validEmail(addr)) continue;
      contacts[addr] = contacts[addr] || { email: addr, name: '', count: 0, lastUsed: now };
      contacts[addr].count++;
      contacts[addr].lastUsed = now;
    }
    await putJson(CONTACTS_KEY, contacts);
  } catch (err) {
    console.error('contacts update failed', err);
  }
}

async function handleContacts() {
  const contacts = await loadContacts();
  const items = Object.values(contacts)
    .sort((a, b) => String(b.lastUsed || '').localeCompare(String(a.lastUsed || '')))
    .slice(0, 500);
  return json(200, { items });
}

// ---------- perfil ----------

async function handleGetProfile(auth) {
  if (!auth.user) return json(400, { error: 'token de administração não tem perfil' });
  const u = await getJsonObject(userKey(auth.user));
  if (!u) return json(404, { error: 'usuário não encontrado' });
  return json(200, {
    email: `${auth.user}@${DOMAIN}`,
    displayName: u.displayName || '',
    avatar: u.avatar || null,
  });
}

async function handleSaveProfile(body, auth) {
  if (!auth.user) return json(400, { error: 'token de administração não tem perfil' });
  const u = await getJsonObject(userKey(auth.user));
  if (!u) return json(404, { error: 'usuário não encontrado' });

  if (body.displayName !== undefined) {
    u.displayName = String(body.displayName).trim().slice(0, 60);
  }
  if (body.avatar !== undefined) {
    if (body.avatar === null) u.avatar = null;
    else if (
      typeof body.avatar === 'string' &&
      /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(body.avatar) &&
      body.avatar.length < 150_000
    ) {
      u.avatar = body.avatar;
    } else {
      return json(400, { error: 'avatar inválido (imagem de até ~100 KB)' });
    }
  }
  if (body.newPassword) {
    if (String(body.newPassword).length < 8) {
      return json(400, { error: 'a nova senha precisa ter pelo menos 8 caracteres' });
    }
    if (!safeEqual(scryptSync(String(body.currentPassword || ''), u.salt, 32).toString('hex'), u.hash)) {
      return json(403, { error: 'senha atual incorreta' });
    }
    u.salt = randomBytes(16).toString('hex');
    u.hash = scryptSync(String(body.newPassword), u.salt, 32).toString('hex');
  }
  await putJson(userKey(auth.user), u);
  return json(200, { ok: true, displayName: u.displayName || '', avatar: u.avatar || null });
}

// ---------- ações em lote ----------

const INBOX_FOLDERS = new Set(['inbox', 'spam', 'trash', 'archive']);

async function applyAction(key, action, folder) {
  if (key.startsWith('drafts/')) {
    if (action === 'trash' || action === 'delete') await deleteObject(key);
    return;
  }
  if (key.startsWith('sent/')) {
    if (action === 'delete') {
      await deleteObject(key);
      return;
    }
    const record = await getJsonObject(key);
    if (!record) return;
    if (action === 'trash') record.folder = 'trash';
    else if (action === 'move') record.folder = folder === 'trash' ? 'trash' : 'sent';
    else return; // read/star não se aplicam a enviados
    await putJson(key, record);
    return;
  }
  // inbox/*
  const metaKey = metaKeyFor(key);
  if (action === 'delete') {
    await Promise.all([deleteObject(key), deleteObject(metaKey)]);
    return;
  }
  const meta = (await getJsonObject(metaKey)) || (await inboxMeta(key, null));
  if (action === 'trash') meta.folder = 'trash';
  else if (action === 'move' && INBOX_FOLDERS.has(folder)) meta.folder = folder;
  else if (action === 'read') meta.read = true;
  else if (action === 'unread') meta.read = false;
  else if (action === 'star') meta.starred = true;
  else if (action === 'unstar') meta.starred = false;
  else return;
  await putJson(metaKey, meta);
}

async function handleBatch(body) {
  const { action, folder } = body;
  const keys = (Array.isArray(body.keys) ? body.keys : []).filter(validKey).slice(0, 100);
  if (!keys.length) return json(400, { error: 'nenhuma key válida' });
  if (!['trash', 'delete', 'move', 'read', 'unread', 'star', 'unstar'].includes(action)) {
    return json(400, { error: 'ação inválida' });
  }
  await Promise.all(keys.map((k) => applyAction(k, action, folder)));
  return json(200, { ok: true, count: keys.length });
}

// ---------- router ----------

const validKey = (key) =>
  typeof key === 'string' && /^(inbox|sent|drafts)\/[^/]+$/.test(key) && !key.includes('..');

export async function handler(event) {
  const method = event.requestContext?.http?.method;
  const path = event.rawPath || '/';
  const qs = event.queryStringParameters || {};

  let body = {};
  if (method === 'POST') {
    try {
      const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body || '', 'base64').toString('utf-8')
        : event.body || '{}';
      body = JSON.parse(rawBody);
    } catch {
      return json(400, { error: 'JSON inválido' });
    }
  }

  try {
    if (method === 'POST' && path === '/auth/register') return await handleRegister(body);
    if (method === 'POST' && path === '/auth/login') return await handleLogin(body);

    const auth = authenticate(event);
    if (!auth) return json(401, { error: 'não autorizado' });

    if (method === 'GET' && path === '/emails') {
      const folder = ['inbox', 'starred', 'drafts', 'sent', 'spam', 'trash', 'archive'].includes(
        qs.folder
      )
        ? qs.folder
        : 'inbox';
      return await handleListEmails(folder);
    }
    if (method === 'GET' && path === '/email') {
      if (!validKey(qs.key)) return json(400, { error: 'key inválida' });
      return await handleGetEmail(qs.key);
    }
    if (method === 'GET' && path === '/attachment') {
      if (!validKey(qs.key)) return json(400, { error: 'key inválida' });
      return await handleGetAttachment(qs.key, Number(qs.index) || 0);
    }
    if (method === 'POST' && path === '/send') return await handleSend(body, auth);
    if (method === 'POST' && path === '/draft') return await handleDraft(body);
    if (method === 'POST' && path === '/batch') return await handleBatch(body);
    if (method === 'GET' && path === '/profile') return await handleGetProfile(auth);
    if (method === 'POST' && path === '/profile') return await handleSaveProfile(body, auth);
    if (method === 'GET' && path === '/contacts') return await handleContacts();

    return json(404, { error: 'rota não encontrada' });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'erro interno' });
  }
}
