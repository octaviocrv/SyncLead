import type { Pool } from 'pg';
import type { SessionUser, UserRole } from './auth.js';
import {
  defaultRetentionPolicy,
  diagnoseLead,
  maskedContact,
  purgeAfterSql,
  type MetaFieldData,
  type RetentionPolicy,
  type SyonetPreviewOptions,
} from './personal-data.js';

export interface DashboardAttempt {
  stage: string;
  status: string;
  message: string;
  createdAt: string;
}

export interface DashboardLead {
  leadgenId: string;
  pageId: string;
  formId: string;
  adId: string | null;
  status: string;
  selectedStoreAnswer: string | null;
  syonetCompanyId: number | null;
  syonetEventId: string | null;
  lastError: string | null;
  attempts: number;
  metaCreatedAt: string | null;
  receivedAt: string;
  updatedAt: string;
  metaProcessedAt: string | null;
  metaPlatform: string | null;
  metaIsOrganic: boolean | null;
  // Webhook sem ad_id = ferramenta de teste da Meta ou orgânico. Recuperados pela reconciliação não
  // trazem ad_id (sem ads_read): usam plataforma/orgânico da Meta. Testes ficam fora das métricas.
  isTest: boolean;
  source: 'webhook' | 'reconciliation';
  campaignName: string | null;
  adsetName: string | null;
  adName: string | null;
  personalDataCapturedAt: string | null;
  personalDataPurgeAfter: string | null;
  history: DashboardAttempt[];
}

// Listagem: nome completo, telefone e e-mail sempre mascarados.
export interface DashboardLeadSummary extends DashboardLead {
  contact: { name: string | null; phoneMasked: string | null; emailMasked: string | null };
}

type LeadRow = DashboardLead & { fieldData: MetaFieldData | null };

const maxLeads = 500;

const isTestSql = `CASE WHEN l.source = 'reconciliation'
                 THEN (l.meta_processed_at IS NOT NULL OR l.meta_platform IS NOT NULL)
                      AND (l.meta_platform IS NULL OR COALESCE(l.meta_is_organic, FALSE))
                 ELSE l.ad_id IS NULL END`;

function leadQuery(policy: RetentionPolicy, where: string): string {
  return `SELECT l.leadgen_id AS "leadgenId",
            l.page_id AS "pageId",
            l.form_id AS "formId",
            l.ad_id AS "adId",
            l.status,
            l.selected_store_answer AS "selectedStoreAnswer",
            l.syonet_company_id AS "syonetCompanyId",
            l.syonet_event_id AS "syonetEventId",
            l.last_error AS "lastError",
            l.attempts,
            CASE WHEN l.created_time IS NULL THEN NULL
                 ELSE to_char(to_timestamp(l.created_time) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END AS "metaCreatedAt",
            l.received_at AS "receivedAt",
            l.updated_at AS "updatedAt",
            l.meta_processed_at AS "metaProcessedAt",
            l.meta_platform AS "metaPlatform",
            l.meta_is_organic AS "metaIsOrganic",
            ${isTestSql} AS "isTest",
            l.source,
            l.campaign_name AS "campaignName",
            l.adset_name AS "adsetName",
            l.ad_name AS "adName",
            p.field_data AS "fieldData",
            p.captured_at AS "personalDataCapturedAt",
            CASE WHEN p.leadgen_id IS NULL THEN NULL ELSE ${purgeAfterSql(policy)} END AS "personalDataPurgeAfter",
            COALESCE(
              (SELECT json_agg(json_build_object(
                        'stage', a.stage, 'status', a.status,
                        'message', a.message, 'createdAt', a.created_at
                      ) ORDER BY a.id)
               FROM processing_attempts a
               WHERE a.leadgen_id = l.leadgen_id),
              '[]'::json
            ) AS history
     FROM leads l
     LEFT JOIN lead_personal_data p ON p.leadgen_id = l.leadgen_id
     ${where}`;
}

// Máscara aplicada no servidor: o gestor nunca recebe o nome completo.
export function maskName(name: string | null): string | null {
  if (!name) return null;
  const [first, ...others] = name.trim().split(/\s+/);
  const last = others.at(-1);
  return last ? `${first} ${last[0].toUpperCase()}.` : first;
}

function contactFor(role: UserRole, fieldData: MetaFieldData | null) {
  const contact = maskedContact(fieldData);
  return role === 'admin' ? contact : { ...contact, name: maskName(contact.name) };
}

export async function listDashboardLeads(
  pool: Pool,
  role: UserRole,
  policy: RetentionPolicy = defaultRetentionPolicy,
): Promise<DashboardLeadSummary[]> {
  const result = await pool.query<LeadRow>(
    leadQuery(policy, 'ORDER BY l.received_at DESC LIMIT $1'),
    [maxLeads],
  );
  return result.rows.map(({ fieldData, ...lead }) => ({ ...lead, contact: contactFor(role, fieldData) }));
}

// Detalhe: dados completos para diagnóstico/homologação; todo acesso é registrado.
export async function getDashboardLeadDetail(
  pool: Pool,
  leadgenId: string,
  access: { remoteAddr: string | null; user: SessionUser },
  options: SyonetPreviewOptions,
  policy: RetentionPolicy = defaultRetentionPolicy,
) {
  const result = await pool.query<LeadRow>(leadQuery(policy, 'WHERE l.leadgen_id = $1'), [leadgenId]);
  const row = result.rows[0];
  if (!row) return undefined;

  const { fieldData, ...lead } = row;
  const isAdmin = access.user.role === 'admin';
  if (fieldData && isAdmin) {
    await pool.query(
      `INSERT INTO data_access_log (leadgen_id, action, remote_addr, user_id) VALUES ($1, 'view_detail', $2, $3)`,
      [leadgenId, access.remoteAddr, access.user.id],
    );
  }

  return {
    lead: { ...lead, contact: contactFor(access.user.role, fieldData) },
    // Gestor: só sabe que os dados existem; field_data, normalização e preview ficam com o admin.
    personalDataRestricted: Boolean(fieldData) && !isAdmin,
    personalData: fieldData && isAdmin
      ? {
          fieldData,
          capturedAt: lead.personalDataCapturedAt,
          purgeAfter: lead.personalDataPurgeAfter,
          ...diagnoseLead(
            leadgenId,
            { fieldData, platform: lead.metaPlatform, isOrganic: lead.metaIsOrganic, adId: lead.adId },
            options,
          ),
        }
      : null,
  };
}

export interface DashboardStats {
  from: string;
  to: string;
  total: number;
  testsExcluded: number;
  daily: Array<{ date: string; count: number }>;
  byStore: Array<{ answer: string | null; companyId: number | null; count: number }>;
  byPlatform: Array<{ platform: string | null; count: number }>;
  byAd: Array<{ adId: string | null; adName: string | null; adsetName: string | null; campaignName: string | null; count: number }>;
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const maxRangeDays = 400;

function saoPauloToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

// Período em datas de São Paulo (inclusivas). Padrão: últimos 30 dias.
export function parseStatsRange(fromParam: string | null, toParam: string | null): { from: string; to: string } | undefined {
  const to = toParam ?? saoPauloToday();
  const from = fromParam ?? shiftDate(to, -29);
  if (!isoDate.test(from) || !isoDate.test(to) || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return undefined;
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (days < 0 || days > maxRangeDays) return undefined;
  return { from, to };
}

// Agregado sem PII; leads de teste ficam fora de todas as contagens. Data = criação na Meta (fuso SP).
export async function getDashboardStats(pool: Pool, range: { from: string; to: string }): Promise<DashboardStats> {
  const base = `WITH period AS (
      SELECT l.*, (COALESCE(to_timestamp(l.created_time), l.received_at) AT TIME ZONE 'America/Sao_Paulo') AS local_at,
             ${isTestSql} AS is_test
      FROM leads l
    ), real AS (
      SELECT * FROM period WHERE local_at >= $1::date AND local_at < $2::date + 1
    )`;
  const params = [range.from, range.to];
  const [totals, daily, byStore, byPlatform, byAd] = await Promise.all([
    pool.query<{ total: number; tests: number }>(
      `${base} SELECT COUNT(*) FILTER (WHERE NOT is_test)::int AS total, COUNT(*) FILTER (WHERE is_test)::int AS tests FROM real`, params),
    pool.query<{ date: string; count: number }>(
      `${base} SELECT to_char(d, 'YYYY-MM-DD') AS date, COUNT(r.leadgen_id)::int AS count
               FROM generate_series($1::date, $2::date, interval '1 day') d
               LEFT JOIN real r ON r.local_at::date = d::date AND NOT r.is_test
               GROUP BY d ORDER BY d`, params),
    pool.query<{ answer: string | null; companyId: number | null; count: number }>(
      `${base} SELECT selected_store_answer AS answer, syonet_company_id AS "companyId", COUNT(*)::int AS count
               FROM real WHERE NOT is_test GROUP BY 1, 2 ORDER BY count DESC`, params),
    pool.query<{ platform: string | null; count: number }>(
      `${base} SELECT meta_platform AS platform, COUNT(*)::int AS count
               FROM real WHERE NOT is_test GROUP BY 1 ORDER BY count DESC`, params),
    pool.query<{ adId: string | null; adName: string | null; adsetName: string | null; campaignName: string | null; count: number }>(
      `${base} SELECT ad_id AS "adId", MAX(ad_name) AS "adName", MAX(adset_name) AS "adsetName",
                      MAX(campaign_name) AS "campaignName", COUNT(*)::int AS count
               FROM real WHERE NOT is_test GROUP BY ad_id ORDER BY count DESC LIMIT 20`, params),
  ]);
  return {
    ...range,
    total: totals.rows[0]?.total ?? 0,
    testsExcluded: totals.rows[0]?.tests ?? 0,
    daily: daily.rows,
    byStore: byStore.rows,
    byPlatform: byPlatform.rows,
    byAd: byAd.rows,
  };
}
