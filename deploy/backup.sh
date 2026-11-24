#!/usr/bin/env bash
# Backup do PostgreSQL do projeto CACL.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/cacl-leads/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
docker exec cacl_leads_postgres pg_dump -U synclead -d synclead --no-owner \
  | gzip > "$BACKUP_DIR/synclead-$STAMP.sql.gz"
chmod 600 "$BACKUP_DIR/synclead-$STAMP.sql.gz"
# Backups contêm dados pessoais: a rotação também cobre os backups manuais pre-*.
find "$BACKUP_DIR" \( -name 'synclead-*.sql.gz' -o -name 'pre-*' \) -mtime +"$KEEP_DAYS" -delete
echo "Backup criado: $BACKUP_DIR/synclead-$STAMP.sql.gz"
