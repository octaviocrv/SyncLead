import type { Pool } from 'pg';

// Reconciliação Meta × banco, alertas e resumo da aba Saúde. Nada aqui lê ou grava PII:
// a lista da Meta é pedida sem field_data e os alertas citam só leadgen_id/form_id/contagens.

export interface MonitoringConfiguration {
  accessToken: string;
  graphApiVersion: string;
  formId: string;
  pageId: string;
  // Leads da Meta criados antes disso (antes do webhook existir) ficam só no índice, sem recuperar PII.
  recoverSince: Date;
  missingAfterMinutes: number;
  notify?: (text: string) => Promise<void>;
  fetchImpl?: typeof fetch;
}

type AlertSeverity = 'critical' | 'warning';
interface AlertInput {
  kind: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  count: number;
}

interface MetaListedLead {
  id: string;
  created_time?: string;
  platform?: string;
  is_organic?: boolean;
  ad_id?: string;
  form_id?: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_name?: string;
  ad_name?: string;
}

const listFields = 'id,created_time,platform,is_organic,ad_id,form_id,campaign_id,campaign_name,adset_name,ad_name';
const maxPages = 50;
const tokenCheckIntervalMs = 24 * 60 * 60 * 1000;
const tokenExpiryWarningDays = 7;

class GraphError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

async function graphGet(config: MonitoringConfiguration, url: URL): Promise<Record<string, unknown>> {
  url.searchParams.set('access_token', config.accessToken);
  let response: Response;
  try {
    response = await (config.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new GraphError('Meta Graph API não respondeu.');
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown> & {
    error?: { message?: string; code?: number };
  };
  if (!response.ok) {
    // A mensagem da Meta não contém o token; ainda assim limitamos o tamanho.
    throw new GraphError(`Meta Graph API HTTP ${response.status}: ${String(body.error?.message ?? '').slice(0, 200)}`, body.error?.code);
  }
  return body;
}

async function readState<T>(pool: Pool, key: string): Promise<T | undefined> {
  const result = await pool.query<{ value: T }>(`SELECT value FROM system_state WHERE key = $1`, [key]);
  return result.rows[0]?.value;
}

async function writeState(pool: Pool, key: string, value: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO system_state (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
}

// Lista o formulário na Meta (incremental, com 2 h de sobreposição) e atualiza meta_leads.
export async function syncMetaLeads(pool: Pool, config: MonitoringConfiguration): Promise<{ listed: number; indexed: number }> {
  const previous = await readState<{ newestCreatedAt?: string }>(pool, 'meta_leads_sync');
  const since = previous?.newestCreatedAt ? Math.floor(Date.parse(previous.newestCreatedAt) / 1000) - 2 * 3600 : undefined;

  let url: URL | undefined = new URL(
    `https://graph.facebook.com/${config.graphApiVersion}/${encodeURIComponent(config.formId)}/leads`,
  );
  url.searchParams.set('fields', listFields);
  url.searchParams.set('limit', '100');
  if (since) {
    url.searchParams.set('filtering', JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: since }]));
  }

  let listed = 0;
  let indexed = 0;
  let newest = previous?.newestCreatedAt ? Date.parse(previous.newestCreatedAt) : 0;
  for (let page = 0; url && page < maxPages; page += 1) {
    const body = await graphGet(config, url);
    const data = Array.isArray(body.data) ? (body.data as MetaListedLead[]) : [];
    for (const lead of data) {
      const createdAt = lead.created_time ? Date.parse(lead.created_time) : NaN;
      if (!lead.id || !/^\d{1,32}$/.test(lead.id) || Number.isNaN(createdAt)) continue;
      listed += 1;
      newest = Math.max(newest, createdAt);
      const result = await pool.query(
        `INSERT INTO meta_leads (leadgen_id, form_id, meta_created_at, platform, is_organic, ad_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (leadgen_id) DO UPDATE SET last_seen_at = NOW(),
           platform = COALESCE(EXCLUDED.platform, meta_leads.platform),
           is_organic = COALESCE(EXCLUDED.is_organic, meta_leads.is_organic),
           ad_id = COALESCE(EXCLUDED.ad_id, meta_leads.ad_id)
         RETURNING (xmax = 0) AS inserted`,
        [lead.id, lead.form_id || config.formId, new Date(createdAt), lead.platform || null, lead.is_organic ?? null, lead.ad_id || null],
      );
      if (result.rows[0]?.inserted) indexed += 1;
      // Nomes só chegam quando o token tiver ads_read; sem cache, gravados no próprio lead.
      if (lead.campaign_name || lead.adset_name || lead.ad_name || lead.campaign_id) {
        await pool.query(
          `UPDATE leads SET campaign_id = COALESCE($2, campaign_id), campaign_name = COALESCE($3, campaign_name),
                            adset_name = COALESCE($4, adset_name), ad_name = COALESCE($5, ad_name)
           WHERE leadgen_id = $1`,
          [lead.id, lead.campaign_id || null, lead.campaign_name || null, lead.adset_name || null, lead.ad_name || null],
        );
      }
    }
    const next = (body.paging as { next?: string } | undefined)?.next;
    url = next ? new URL(next) : undefined;
  }

  await writeState(pool, 'meta_leads_sync', { newestCreatedAt: newest ? new Date(newest).toISOString() : null });
  return { listed, indexed };
}

// Leads que a Meta tem e nós não, criados após recoverSince e há mais de N minutos: entram como
// source='reconciliation' (o worker busca os dados, normaliza e roteia, mas nunca envia ao Syonet).
export async function recoverMissingLeads(pool: Pool, config: MonitoringConfiguration): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ leadgen_id: string }>(
      `INSERT INTO leads (leadgen_id, form_id, page_id, ad_id, created_time, status, source, send_hold)
       SELECT m.leadgen_id, m.form_id, $1, m.ad_id, EXTRACT(EPOCH FROM m.meta_created_at)::bigint, 'received', 'reconciliation', FALSE
       FROM meta_leads m
       WHERE m.meta_created_at >= $2
         AND m.meta_created_at < NOW() - make_interval(mins => $3)
         AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.leadgen_id = m.leadgen_id)
       ON CONFLICT (leadgen_id) DO NOTHING
       RETURNING leadgen_id`,
      [config.pageId, config.recoverSince, config.missingAfterMinutes],
    );
    for (const row of result.rows) {
      await client.query(
        `INSERT INTO processing_attempts (leadgen_id, stage, status, message) VALUES ($1, 'reconciliation', 'success', $2)`,
        [row.leadgen_id, 'Lead recovered from the Meta form list (webhook did not deliver it); processed automatically like a webhook lead.'],
      );
    }
    await client.query('COMMIT');
    return result.rows.map((row) => row.leadgen_id);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Mantém no máximo um alerta aberto por chave; notifica ao abrir, quando a contagem aumenta e ao resolver.
export async function syncAlert(
  pool: Pool,
  key: string,
  active: AlertInput | undefined,
  notify?: (text: string) => Promise<void>,
): Promise<'opened' | 'worsened' | 'updated' | 'resolved' | 'none'> {
  const open = (await pool.query<{ id: number; item_count: number; title: string }>(
    `SELECT id::int, item_count, title FROM alerts WHERE dedupe_key = $1 AND resolved_at IS NULL`,
    [key],
  )).rows[0];
  const send = async (text: string) => {
    console.warn(`[alerta] ${text}`);
    if (!notify) return false;
    try {
      await notify(text);
      return true;
    } catch (error) {
      console.error('Alert notification failed:', error instanceof Error ? error.message : 'unknown error');
      return false;
    }
  };

  if (active && !open) {
    const notified = await send(`${active.severity === 'critical' ? '🔴' : '🟡'} ${active.title}\n${active.message}`);
    await pool.query(
      `INSERT INTO alerts (dedupe_key, kind, severity, title, message, item_count, notified_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7 THEN NOW() END)`,
      [key, active.kind, active.severity, active.title, active.message, active.count, notified],
    );
    return 'opened';
  }
  if (active && open) {
    const worsened = active.count > open.item_count;
    const notified = worsened && (await send(`${active.severity === 'critical' ? '🔴' : '🟡'} ${active.title} (piorou)\n${active.message}`));
    await pool.query(
      `UPDATE alerts SET last_seen_at = NOW(), message = $2, item_count = $3, severity = $4, title = $5,
              notified_at = CASE WHEN $6 THEN NOW() ELSE notified_at END
       WHERE id = $1`,
      [open.id, active.message, active.count, active.severity, active.title, notified],
    );
    return worsened ? 'worsened' : 'updated';
  }
  if (!active && open) {
    await pool.query(`UPDATE alerts SET resolved_at = NOW() WHERE id = $1`, [open.id]);
    await send(`✅ Resolvido: ${open.title}`);
    return 'resolved';
  }
  return 'none';
}

const listIds = (ids: string[]) => ids.slice(0, 10).join(', ') + (ids.length > 10 ? ` e mais ${ids.length - 10}` : '');

// Avalia os alertas derivados do banco. `metaConfigured` evita alarmar fila quando a Meta está pausada.
export async function evaluateAlerts(pool: Pool, metaConfigured: boolean, notify?: (text: string) => Promise<void>) {
  const rows = (await pool.query<{ kind: string; ids: string[]; forms: string[] }>(
    `SELECT 'webhook_missed' AS kind, array_agg(leadgen_id ORDER BY received_at) AS ids, NULL::text[] AS forms
       FROM leads WHERE source = 'reconciliation' AND received_at > NOW() - INTERVAL '24 hours'
     UNION ALL
     SELECT 'processing_errors', array_agg(leadgen_id ORDER BY updated_at), NULL
       FROM leads WHERE status = 'failed'
          OR (status = 'blocked' AND COALESCE(last_error, '') NOT LIKE 'Form ID%')
     UNION ALL
     SELECT 'ambiguous_results', array_agg(leadgen_id ORDER BY updated_at), NULL
       FROM leads WHERE status = 'ambiguous'
     UNION ALL
     SELECT 'queue_stuck', array_agg(leadgen_id ORDER BY received_at), NULL
       FROM leads WHERE (status IN ('received', 'retry') AND available_at < NOW() - INTERVAL '10 minutes')
          OR (status = 'processing' AND locked_at < NOW() - INTERVAL '10 minutes')
          OR ($1 AND status = 'waiting_config' AND meta_processed_at IS NULL AND received_at < NOW() - INTERVAL '10 minutes')
     UNION ALL
     SELECT 'unauthorized_form', array_agg(leadgen_id ORDER BY received_at), array_agg(DISTINCT form_id)
       FROM leads WHERE status = 'blocked' AND last_error LIKE 'Form ID%' AND received_at > NOW() - INTERVAL '7 days'`,
    [metaConfigured],
  )).rows;
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  const ids = (kind: string) => byKind.get(kind)?.ids?.filter(Boolean) ?? [];

  const missed = ids('webhook_missed');
  const errors = ids('processing_errors');
  const ambiguous = ids('ambiguous_results');
  const stuck = ids('queue_stuck');
  const forms = ids('unauthorized_form');
  const results = {
    webhook_missed: await syncAlert(pool, 'webhook_missed', missed.length ? {
      kind: 'webhook_missed', severity: 'critical', count: missed.length,
      title: 'Webhook perdeu leads da Meta',
      message: `${missed.length} lead(s) nas últimas 24 h só chegaram pela reconciliação (o webhook não entregou; seguem o fluxo normal): ${listIds(missed)}. Verifique a assinatura do webhook no app da Meta.`,
    } : undefined, notify),
    processing_errors: await syncAlert(pool, 'processing_errors', errors.length ? {
      kind: 'processing_errors', severity: 'critical', count: errors.length,
      title: 'Leads recusados ou bloqueados',
      message: `${errors.length} lead(s) com erro ou bloqueio: ${listIds(errors)}. Abra Pendências para ver o motivo de cada um.`,
    } : undefined, notify),
    ambiguous_results: await syncAlert(pool, 'ambiguous_results', ambiguous.length ? {
      kind: 'ambiguous_results', severity: 'critical', count: ambiguous.length,
      title: 'Resultado incerto no Syonet',
      message: `${ambiguous.length} lead(s) sem confirmação do Syonet: ${listIds(ambiguous)}. O evento pode ou não ter sido criado: confira no CRM e registre o resultado em Pendências (não reenvie sem conferir).`,
    } : undefined, notify),
    queue_stuck: await syncAlert(pool, 'queue_stuck', stuck.length ? {
      kind: 'queue_stuck', severity: 'critical', count: stuck.length,
      title: 'Fila de processamento parada',
      message: `${stuck.length} lead(s) parados há mais de 10 min sem processar: ${listIds(stuck)}.`,
    } : undefined, notify),
    unauthorized_form: await syncAlert(pool, 'unauthorized_form', forms.length ? {
      kind: 'unauthorized_form', severity: 'warning', count: forms.length,
      title: 'Lead de formulário não autorizado',
      message: `${forms.length} lead(s) nos últimos 7 dias vieram de formulário(s) não configurado(s) (${(byKind.get('unauthorized_form')?.forms ?? []).join(', ')}) e foram bloqueados.`,
    } : undefined, notify),
  };
  return results;
}

export interface TokenStatus {
  checkedAt: string;
  ok: boolean;
  type?: string;
  expiresAt?: string | null;
  missingScopes?: string[];
  error?: string;
}

export async function checkMetaToken(pool: Pool, config: MonitoringConfiguration, force = false): Promise<TokenStatus | undefined> {
  const previous = await readState<TokenStatus>(pool, 'meta_token');
  if (!force && previous && Date.now() - Date.parse(previous.checkedAt) < tokenCheckIntervalMs) return undefined;

  let status: TokenStatus;
  try {
    const url = new URL(`https://graph.facebook.com/${config.graphApiVersion}/debug_token`);
    url.searchParams.set('input_token', config.accessToken);
    const data = ((await graphGet(config, url)).data ?? {}) as {
      is_valid?: boolean; type?: string; expires_at?: number; data_access_expires_at?: number; scopes?: string[];
    };
    const expiries = [data.expires_at, data.data_access_expires_at].filter((value): value is number => Boolean(value));
    const soonest = expiries.length ? Math.min(...expiries) * 1000 : undefined;
    const missingScopes = ['leads_retrieval'].filter((scope) => !data.scopes?.includes(scope));
    const expiringSoon = soonest !== undefined && soonest - Date.now() < tokenExpiryWarningDays * 86_400_000;
    status = {
      checkedAt: new Date().toISOString(),
      ok: Boolean(data.is_valid) && !expiringSoon && missingScopes.length === 0,
      type: data.type,
      expiresAt: soonest ? new Date(soonest).toISOString() : null,
      missingScopes,
      error: !data.is_valid ? 'Token inválido.' : expiringSoon ? 'Token expira em menos de 7 dias.' : missingScopes.length ? `Falta permissão: ${missingScopes.join(', ')}.` : undefined,
    };
  } catch (error) {
    status = { checkedAt: new Date().toISOString(), ok: false, error: error instanceof Error ? error.message : 'Falha ao verificar o token.' };
  }
  await writeState(pool, 'meta_token', status);
  await syncAlert(pool, 'meta_token', status.ok ? undefined : {
    kind: 'meta_token', severity: 'critical', count: 1,
    title: 'Token da Meta com problema',
    message: `${status.error ?? 'Verificação falhou.'} Sem token válido os leads não são buscados na Meta.`,
  }, config.notify);
  return status;
}

export interface ReconciliationStatus {
  at: string;
  ok: boolean;
  listed?: number;
  indexed?: number;
  recovered?: string[];
  error?: string;
}

// Um ciclo completo (a cada 15 min): lista Meta → recupera faltantes → token diário → alertas.
export async function runMonitoringCycle(pool: Pool, config: MonitoringConfiguration): Promise<ReconciliationStatus> {
  let status: ReconciliationStatus;
  try {
    const { listed, indexed } = await syncMetaLeads(pool, config);
    const recovered = await recoverMissingLeads(pool, config);
    status = { at: new Date().toISOString(), ok: true, listed, indexed, recovered };
    if (recovered.length) console.warn(`Reconciliation recovered ${recovered.length} lead(s): ${recovered.join(', ')}.`);
  } catch (error) {
    status = { at: new Date().toISOString(), ok: false, error: error instanceof Error ? error.message : 'Falha na reconciliação.' };
  }
  await writeState(pool, 'reconciliation', status);
  await syncAlert(pool, 'reconciliation_failed', status.ok ? undefined : {
    kind: 'reconciliation_failed', severity: 'warning', count: 1,
    title: 'Reconciliação com a Meta falhou',
    message: `${status.error}. Sem a reconciliação, leads perdidos pelo webhook não são detectados.`,
  }, config.notify);
  await checkMetaToken(pool, config);
  await evaluateAlerts(pool, true, config.notify);
  return status;
}

export function telegramNotifier(botToken: string, chatId: string): (text: string) => Promise<void> {
  return async (text) => {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `SyncLead · ${text}`, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
  };
}

export async function purgeMonitoringData(pool: Pool, operationalMonths: number) {
  const metaLeads = await pool.query(
    `DELETE FROM meta_leads WHERE meta_created_at < NOW() - make_interval(months => $1)`,
    [operationalMonths],
  );
  const alerts = await pool.query(`DELETE FROM alerts WHERE resolved_at < NOW() - INTERVAL '12 months'`);
  return { metaLeads: metaLeads.rowCount ?? 0, alerts: alerts.rowCount ?? 0 };
}

interface DeliveryWindow {
  label: string;
  metaTotal: number;
  viaWebhook: number;
  recovered: number;
  missing: number;
  rate: number | null;
}

// Resumo sem PII para a aba Saúde (gestor e admin).
export async function getHealthSummary(pool: Pool, options: { recoverSince: Date; missingAfterMinutes: number; syonetEnabled: boolean; metaConfigured: boolean }) {
  const windows = await pool.query<{ label: string; meta_total: number; via_webhook: number; recovered: number; missing: number }>(
    `WITH w(label, start_at) AS (
       VALUES ('24h', GREATEST(NOW() - INTERVAL '24 hours', $1::timestamptz)),
              ('7d', GREATEST(NOW() - INTERVAL '7 days', $1::timestamptz)),
              ('desde_webhook', $1::timestamptz)
     )
     SELECT w.label,
            COUNT(m.leadgen_id)::int AS meta_total,
            COUNT(l.leadgen_id) FILTER (WHERE l.source = 'webhook')::int AS via_webhook,
            COUNT(l.leadgen_id) FILTER (WHERE l.source = 'reconciliation')::int AS recovered,
            COUNT(m.leadgen_id) FILTER (WHERE l.leadgen_id IS NULL)::int AS missing
     FROM w
     LEFT JOIN meta_leads m ON m.meta_created_at >= w.start_at AND m.meta_created_at < NOW() - make_interval(mins => $2)
     LEFT JOIN leads l ON l.leadgen_id = m.leadgen_id
     GROUP BY w.label`,
    [options.recoverSince, options.missingAfterMinutes],
  );
  const delivery: DeliveryWindow[] = ['24h', '7d', 'desde_webhook'].map((label) => {
    const row = windows.rows.find((r) => r.label === label);
    const metaTotal = row?.meta_total ?? 0;
    const viaWebhook = row?.via_webhook ?? 0;
    return {
      label,
      metaTotal,
      viaWebhook,
      recovered: row?.recovered ?? 0,
      missing: row?.missing ?? 0,
      rate: metaTotal ? Math.round((viaWebhook / metaTotal) * 1000) / 10 : null,
    };
  });

  const [queue, lastWebhook, historical, openAlerts, recentAlerts, reconciliation, token] = await Promise.all([
    pool.query<{ status: string; count: number }>(`SELECT status, COUNT(*)::int AS count FROM leads GROUP BY status ORDER BY status`),
    pool.query<{ at: string | null }>(`SELECT MAX(received_at) AS at FROM leads WHERE source = 'webhook'`),
    pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM meta_leads WHERE meta_created_at < $1`, [options.recoverSince]),
    pool.query(`SELECT id::int, kind, severity, title, message, item_count AS "count", opened_at AS "openedAt", last_seen_at AS "lastSeenAt", notified_at AS "notifiedAt"
                FROM alerts WHERE resolved_at IS NULL ORDER BY severity, opened_at`),
    pool.query(`SELECT id::int, kind, severity, title, opened_at AS "openedAt", resolved_at AS "resolvedAt"
                FROM alerts WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT 10`),
    readState<ReconciliationStatus>(pool, 'reconciliation'),
    readState<TokenStatus>(pool, 'meta_token'),
  ]);

  return {
    delivery,
    recoverSince: options.recoverSince.toISOString(),
    historicalBeforeWebhook: historical.rows[0]?.count ?? 0,
    queue: queue.rows,
    lastWebhookAt: lastWebhook.rows[0]?.at ?? null,
    reconciliation: reconciliation ?? null,
    token: token ?? null,
    openAlerts: openAlerts.rows,
    recentAlerts: recentAlerts.rows,
    syonetDelivery: options.syonetEnabled ? 'enabled' : 'disabled',
    metaConfigured: options.metaConfigured,
  };
}
