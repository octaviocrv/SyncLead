#!/usr/bin/env bash
# Sobe o projeto local com um comando (atalho: rodar-projeto). Ctrl+C encerra tudo.
#   ./local.sh              -> Postgres local (dados guardados) + API :3000 + painel :5173, Syonet desligado
#   ./local.sh vps          -> só o painel :5173, usando a API/banco da VPS (dados reais)
#   ./local.sh test         -> fluxo ponta a ponta com Syonet simulado (banco temporário)
#   ./local.sh reset-db     -> apaga o banco local (volume synclead_local_pgdata)
#   ./local.sh instalar-atalho -> cria o alias "rodar-projeto" no ~/.bashrc
# Portas: API_PORT (3000), WEB_PORT (5173), PG_PORT (55432).
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
API_PORT="${API_PORT:-3000}"
WEB_PORT="${WEB_PORT:-5173}"
PG_PORT="${PG_PORT:-55432}"
PG_CONTAINER=synclead-local-pg
PG_VOLUME=synclead_local_pgdata
PG_IMAGE=postgres:17-alpine
LOCAL_DB_URL="postgres://postgres:t@127.0.0.1:${PG_PORT}/synclead"
# Senhas só do ambiente local (banco local, sem dados reais).
LOCAL_ADMIN_PASSWORD=admin-local-123
LOCAL_GESTOR_PASSWORD=gestor-local-123

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
need_free_port() {
  if port_busy "$1"; then
    echo "Porta $1 ocupada ($2). Feche o processo (ex.: outro 'npm run dev') ou use $3=<porta>." >&2
    exit 1
  fi
}
npm_install_if_needed() { [ -d "$1/node_modules" ] || (cd "$1" && npm install); }

wait_pg() { until docker exec "$PG_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done; sleep 1; }

start_local_pg() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$PG_CONTAINER" &&
    [ "$(docker inspect -f '{{(index (index .HostConfig.PortBindings "5432/tcp") 0).HostPort}}' "$PG_CONTAINER" 2>/dev/null)" != "$PG_PORT" ]; then
    docker rm -f "$PG_CONTAINER" >/dev/null # porta mudou; os dados ficam no volume
  fi
  if docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    :
  elif docker ps -a --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    docker start "$PG_CONTAINER" >/dev/null
  else
    need_free_port "$PG_PORT" Postgres PG_PORT
    docker run -d --name "$PG_CONTAINER" -e POSTGRES_PASSWORD=t -e POSTGRES_DB=synclead \
      -v "$PG_VOLUME":/var/lib/postgresql/data -p "127.0.0.1:${PG_PORT}:5432" "$PG_IMAGE" >/dev/null
  fi
  wait_pg
}

API_ENV=(DATABASE_URL="$LOCAL_DB_URL" META_APP_SECRET=local-fake-secret META_WEBHOOK_VERIFY_TOKEN=local-verify
  META_ALLOWED_PAGE_IDS=372411372613737 META_PAGE_ACCESS_TOKEN= SYONET_SEND_ENABLED=false
  HOST=127.0.0.1 PORT="$API_PORT")
api_env() { env "${API_ENV[@]}" "$@"; }

ensure_local_users() {
  cd "$ROOT/api"
  local psql=(docker exec "$PG_CONTAINER" psql -U postgres -d synclead -tAc)
  if [ -n "$("${psql[@]}" "SELECT to_regclass('app_users')")" ]; then
    [ "$("${psql[@]}" "SELECT count(*) FROM app_users")" = "0" ] || return 0
  fi
  echo "Criando usuários locais (primeira execução)..."
  api_env npx tsx src/manage-users.ts add admin@local admin "Admin Local" --user admin >/dev/null
  api_env npx tsx src/manage-users.ts add gestor@local gestor "Gestor Local" --user gestor >/dev/null
  printf %s "$LOCAL_ADMIN_PASSWORD" | api_env npx tsx src/manage-users.ts set-password admin >/dev/null
  printf %s "$LOCAL_GESTOR_PASSWORD" | api_env npx tsx src/manage-users.ts set-password gestor >/dev/null
}

PIDS=()
kill_tree() {
  local child
  for child in $(ps -o pid= --ppid "$1" 2>/dev/null); do kill_tree "$child"; done
  kill "$1" 2>/dev/null || true
}
cleanup() {
  for pid in "${PIDS[@]}"; do kill_tree "$pid"; done
  wait 2>/dev/null || true
  [ "${STOP_PG:-}" = 1 ] && docker stop "$PG_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

start_web() {
  npm_install_if_needed "$ROOT/web"
  (cd "$ROOT/web" && SYNCLEAD_API_URL="$1" exec npm run dev -- --host 127.0.0.1 --port "$WEB_PORT" --strictPort) &
  PIDS+=($!)
}

case "${1:-dev}" in
  dev)
    need_free_port "$API_PORT" API API_PORT
    need_free_port "$WEB_PORT" painel WEB_PORT
    npm_install_if_needed "$ROOT/api"
    STOP_PG=1
    start_local_pg
    ensure_local_users
    start_web "http://127.0.0.1:${API_PORT}"
    (cd "$ROOT/api" && exec env "${API_ENV[@]}" npx tsx watch src/server.ts) &
    PIDS+=($!)
    cat <<MSG

  Painel: http://localhost:${WEB_PORT}   (admin / ${LOCAL_ADMIN_PASSWORD}  ou  gestor / ${LOCAL_GESTOR_PASSWORD})
  API:    http://localhost:${API_PORT}/health
  Banco:  docker exec -it ${PG_CONTAINER} psql -U postgres -d synclead
  Ctrl+C encerra tudo (os dados do banco local ficam guardados).

MSG
    wait -n
    ;;
  vps)
    need_free_port "$WEB_PORT" painel WEB_PORT
    start_web "https://cacl-leads-200-141-21-218.sslip.io"
    echo -e "\n  Painel: http://localhost:${WEB_PORT}  -> API e dados REAIS da VPS (use seu login da VPS). Ctrl+C encerra.\n"
    wait -n
    ;;
  test)
    npm_install_if_needed "$ROOT/api"
    docker rm -f synclead-e2e-local-pg >/dev/null 2>&1 || true
    docker run -d --rm --name synclead-e2e-local-pg -e POSTGRES_PASSWORD=t -e POSTGRES_DB=synclead_test \
      -p 127.0.0.1:55434:5432 "$PG_IMAGE" >/dev/null
    trap 'docker stop synclead-e2e-local-pg >/dev/null 2>&1 || true' EXIT
    until docker exec synclead-e2e-local-pg pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done; sleep 2
    cd "$ROOT/api"
    TEST_DATABASE_URL=postgres://postgres:t@127.0.0.1:55434/synclead_test npx tsx src/test-support/e2e-local.ts
    ;;
  reset-db)
    docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
    docker volume rm "$PG_VOLUME" >/dev/null 2>&1 || true
    echo "Banco local apagado. Na próxima execução ele é recriado com os usuários locais."
    ;;
  instalar-atalho)
    line="alias rodar-projeto='\"$ROOT/local.sh\"'"
    if grep -qF "alias rodar-projeto=" ~/.bashrc 2>/dev/null; then
      echo "Atalho já existe no ~/.bashrc."
    else
      printf '\n# SyncLead: sobe banco + API + painel local\n%s\n' "$line" >> ~/.bashrc
      echo "Atalho criado. Abra um novo terminal (ou rode: source ~/.bashrc) e digite: rodar-projeto"
    fi
    ;;
  *) sed -n '2,9p' "$0"; exit 1 ;;
esac
