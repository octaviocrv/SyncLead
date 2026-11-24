# SyncLead

Plataforma que recebe os leads dos formulários Meta Lead Ads (Facebook e
Instagram), grava cada lead no PostgreSQL, busca os dados completos na Graph API,
normaliza os campos, define a loja de destino e mostra tudo em um painel para o
gestor de tráfego acompanhar as campanhas.

O envio ao CRM Syonet foi homologado para a VW Lavras e é controlado por
`SYONET_SEND_ENABLED` no `.env` (desligado se a variável não existir). Em produção está
**ligado desde 24/11/2026** para validação com leads reais.

## Como funciona

```text
Meta Lead Ads ──webhook──▶ API (valida assinatura, grava e responde)
                              │
                              ▼
                        PostgreSQL ◀── worker: Graph API → normalização → loja/companyId
                              │                      └─▶ Syonet (se ligado)
                              ▼
                     Painel web (login, leads, métricas, saúde)
```

- **Webhook** (`POST /api/webhooks/meta`): valida `X-Hub-Signature-256`, grava o
  lead antes de responder e ignora duplicatas pelo `leadgen_id`.
- **Worker**: busca o lead na Graph API, valida nome, e-mail, telefone, loja e
  plataforma e só aceita o formulário autorizado (`META_FORM_ID`).
- **Conferência com a Meta** (a cada 15 min): compara a lista do formulário na
  Meta com o banco. Leads perdidos pelo webhook são recuperados e ficam em
  **revisão manual**: só vão ao Syonet depois que um admin autoriza o envio.
- **Alertas** na aba Saúde, e opcionalmente no Telegram: lead ausente, erro ou
  fila parada, formulário não autorizado, problema no token da Meta.
- **Retenção (LGPD)**: dados pessoais são apagados 30 dias após o envio ao
  Syonet ou 90 dias sem envio. O lead sem dados pessoais fica 24 meses, os logs
  de acesso 12 meses e os backups 14 dias.

## Estrutura

| Pasta/arquivo | Conteúdo |
|---|---|
| `api/` | API Node.js + TypeScript: webhook, worker, autenticação, painel, conferência e alertas |
| `web/` | Painel React + TypeScript + Vite |
| `compose.yaml`, `Caddyfile` | Produção: PostgreSQL, API e Caddy (HTTPS automático) |
| `deploy/` | Instalação na VPS, backup e configuração do token da Meta ([deploy/README.md](deploy/README.md)) |
| `local.sh` | Sobe o ambiente local com um comando |
| `_pausado-syonet/` | Homologação do Syonet, pausada (fora do build) |

## Painel

Login por e-mail ou usuário, com bloqueio após 5 senhas erradas em 15 min.
Sessões ficam em cookie `HttpOnly` e são guardadas no banco só como hash.

| Perfil | Acesso |
|---|---|
| `gestor` | Nome abreviado e telefone/e-mail mascarados (máscara aplicada no servidor); detalhe sem dados pessoais |
| `admin` | Dados completos; cada consulta a dados pessoais é registrada em `data_access_log` |

Telas: Visão Geral, Leads, Pendências, Métricas e Saúde. Para o admin, também
Regras de Roteamento, Lojas e Integrações. Leads de teste (sem `ad_id`) aparecem
com o selo "Teste" e ficam fora dos indicadores.

**Resultado e revisão de cada lead.** O detalhe abre com um resumo em português
("Enviado ao Syonet. Evento N", "Resultado incerto", "Em revisão manual"); a resposta
técnica do Syonet fica recolhida. Em **Pendências**, filtros por tipo: resultado
incerto, recusados/erro, em revisão e nova tentativa. Ações (somente `admin`, todas
registradas em `lead_reviews` com usuário e data):

| Situação | Ação do admin |
|---|---|
| Resultado incerto (`ambiguous`) | Conferir no CRM e registrar o número do evento, autorizar novo envio (com confirmação) ou manter pendente |
| Em revisão (recuperado ou `send_hold`) | Autorizar o envio |
| Enviado | Registrar se o cliente no Syonet é novo, existente ou não identificado (conferência manual; a API não informa) |

O selo **Recorrente (n)** indica que o mesmo telefone/e-mail já enviou leads antes,
calculado só com os dados retidos no PostgreSQL. Não indica cliente no Syonet.

## Rodar localmente (`rodar-projeto`)

Requer Docker e Node.js 18.18+.

```bash
cd plataforma                # instalar o atalho exige estar nesta pasta (onde está local.sh)
./local.sh instalar-atalho   # uma vez: cria o alias rodar-projeto no ~/.bashrc
```

Depois de instalado, o alias funciona **de qualquer pasta** (o caminho fica fixo
no `~/.bashrc`). Se aparecer `comando não encontrado`, é porque o terminal atual
ainda não leu o `~/.bashrc` com o alias novo — abra um terminal novo ou rode
`source ~/.bashrc` no terminal atual.

```bash
rodar-projeto                 # de qualquer pasta, depois de instalado o atalho
```

Sem o atalho instalado, rode direto de dentro de `plataforma/`:

```bash
cd plataforma
./local.sh
```

| Comando | O que faz |
|---|---|
| `rodar-projeto` | Postgres local (dados guardados) + API em `http://localhost:3000` + painel em `http://localhost:5173` usando a API local |
| `rodar-projeto vps` | Só o painel em `:5173`, usando a API e os dados da VPS |
| `rodar-projeto test` | Fluxo ponta a ponta com Syonet simulado, em banco temporário |
| `rodar-projeto reset-db` | Apaga o banco local |

- Usuários locais, criados na primeira execução: `adm` / `adm` e
  `gestor` / `gestor-local-123`. Existem só no banco local.
- Instala as dependências se faltarem. A API recarrega ao salvar um arquivo.
  O Syonet fica desligado e não há token da Meta (os leads ficam em
  `waiting_config`).
- **Ctrl+C** encerra tudo e mantém os dados do banco local.
- Portas ocupadas: `API_PORT=3100 WEB_PORT=5180 PG_PORT=55440 rodar-projeto`.
- Banco local: `docker exec -it synclead-local-pg psql -U postgres -d synclead`.

### Sem o script

```bash
cd api && npm install && cp .env.example .env   # preencher DATABASE_URL e variáveis Meta
npm run dev                                      # cria as tabelas ao iniciar

cd web && npm install && cp .env.example .env.local
npm run dev                                      # /api é encaminhado para SYNCLEAD_API_URL
```

## Testes

```bash
cd api
npm test                 # testes unitários e HTTP (sem credenciais)
npm run build
TEST_DATABASE_URL=postgres://usuario:senha@localhost:5432/synclead_test npm run test:integration
```

Os testes de integração criam um schema temporário e só rodam se o nome do banco
contiver `test`. Nunca use a URL de produção.

## Produção

`compose.yaml` sobe PostgreSQL, API e Caddy em rede e volumes isolados. O Caddy
expõe só `/health`, `/api/webhooks/meta`, `/api/auth/*` e `/api/dashboard/*`
e serve o painel estático. Instalação, variáveis, backup e gestão de usuários
estão em [deploy/README.md](deploy/README.md).

Fluxo de deploy: `deploy/backup.sh` → copiar os arquivos → `docker compose build api && docker compose up -d api`.

## Endpoints

| Método e rota | Uso |
|---|---|
| `GET /health` | Estado do banco, do processamento Meta e do envio Syonet |
| `GET /api/webhooks/meta` | Verificação do webhook pela Meta |
| `POST /api/webhooks/meta` | Recebe o evento `leadgen` |
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` | Sessão do painel |
| `GET /api/dashboard/leads`, `/leads/:id`, `/stats`, `/health` | Dados do painel (exigem sessão) |
| `POST /api/dashboard/leads/:id/resolve`, `/authorize-send`, `/customer-check` | Revisão manual: só `admin`, JSON, cabeçalho `x-synclead-csrf: 1`; a linha do lead é travada na transação |

## Envio ao Syonet

Endpoint documentado: `POST <instância>/api/lead` com `SYONET_AUTH_MODE=basic`
(`apikey` segue disponível). Detalhes e evidências da homologação:
`Documentação/10-homologacao-syonet.md`.
Tratamento das respostas:

- 200 com `ok=1` → `sent`;
- 401 e 403 (tipo de evento sem permissão de Web Service) → `blocked`;
- 412 → `failed`;
- 429 → uma nova tentativa automática;
- 5xx, timeout ou resposta sem confirmação → `ambiguous`, sem reenvio automático (o admin resolve em Pendências).

Leads sem `platform` (orgânicos ou de teste) nunca são enviados, exceto os da allowlist de homologação (`SYONET_SEND_ONLY_LEADGEN_IDS`, com `SYONET_REQUIRE_ALLOWLIST`). Leads recuperados pela conferência ou com `send_hold` só saem após autorização do admin. O servidor
Syonet simulado fica em `api/src/test-support/syonet-mock.ts`.

## Segurança

- Nunca versione `.env`, tokens ou senhas. Só os arquivos `*.example` vão para o repositório.
- O `.env` real existe apenas na VPS (`chmod 600`).
- Os backups contêm dados pessoais e ficam fora do repositório.
