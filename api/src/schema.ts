export const schema = `
CREATE TABLE IF NOT EXISTS leads (
  leadgen_id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  ad_id TEXT,
  adgroup_id TEXT,
  created_time BIGINT,
  status TEXT NOT NULL CHECK (
    status IN ('received', 'waiting_config', 'processing', 'retry', 'sent', 'blocked', 'failed', 'ambiguous')
  ),
  attempts INTEGER NOT NULL DEFAULT 0,
  selected_store_answer TEXT,
  syonet_company_id INTEGER,
  syonet_event_id TEXT,
  last_error TEXT,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS meta_processed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS leads_work_queue_idx
  ON leads (available_at, received_at)
  WHERE status IN ('received', 'waiting_config', 'retry');

CREATE TABLE IF NOT EXISTS processing_attempts (
  id BIGSERIAL PRIMARY KEY,
  leadgen_id TEXT NOT NULL REFERENCES leads(leadgen_id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS processing_attempts_lead_idx
  ON processing_attempts (leadgen_id, created_at);

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS meta_platform TEXT,
  ADD COLUMN IF NOT EXISTS meta_is_organic BOOLEAN;

-- Unica copia dos dados pessoais: a resposta field_data da Meta. Normalizacao e
-- preview do Syonet sao derivados sob demanda para nao duplicar PII.
CREATE TABLE IF NOT EXISTS lead_personal_data (
  leadgen_id TEXT PRIMARY KEY REFERENCES leads(leadgen_id) ON DELETE CASCADE,
  field_data JSONB NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Evidência da homologação/envio: corpo enviado e resposta do Syonet (mesma retenção da PII).
ALTER TABLE lead_personal_data
  ADD COLUMN IF NOT EXISTS syonet_request JSONB,
  ADD COLUMN IF NOT EXISTS syonet_response JSONB,
  ADD COLUMN IF NOT EXISTS syonet_exchanged_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS data_access_log (
  id BIGSERIAL PRIMARY KEY,
  leadgen_id TEXT NOT NULL,
  action TEXT NOT NULL,
  remote_addr TEXT,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS data_access_log_accessed_idx
  ON data_access_log (accessed_at);

CREATE TABLE IF NOT EXISTS app_users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'gestor')),
  password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

-- Só o hash SHA-256 do token da sessão é guardado.
CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  remote_addr TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions (user_id);

CREATE TABLE IF NOT EXISTS auth_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT,
  email TEXT,
  event TEXT NOT NULL,
  remote_addr TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auth_log_created_idx ON auth_log (created_at);

ALTER TABLE data_access_log
  ADD COLUMN IF NOT EXISTS user_id BIGINT;

-- Login alternativo por nome de usuário (opcional, minúsculo, sem '@').
ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS username TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS app_users_username_idx ON app_users (username) WHERE username IS NOT NULL;

-- Origem do lead: 'webhook' (fluxo validado) ou 'reconciliation' (recuperado da lista da Meta;
-- nunca é enviado ao Syonet). Nomes de campanha/conjunto/anúncio só vêm com a permissão ads_read.
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'webhook',
  ADD COLUMN IF NOT EXISTS campaign_id TEXT,
  ADD COLUMN IF NOT EXISTS campaign_name TEXT,
  ADD COLUMN IF NOT EXISTS adset_name TEXT,
  ADD COLUMN IF NOT EXISTS ad_name TEXT;

-- Índice dos leads que a Meta registrou no formulário (sem PII), para taxa de entrega e reconciliação.
CREATE TABLE IF NOT EXISTS meta_leads (
  leadgen_id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  meta_created_at TIMESTAMPTZ NOT NULL,
  platform TEXT,
  is_organic BOOLEAN,
  ad_id TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS meta_leads_created_idx ON meta_leads (meta_created_at);

-- Alertas sem PII. Um alerta aberto por dedupe_key; notificação só ao abrir, ao piorar e ao resolver.
CREATE TABLE IF NOT EXISTS alerts (
  id BIGSERIAL PRIMARY KEY,
  dedupe_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 1,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notified_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_key_idx ON alerts (dedupe_key) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS alerts_opened_idx ON alerts (opened_at);

CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
