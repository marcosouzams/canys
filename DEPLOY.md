# Deploy & Infraestrutura — canys.com.br

Runbook de deploy e estado da infraestrutura AWS. Documento de handoff: descreve
o que já está pronto, o que falta e como concluir de outra máquina.

> **Conta AWS:** `202077713431` · **Região:** `us-east-1`
> _(Estes são identificadores de infra, não segredos. Nenhuma credencial é
> versionada aqui. Se o repositório for público, avalie mover este arquivo para
> um local privado.)_

## Arquitetura

Site estático (Astro) hospedado de forma serverless:

```
GitHub (push main) ──> GitHub Actions (OIDC) ──> S3 (privado) <── CloudFront (CDN, HTTPS) <── visitante
                                                                        ▲
                                                        Route 53 (DNS) ─┘   ACM (certificado SSL)
```

- **S3**: guarda os arquivos do build (`dist/`), bucket **privado**.
- **CloudFront**: CDN com HTTPS, lê o S3 via **OAC** (Origin Access Control).
- **ACM**: certificado SSL para `canys.com.br` + `www.canys.com.br`.
- **Route 53**: zona DNS do domínio (nameservers apontados no registro.br).
- **GitHub Actions**: deploy automático a cada push na `main` (via OIDC, sem chaves).

## ✅ Estado atual (o que já está pronto)

O site **já está no ar** na URL padrão do CloudFront (HTTPS):

**https://d2krik7nhbw5p3.cloudfront.net**

Recursos provisionados na AWS:

| Recurso | Identificador |
|---|---|
| Route 53 — Hosted Zone | `Z02341823AA42D2AT489S` |
| Nameservers (apontar no registro.br) | `ns-640.awsdns-16.net`, `ns-1410.awsdns-48.org`, `ns-29.awsdns-03.com`, `ns-2034.awsdns-62.co.uk` |
| ACM — Certificado (apex + www) | `arn:aws:acm:us-east-1:202077713431:certificate/26a6e00c-fcbc-4eef-84de-56b05c0de413` |
| S3 — Bucket (privado) | `canys-site-b44af36c` |
| CloudFront — Distribuição | `EM5PUFX8CLXNE` (domínio `d2krik7nhbw5p3.cloudfront.net`) |
| CloudFront — OAC | `E2CVNFFWYPHD55` |
| CloudFront — Função redirect www→apex | `arn:aws:cloudfront::202077713431:function/canys-www-redirect` (LIVE) |
| IAM — Role de deploy (OIDC) | `arn:aws:iam::202077713431:role/canys-github-deploy` |
| IAM — Provedor OIDC | `token.actions.githubusercontent.com` |

## ⏳ O que falta

### 1. Nameservers no registro.br (bloqueio principal)

No painel do **registro.br**, em `canys.com.br` → DNS, configurar para **usar
outros servidores DNS** e informar os 4 nameservers do Route 53 (tabela acima).

Verificar a propagação (deve retornar os 4 servidores `awsdns-*`):

```bash
dig +short NS canys.com.br @8.8.8.8
```

Enquanto ainda retornar `a.auto.dns.br` / `b.auto.dns.br`, **não** propagou.
`.com.br` costuma levar de algumas horas até ~24h.

Assim que propagar, o certificado ACM valida **sozinho** (status vai de
`PENDING_VALIDATION` para `ISSUED`). Conferir:

```bash
aws acm describe-certificate --region us-east-1 \
  --certificate-arn arn:aws:acm:us-east-1:202077713431:certificate/26a6e00c-fcbc-4eef-84de-56b05c0de413 \
  --query 'Certificate.Status' --output text
```

### 2. Plugar o domínio (rodar 1 comando)

Com o certificado **ISSUED**, rode da máquina que tiver a AWS CLI configurada:

```bash
bash scripts/finalize-domain.sh
```

Esse script (idempotente) faz tudo:
- confere se o certificado está `ISSUED` (aborta se não estiver);
- adiciona `canys.com.br` + `www.canys.com.br` à distribuição CloudFront, com o
  certificado e a função de redirect (usa `infra/cloudfront-with-domain.json`);
- cria os registros **ALIAS** A/AAAA no Route 53 (usa `infra/route53-records.json`).

Após ~5–15 min de propagação do CloudFront, testar:

```bash
curl -sI https://canys.com.br/        # HTTP 200
curl -sI https://www.canys.com.br/    # 301 -> https://canys.com.br/
```

### 3. Billing do GitHub (reativa o deploy automático)

O 1º run do GitHub Actions falhou com *"account is locked due to a billing
issue"*. Resolver em **GitHub → Settings → Billing and plans** (procurar forma de
pagamento com falha / fatura em aberto). Enquanto isso, use o deploy manual.

## Como fazer deploy

### Manual (funciona sempre, usa credenciais locais)

```bash
bash scripts/deploy.sh
```
Faz `npm ci` + `npm run build` + `s3 sync` (com cache otimizado) + invalidação do CloudFront.

### Automático (após resolver o billing do GitHub)

Basta `git push` na `main`. O workflow `.github/workflows/deploy.yml` builda e
publica via OIDC (role `canys-github-deploy`), sem chaves guardadas no GitHub.

## Pré-requisitos numa máquina nova

1. **AWS CLI v2** e credenciais da conta `202077713431`:
   ```bash
   aws configure   # informar Access Key / Secret Key / região us-east-1
   ```
2. **Node.js 22+** e **npm** (para buildar/deployar).
3. `git` com acesso ao repositório `git@github.com:marcosouzams/canys.git`.

## Custo estimado

Tráfego baixo: ~US$ 0,50–1,00/mês (Route 53 hosted zone US$ 0,50 + S3/CloudFront
em centavos). Bem mais barato que qualquer VM.
