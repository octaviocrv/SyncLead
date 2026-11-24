# Instalação na VPS Hostinger (Docker + Caddy)

Projeto isolado em `/opt/cacl-leads`. Não compartilha containers, rede nem
volumes com outros projetos da VPS.

## Containers

| Container | Imagem | Portas publicadas |
|---|---|---|
| `cacl_leads_postgres` | postgres:17-alpine | nenhuma |
| `cacl_leads_api` | build local (`api/Dockerfile`) | nenhuma (porta interna 3000) |
| `cacl_leads_caddy` | caddy:2-alpine | 80 e 443 |

Rede: `cacl_leads_net`. Volumes: `cacl_leads_pgdata`, `cacl_leads_caddy_data`,
`cacl_leads_caddy_config`. O Caddy encaminha à API só `/health`,
`/api/webhooks/meta`, `/api/auth/*` e `/api/dashboard/*` (outras rotas `/api`
retornam 404) e serve o painel estático de `web-dist/` em HTTPS, com HSTS e CSP.

Painel: login por e-mail e senha (hash scrypt), sessão em cookie `HttpOnly`,
`Secure`, `SameSite=Strict` (12 h; expira após 2 h sem uso), bloqueio de 15 min
após 5 senhas erradas. Logins, falhas e logouts ficam em `auth_log`. Perfis:

- `gestor`: lista e detalhe com nome abreviado e telefone/e-mail mascarados
  (máscara aplicada no servidor); não vê `field_data` nem o payload do Syonet;
- `admin`: o detalhe traz `field_data`, normalização, loja/companyId e preview do
  Syonet; cada acesso a PII fica em `data_access_log` com o usuário.

Usuários entram com e-mail **ou** nome de usuário (`<login>` abaixo). Senha gerada
é exibida uma única vez; senha escolhida exige no mínimo 10 caracteres:
`docker compose exec api node dist/manage-users.js add <email> <admin|gestor> <nome> [--user <usuario>]`,
`set-username <login> <usuario>`, `reset-password <login>` (gera),
`printf '%s' 'nova senha' | docker compose exec -T api node dist/manage-users.js set-password <login>`,
`disable <login>`, `enable <login>`, `list`.

Leads sem `ad_id` (ferramenta de teste da Meta ou orgânicos) aparecem com o selo
"Teste" e ficam fora das métricas.

Publicar uma nova versão do painel: `cd web && npm run build` e copiar `web/dist/`
para `/opt/cacl-leads/web-dist/` (manter a pasta; trocar só o conteúdo).

Dados pessoais (LGPD): a única cópia é `lead_personal_data.field_data` (mais o
corpo/resposta do Syonet, quando houver envio). O expurgo roda a cada hora:
30 dias após envio ao Syonet (`PII_RETENTION_SENT_DAYS`), 90 dias para leads não
enviados (`PII_RETENTION_UNSENT_DAYS`) e 24 meses para o lead sem PII
(`OPERATIONAL_RETENTION_MONTHS`); logs de acesso e de login ficam 12 meses. `deploy/backup.sh` roda diariamente
via cron e mantém 14 dias de backups (incluindo os manuais `pre-*`).

Leads processados antes da captura podem ser preenchidos uma vez, somente com
leitura na Graph API: `docker compose exec api node dist/backfill-personal-data.js <leadgen_id>`.

Conferência com a Meta: a cada `RECONCILIATION_INTERVAL_MINUTES` (15) a API lista os
leads do formulário na Graph API (só id, data, plataforma; sem dados pessoais) e
guarda em `meta_leads`. Leads criados depois de `RECONCILIATION_RECOVER_SINCE` e
ausentes há mais de `ALERT_MISSING_LEAD_MINUTES` são recuperados com
`source='reconciliation'` e **nunca** vão ao Syonet. Alertas (webhook perdeu lead,
erro ou fila parada, formulário não autorizado, token da Meta, falha da conferência)
ficam na aba Saúde e nos logs; com `ALERT_TELEGRAM_BOT_TOKEN` e
`ALERT_TELEGRAM_CHAT_ID` também vão ao Telegram (uma vez por abertura/aumento/resolução).

Homologação Syonet controlada: com `SYONET_SEND_ONLY_LEADGEN_IDS` preenchido, só
esses leads são enviados; os demais continuam em `waiting_config`.
`SYONET_HOMOLOGATION_MEDIA` (FACEBOOK/INSTAGRAM) só vale para leads liberados que
são orgânicos/teste sem plataforma.

O painel (`web/`) acessa a API pelo proxy do Vite: copie
`web/.env.example` para `web/.env.local` (só a URL da API; o login é feito no painel).

## Pré-requisitos

1. Subdomínio com registro DNS tipo A para o IP da VPS.
2. Portas 80 e 443 livres na VPS (necessárias para emitir o certificado).

## Passos

```bash
# Na máquina local: enviar a pasta plataforma (sem node_modules, dist e .env)
rsync -av --exclude node_modules --exclude dist --exclude .env --exclude web \
  plataforma/ usuario@IP_DA_VPS:/opt/cacl-leads/

# Na VPS
cd /opt/cacl-leads
cp .env.production.example .env
chmod 600 .env
nano .env            # preencher as variáveis; manter SYONET_SEND_ENABLED=false
docker compose config -q && docker compose up -d --build
docker compose ps
curl -s https://SEU_DOMINIO/health
```

## Operação

```bash
docker compose logs -f api           # logs da API
docker compose restart api           # reiniciar API
chmod +x deploy/backup.sh && ./deploy/backup.sh   # backup do banco
```

Agendar o backup diário: `0 3 * * * /opt/cacl-leads/deploy/backup.sh` no `crontab -e`.
Copie os backups para fora da VPS periodicamente.

## Variáveis a preencher

`API_DOMAIN`, `POSTGRES_PASSWORD`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`,
`META_PAGE_ACCESS_TOKEN`, `META_ALLOWED_PAGE_IDS`.
Confirme `META_FORM_ID`.
Nenhuma variável Syonet é necessária enquanto `SYONET_SEND_ENABLED=false`.
