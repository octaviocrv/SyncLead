#!/usr/bin/env bash
# Grava a configuração do Syonet no .env sem imprimir segredos. NÃO liga o envio:
# SYONET_SEND_ENABLED continua forçado a "false" pelo compose.yaml.
# Uso (na VPS): ./deploy/set-syonet-config.sh
set -euo pipefail
cd "$(dirname "$0")/.."

ask() { local prompt="$1" default="$2" value; read -rp "$prompt [$default]: " value; printf '%s' "${value:-$default}"; }

URL="$(ask 'URL da API Lead (instância + /api/lead; alternativa apikey: https://api.syonet.com/crm/v1/lead)' 'https://grupocacel.syonet.com/api/lead')"
MODE="$(ask 'Autenticação (basic/apikey)' 'basic')"
case "$MODE" in apikey|basic) ;; *) echo "Modo inválido."; exit 1 ;; esac
if [ "$MODE" = apikey ]; then
  read -rsp "API key (entrada oculta): " KEY; echo; [ -n "$KEY" ] || { echo "Vazio."; exit 1; }
else
  read -rp "Usuário: " BUSER; read -rsp "Senha (entrada oculta): " BPASS; echo
  [ -n "$BUSER" ] && [ -n "$BPASS" ] || { echo "Vazio."; exit 1; }
fi
GROUP="$(ask 'eventGroup' 'OPORTUNIDADE')"
TYPE="$(ask 'eventType' 'CONSORCIO WEB')"
SOURCE="$(ask 'source' 'INTERNET')"
DAYS="$(ask 'daysToUpdateOpenEvent (0 = sempre cria novo evento)' '0')"
PHONE="$(ask 'Formato do telefone (ddd_numero/e164)' 'ddd_numero')"
LEAD="$(ask 'leadgen_id liberado para homologação (apenas 1)' '1812546216698390')"
MEDIA="$(ask 'Mídia para lead orgânico de teste (FACEBOOK/INSTAGRAM)' 'FACEBOOK')"

umask 077
grep -vE '^(SYONET_LEAD_API_URL|SYONET_AUTH_MODE|SYONET_API_KEY|SYONET_BASIC_USER|SYONET_BASIC_PASSWORD|SYONET_EVENT_GROUP|SYONET_EVENT_TYPE|SYONET_SOURCE|SYONET_DAYS_TO_UPDATE_OPEN_EVENT|SYONET_PHONE_FORMAT|SYONET_SEND_ONLY_LEADGEN_IDS|SYONET_HOMOLOGATION_MEDIA)=' .env > .env.new
{
  printf 'SYONET_LEAD_API_URL=%s\nSYONET_AUTH_MODE=%s\n' "$URL" "$MODE"
  if [ "$MODE" = apikey ]; then printf 'SYONET_API_KEY=%s\n' "$KEY"; else printf 'SYONET_BASIC_USER=%s\nSYONET_BASIC_PASSWORD=%s\n' "$BUSER" "$BPASS"; fi
  printf 'SYONET_EVENT_GROUP=%s\nSYONET_EVENT_TYPE=%s\nSYONET_SOURCE=%s\n' "$GROUP" "$TYPE" "$SOURCE"
  printf 'SYONET_DAYS_TO_UPDATE_OPEN_EVENT=%s\nSYONET_PHONE_FORMAT=%s\n' "$DAYS" "$PHONE"
  printf 'SYONET_SEND_ONLY_LEADGEN_IDS=%s\nSYONET_HOMOLOGATION_MEDIA=%s\n' "$LEAD" "$MEDIA"
} >> .env.new
mv .env.new .env
chmod 600 .env
unset KEY BPASS

docker compose up -d api
echo "Configuração gravada; envio continua DESLIGADO. Próximo passo: ./deploy/syonet-homologation.sh"
