#!/usr/bin/env bash
# Homologação controlada: envia ao Syonet SOMENTE o lead de SYONET_SEND_ONLY_LEADGEN_IDS
# e volta automaticamente para SYONET_SEND_ENABLED=false ao final (inclusive em erro).
# Uso (na VPS): ./deploy/syonet-homologation.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PSQL=(docker exec cacl_leads_postgres psql -U synclead -d synclead -At)
LEAD="$(grep -E '^SYONET_SEND_ONLY_LEADGEN_IDS=' .env | cut -d= -f2-)"
[[ "$LEAD" =~ ^[0-9]+$ ]] || { echo "SYONET_SEND_ONLY_LEADGEN_IDS deve conter exatamente 1 leadgen_id."; exit 1; }

echo "== 1. Backup"
./deploy/backup.sh

echo "== 2. Pré-validação (credenciais, endpoint e payload final; nada é criado)"
docker compose exec -T api node dist/syonet-preflight.js

read -rp "Confirma o envio REAL do lead $LEAD ao Syonet? Digite ENVIAR: " OK
[ "$OK" = ENVIAR ] || { echo "Cancelado."; exit 1; }

restore() {
  echo "== Restaurando SYONET_SEND_ENABLED=false"
  docker compose up -d api >/dev/null
  sleep 5
  docker exec cacl_leads_api printenv SYONET_SEND_ENABLED
}
trap restore EXIT

START="$(date -u +%FT%TZ)"
echo "== 3. Ligando envio restrito ao lead $LEAD às $START"
docker compose -f compose.yaml -f compose.homologation.yaml up -d api

echo "== 4. Acompanhando o worker (até 120 s)"
for _ in $(seq 1 60); do
  STATUS="$("${PSQL[@]}" -c "SELECT status FROM leads WHERE leadgen_id = '$LEAD'")"
  case "$STATUS" in sent|blocked|failed|ambiguous|retry) break ;; esac
  sleep 2
done
docker logs --since "$START" cacl_leads_api 2>&1 | tail -20

echo "== 5. Evidências"
"${PSQL[@]}" -c "SELECT leadgen_id, status, syonet_company_id, syonet_event_id, last_error, updated_at FROM leads WHERE leadgen_id = '$LEAD'"
"${PSQL[@]}" -c "SELECT stage, status, message, created_at FROM processing_attempts WHERE leadgen_id = '$LEAD' AND created_at >= '$START' ORDER BY id"
echo "-- Payload enviado:"
"${PSQL[@]}" -c "SELECT jsonb_pretty(syonet_request) FROM lead_personal_data WHERE leadgen_id = '$LEAD'"
echo "-- Resposta do Syonet:"
"${PSQL[@]}" -c "SELECT jsonb_pretty(syonet_response), syonet_exchanged_at FROM lead_personal_data WHERE leadgen_id = '$LEAD'"
echo "-- Outros leads (não podem ter sido enviados):"
"${PSQL[@]}" -c "SELECT leadgen_id, status, syonet_event_id FROM leads WHERE leadgen_id <> '$LEAD' ORDER BY received_at"
