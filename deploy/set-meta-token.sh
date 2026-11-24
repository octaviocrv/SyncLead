#!/usr/bin/env bash
# Grava META_PAGE_ACCESS_TOKEN no .env após validar o token. Não imprime o valor.
# Uso (na VPS): ./deploy/set-meta-token.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PAGE_ID="$(grep -E '^META_ALLOWED_PAGE_IDS=' .env | cut -d= -f2- | cut -d, -f1)"
VERSION="$(grep -E '^META_GRAPH_API_VERSION=' .env | cut -d= -f2-)"
REQUIRED="leads_retrieval pages_show_list pages_read_engagement pages_manage_metadata"

read -rsp "Cole o token (entrada oculta) e pressione Enter: " TOKEN
echo
[ -n "$TOKEN" ] || { echo "Token vazio."; exit 1; }

# O token trafega por stdin; nunca vai para argumentos, histórico ou logs.
printf '%s' "$TOKEN" | docker exec -i -e PAGE_ID="$PAGE_ID" -e VERSION="$VERSION" -e REQUIRED="$REQUIRED" \
  cacl_leads_api node -e '
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c)).on("end", async () => {
  const token = Buffer.concat(chunks).toString().trim();
  const base = `https://graph.facebook.com/${process.env.VERSION}`;
  const get = async (path) => {
    const url = new URL(base + path);
    url.searchParams.set("access_token", token);
    const r = await fetch(url);
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => ({})) };
  };
  const perms = await get("/me/permissions");
  if (!perms.ok) { console.error("Token rejeitado pela Meta (HTTP " + perms.status + ")."); process.exit(2); }
  const granted = new Set((perms.body.data || []).filter((p) => p.status === "granted").map((p) => p.permission));
  const missing = process.env.REQUIRED.split(" ").filter((p) => !granted.has(p));
  console.log("Permissões ausentes:", missing.length ? missing.join(", ") : "nenhuma");
  const page = await get("/" + process.env.PAGE_ID + "?fields=id,name");
  console.log("Acesso à Página " + process.env.PAGE_ID + ":", page.ok ? "OK (" + page.body.name + ")" : "FALHOU (HTTP " + page.status + ")");
  process.exit(missing.length === 0 && page.ok ? 0 : 3);
});'

# Só chega aqui se a validação passou (set -e).
umask 077
grep -v '^META_PAGE_ACCESS_TOKEN=' .env > .env.new
printf 'META_PAGE_ACCESS_TOKEN=%s\n' "$TOKEN" >> .env.new
mv .env.new .env
chmod 600 .env
unset TOKEN

docker compose up -d api
echo "Token gravado e API reiniciada."
