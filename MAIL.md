# E-mail / Amazon SES — canys

Documentação do sistema de e-mail do canys e do estado do pedido de acesso de
produção no Amazon SES.

> ⚠️ O código do sistema de e-mail foi feito em outra máquina e **pode não estar
> neste repositório** (que hospeda o site estático Astro). Este arquivo é só a
> documentação de infraestrutura/estado.

## O que é

O canys usa o **Amazon SES** como transporte de saída para um webmail próprio em
`canys.com.br/mail`:

- Caixas dos funcionários — ex.: `marco@canys.com.br`, `vandeilson@canys.com.br`.
- Endereços de contato — ex.: `contato@canys.com.br`.

O uso é **correspondência 1‑para‑1 escrita à mão** + respostas ao formulário de
contato do site. **Não há** marketing, newsletters, listas ou envio em massa.
Volume esperado: **< 100 e‑mails/dia**.

## Estado (atualizado em 2026-07-11)

- ✅ Domínio `canys.com.br` **verificado** no SES.
- ✅ **DKIM** habilitado; **SPF** e **DMARC** publicados no DNS.
- ⏳ **Production access** (sair do sandbox / aumentar limite de envio):
  **pendente**. A AWS pediu mais detalhes do use case e respondemos o support
  case descrevendo volume, ausência de listas, tratamento de bounces/complaints
  (suppression list) e exemplos de mensagem.
- ❓ **Região do SES**: ainda não confirmada — provavelmente `sa-east-1`
  (São Paulo) ou `us-east-1` (N. Virginia). Confirmar no console antes de assumir.

## Console SES

Base: https://console.aws.amazon.com/ses/ — **o SES é por região**; force a
região na URL para não olhar a errada.

- Identidades verificadas (domínio + DKIM):
  `https://console.aws.amazon.com/ses/home?region=<REGIAO>#/verified-identities`
- Account dashboard (sandbox / status do pedido de produção):
  `https://console.aws.amazon.com/ses/home?region=<REGIAO>#/account`
- Reputação (bounce e complaint rate):
  `https://console.aws.amazon.com/ses/home?region=<REGIAO>#/reputation`

Troque `<REGIAO>` por `sa-east-1` ou `us-east-1`.

## Resposta enviada à AWS (production access)

Resumo do que foi respondido ao support case, para referência caso peçam mais
informações:

- **Frequência**: < 100 e‑mails/dia, pessoa‑a‑pessoa, sem batches automáticos.
- **Listas**: não há listas de marketing; destinatários são quem nos contatou
  primeiro (formulário) ou clientes com relação ativa.
- **Bounces/complaints**: monitorados via notificações + suppression list de
  conta; acompanhamos as taxas no reputation dashboard.
- **Unsubscribe**: não se aplica (não é lista); qualquer pedido de "pare de me
  enviar" é atendido na hora, pois toda caixa é operada por uma pessoa.
- **Exemplos**: resposta de `contato@canys.com.br` a um lead do formulário;
  e‑mail de `marco@canys.com.br` a um cliente sobre um projeto em andamento.

## Checklist de manutenção

- [ ] Confirmar e registrar a **região** do SES aqui neste arquivo.
- [ ] Acompanhar a resposta da AWS ao pedido de produção (~24h por rodada).
- [ ] Após aprovação, confirmar que saiu do sandbox no account dashboard.
- [ ] Manter bounce rate < 5% e complaint rate < 0,1%.
