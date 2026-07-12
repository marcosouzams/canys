# canys

Site estático construído com [Astro](https://astro.build).

## Desenvolvimento

```bash
npm install      # instala dependências
npm run dev      # servidor local em http://localhost:4321
npm run build    # gera o site estático em dist/
npm run preview  # pré-visualiza o build
```

## Hospedagem

Site estático servido na AWS (S3 privado + CloudFront + Route 53). O deploy
automático roda via GitHub Actions (OIDC) a cada push na `main`.

**Estado da infraestrutura, o que falta e como concluir/deployar:** veja
[DEPLOY.md](DEPLOY.md).

**E-mail / Amazon SES** (webmail em `canys.com.br/mail`, estado do pedido de
produção no SES): veja [MAIL.md](MAIL.md).

No ar (URL padrão, enquanto o domínio propaga): https://d2krik7nhbw5p3.cloudfront.net
