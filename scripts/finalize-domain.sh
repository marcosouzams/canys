#!/usr/bin/env bash
#
# Finaliza a configuração do domínio canys.com.br no CloudFront + Route 53.
#
# Pré-requisitos:
#   - AWS CLI v2 configurada (aws configure) na conta 202077713431
#   - Nameservers do registro.br já apontando para o Route 53 (ver README)
#   - Certificado ACM já EMITIDO (o script confere isso e aborta se não estiver)
#
# O que faz:
#   1. Confere se o certificado ACM está ISSUED
#   2. Adiciona os aliases canys.com.br + www + certificado + função de redirect
#      à distribuição CloudFront (usa infra/cloudfront-with-domain.json)
#   3. Cria os registros ALIAS A/AAAA no Route 53 (infra/route53-records.json)
#
set -euo pipefail

# ---- Identificadores da infra (fixos) ----
REGION="us-east-1"
CERT_ARN="arn:aws:acm:us-east-1:202077713431:certificate/26a6e00c-fcbc-4eef-84de-56b05c0de413"
DISTRIBUTION_ID="EM5PUFX8CLXNE"
HOSTED_ZONE_ID="Z02341823AA42D2AT489S"

cd "$(dirname "$0")/.."

echo "==> 1/3 Verificando status do certificado ACM..."
STATUS=$(aws acm describe-certificate --region "$REGION" \
  --certificate-arn "$CERT_ARN" \
  --query 'Certificate.Status' --output text)
echo "    Status do certificado: $STATUS"
if [ "$STATUS" != "ISSUED" ]; then
  echo "ERRO: o certificado ainda não foi emitido (status=$STATUS)."
  echo "      Confira se os nameservers do registro.br já apontam para o Route 53:"
  echo "        dig +short NS canys.com.br @8.8.8.8"
  echo "      (deve retornar os 4 servidores awsdns-*). Rode este script de novo depois."
  exit 1
fi

echo "==> 2/3 Atualizando a distribuição CloudFront (aliases + cert + redirect)..."
ETAG=$(aws cloudfront get-distribution-config --id "$DISTRIBUTION_ID" --query 'ETag' --output text)
aws cloudfront update-distribution \
  --id "$DISTRIBUTION_ID" \
  --distribution-config file://infra/cloudfront-with-domain.json \
  --if-match "$ETAG" \
  --query 'Distribution.{Id:Id,Status:Status,Aliases:DistributionConfig.Aliases.Items}' --output json
echo "    CloudFront atualizado. A propagação leva alguns minutos."

echo "==> 3/3 Criando registros ALIAS no Route 53 (apex + www)..."
aws route53 change-resource-record-sets \
  --hosted-zone-id "$HOSTED_ZONE_ID" \
  --change-batch file://infra/route53-records.json \
  --query 'ChangeInfo.{Status:Status,Id:Id}' --output json

echo ""
echo "==> Pronto! Após a propagação do CloudFront (~5-15 min), teste:"
echo "      curl -sI https://canys.com.br/           # deve dar HTTP 200"
echo "      curl -sI https://www.canys.com.br/        # deve dar 301 -> https://canys.com.br/"
