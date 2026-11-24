import { Pool, type PoolClient } from 'pg';
import { schema } from './schema.js';
import type { LeadStatus, MetaWebhookPayload, PersistedLead } from './types.js';

export function createPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'synclead-api',
  });
}

export async function initializeDatabase(pool: Pool): Promise<void> {
  await pool.query(schema);
}

export async function persistWebhook(
  pool: Pool,
  payload: MetaWebhookPayload,
  waitingForConfig: boolean,
): Promise<number> {
  const client = await pool.connect();
  let inserted = 0;

  try {
    await client.query('BEGIN');
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'leadgen' || !change.value?.leadgen_id) continue;

        const leadgenId = String(change.value.leadgen_id);
        const pageId = String(change.value.page_id ?? entry.id ?? '');
        const formId = String(change.value.form_id ?? '');
        if (!pageId || !formId) {
          throw new Error('Meta lead notification is missing page_id or form_id.');
        }

        const status = waitingForConfig ? 'waiting_config' : 'received';
        const result = await client.query(
          `INSERT INTO leads (
             leadgen_id, form_id, page_id, ad_id, adgroup_id, created_time, status
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (leadgen_id) DO NOTHING`,
          [
            leadgenId,
            formId,
            pageId,
            change.value.ad_id ? String(change.value.ad_id) : null,
            change.value.adgroup_id ? String(change.value.adgroup_id) : null,
            change.value.created_time ?? null,
            status,
          ],
        );

        if (result.rowCount) {
          inserted += 1;
          await addAttempt(
            client,
            leadgenId,
            'webhook',
            waitingForConfig ? 'waiting' : 'success',
            waitingForConfig
              ? 'Lead persisted; integration credentials are not configured yet.'
              : 'Meta lead notification persisted.',
          );
        }
      }
    }
    await client.query('COMMIT');
    return inserted;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function claimLead(
  pool: Pool,
  metaProcessingConfigured: boolean,
  syonetSendingConfigured: boolean,
  onlyLeadgenIds: string[] = [],
): Promise<PersistedLead | undefined> {
  const result = await pool.query<PersistedLead>(
    `WITH next_lead AS (
       SELECT leadgen_id
       FROM leads
       WHERE (
         (status IN ('received', 'retry') AND available_at <= NOW())
         OR ($1 AND status = 'waiting_config' AND meta_processed_at IS NULL)
         OR ($2 AND status = 'waiting_config' AND meta_processed_at IS NOT NULL AND source = 'webhook'
             AND (cardinality($3::text[]) = 0 OR leadgen_id = ANY($3::text[])))
       )
       ORDER BY available_at, received_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE leads AS lead
     SET status = 'processing',
         attempts = attempts + 1,
         locked_at = NOW(),
         updated_at = NOW()
     FROM next_lead
     WHERE lead.leadgen_id = next_lead.leadgen_id
     RETURNING lead.leadgen_id, lead.form_id, lead.page_id, lead.ad_id,
               lead.adgroup_id, lead.created_time, lead.status, lead.attempts,
               lead.selected_store_answer, lead.source`,
    [metaProcessingConfigured, syonetSendingConfigured, onlyLeadgenIds],
  );
  return result.rows[0];
}

export async function recoverStaleLeads(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE leads
     SET status = 'ambiguous',
         locked_at = NULL,
         last_error = 'Worker stopped during processing; manual review is required before retry.',
         updated_at = NOW()
     WHERE status = 'processing'
       AND locked_at < NOW() - INTERVAL '5 minutes'`,
  );
}

export async function addAttempt(
  client: PoolClient,
  leadgenId: string,
  stage: string,
  status: string,
  message: string,
): Promise<void> {
  await client.query(
    `INSERT INTO processing_attempts (leadgen_id, stage, status, message)
     VALUES ($1, $2, $3, $4)`,
    [leadgenId, stage, status, message],
  );
}

export async function updateLead(
  pool: Pool,
  leadgenId: string,
  status: LeadStatus,
  message: string,
  details: {
    companyId?: number;
    eventId?: string;
    storeAnswer?: string;
    retryAfterSeconds?: number;
    stage?: string;
    metaProcessed?: boolean;
  } = {},
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE leads
       SET status = $2,
           last_error = CASE WHEN $2 IN ('sent') THEN NULL ELSE $3 END,
           syonet_company_id = COALESCE($4, syonet_company_id),
           syonet_event_id = COALESCE($5, syonet_event_id),
           selected_store_answer = COALESCE($6, selected_store_answer),
           available_at = CASE WHEN $7::integer IS NULL THEN available_at
                               ELSE NOW() + ($7::text || ' seconds')::interval END,
           attempts = CASE WHEN $8 AND $2 = 'waiting_config' THEN 0 ELSE attempts END,
           meta_processed_at = CASE WHEN $8 THEN NOW() ELSE meta_processed_at END,
           locked_at = NULL,
           updated_at = NOW()
       WHERE leadgen_id = $1`,
      [
        leadgenId,
        status,
        message,
        details.companyId ?? null,
        details.eventId ?? null,
        details.storeAnswer ?? null,
        details.retryAfterSeconds ?? null,
        details.metaProcessed ?? false,
      ],
    );
    await addAttempt(client, leadgenId, details.stage ?? 'processing', status, message);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
