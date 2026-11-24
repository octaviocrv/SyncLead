#!/usr/bin/env bash
# Relatório de armazenamento da VPS lido pelo painel (Saúde). Rodar como root a cada 15 min via cron:
#   */15 * * * * /opt/cacl-leads/deploy/storage-report.sh
# Grava só tamanhos (bytes), sem dados pessoais, em /opt/cacl-leads/storage/report.json (montado somente leitura na API).
set -euo pipefail

BASE="${BASE:-/opt/cacl-leads}"
OUT_DIR="${OUT_DIR:-$BASE/storage}"
BACKUP_DIR="${BACKUP_DIR:-$BASE/backups}"
mkdir -p "$OUT_DIR"
chmod 755 "$OUT_DIR"

size() { du -sb "$1" 2>/dev/null | cut -f1 || true; }
num() { [[ "${1:-}" =~ ^[0-9]+$ ]] && echo "$1" || echo null; }

# Converte "2.433GB", "238.7MB", "69.63kB" (saída do docker system df) para bytes.
to_bytes() {
  awk -v v="${1:-}" 'BEGIN {
    if (match(v, /^[0-9.]+/) == 0) { print "null"; exit }
    n = substr(v, 1, RLENGTH) + 0; u = tolower(substr(v, RLENGTH + 1))
    m = (u == "kb") ? 1000 : (u == "mb") ? 1000^2 : (u == "gb") ? 1000^3 : (u == "tb") ? 1000^4 : 1
    printf "%.0f", n * m
  }'
}

df_field() { docker system df --format '{{.Type}}|{{.Size}}' | awk -F'|' -v t="$1" '$1 == t { print $2 }'; }

backups="$(num "$(size "$BACKUP_DIR")")"
logs="$(num "$(size /var/lib/docker/containers)")"
images="$(to_bytes "$(df_field Images)")"
volumes="$(to_bytes "$(df_field 'Local Volumes')")"
cache="$(to_bytes "$(df_field 'Build Cache')")"

tmp="$(mktemp "$OUT_DIR/.report.XXXXXX")"
cat > "$tmp" <<JSON
{"generatedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","backupsBytes":$backups,"dockerLogsBytes":$logs,"dockerImagesBytes":$images,"dockerVolumesBytes":$volumes,"dockerBuildCacheBytes":$cache}
JSON
chmod 644 "$tmp"
mv "$tmp" "$OUT_DIR/report.json"
