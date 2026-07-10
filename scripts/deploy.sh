#!/usr/bin/env bash
#
# Deploy manual do site para S3 + CloudFront.
# Usa as credenciais AWS configuradas localmente (aws configure).
# Útil enquanto o deploy automático via GitHub Actions não estiver disponível.
#
set -euo pipefail

BUCKET="canys-site-b44af36c"
DISTRIBUTION_ID="EM5PUFX8CLXNE"

cd "$(dirname "$0")/.."

echo "==> Instalando dependências e buildando"
npm ci
npm run build

echo "==> Enviando assets (cache longo, imutável)"
aws s3 sync dist/ "s3://$BUCKET" \
  --delete \
  --cache-control "public,max-age=31536000,immutable"

echo "==> Reescrevendo HTML (sem cache)"
aws s3 cp dist/ "s3://$BUCKET" \
  --recursive \
  --exclude "*" --include "*.html" \
  --content-type "text/html; charset=utf-8" \
  --cache-control "public,max-age=0,must-revalidate" \
  --metadata-directive REPLACE

echo "==> Invalidando cache do CloudFront"
aws cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION_ID" \
  --paths "/*" \
  --query 'Invalidation.{Id:Id,Status:Status}' --output table

echo "==> Deploy concluído."
