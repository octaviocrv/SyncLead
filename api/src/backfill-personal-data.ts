// Uso único: `node dist/backfill-personal-data.js [leadgen_id...]`.
// Rebusca na Graph API (somente leitura) leads já processados sem dados guardados.
// Não altera status, tentativas nem envia nada ao Syonet.
import { config } from './config.js';
import { createPool } from './database.js';
import { saveLeadCapture } from './personal-data.js';
import { fetchMetaLead } from './worker.js';

const ids = process.argv.slice(2).filter((id) => /^\d{1,32}$/.test(id));
const pool = createPool(config.databaseUrl);

try {
  if (!config.metaPageAccessToken) throw new Error('META_PAGE_ACCESS_TOKEN is not configured.');
  const { rows } = await pool.query<{ leadgen_id: string }>(
    `SELECT l.leadgen_id FROM leads l
     LEFT JOIN lead_personal_data p ON p.leadgen_id = l.leadgen_id
     WHERE p.leadgen_id IS NULL
       AND l.meta_processed_at IS NOT NULL
       AND l.received_at > NOW() - INTERVAL '90 days'
       AND (cardinality($1::text[]) = 0 OR l.leadgen_id = ANY($1::text[]))
     ORDER BY l.received_at`,
    [ids],
  );

  for (const { leadgen_id: leadgenId } of rows) {
    try {
      const metaLead = await fetchMetaLead(leadgenId, {
        metaPageAccessToken: config.metaPageAccessToken,
        metaGraphApiVersion: config.metaGraphApiVersion,
        metaFormId: config.metaFormId,
      });
      await saveLeadCapture(pool, leadgenId, metaLead);
      console.info(`Backfilled ${leadgenId}: ${metaLead.field_data?.length ?? 0} fields, platform=${metaLead.platform ?? 'none'}.`);
    } catch (error) {
      console.error(`Backfill failed for ${leadgenId}:`, error instanceof Error ? error.message : 'unknown error');
    }
  }
  console.info(`Backfill finished: ${rows.length} candidate lead(s).`);
} finally {
  await pool.end();
}
