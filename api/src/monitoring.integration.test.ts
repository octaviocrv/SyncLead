import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { initializeDatabase } from './database.js';
import { evaluateAlerts, getHealthSummary, runMonitoringCycle, type MonitoringConfiguration } from './monitoring.js';
import { syonetConfigurationFor, type SyonetSendConfiguration } from './worker.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test('reconciliation indexes Meta leads without PII, recovers only post-webhook misses and alerts once', {
  skip: testDatabaseUrl ? false : 'Set TEST_DATABASE_URL to an isolated PostgreSQL test database.',
}, async () => {
  if (!testDatabaseUrl || !decodeURIComponent(new URL(testDatabaseUrl).pathname).toLowerCase().includes('test')) return;
  const db = new Pool({ connectionString: testDatabaseUrl });
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString().replace('.000Z', '+0000');
  const ids = { old: '880000000000001', missed: '880000000000002', recent: '880000000000003', present: '880000000000004', page2: '880000000000005' };
  const requested: URL[] = [];
  let tokenValid = true;
  const fakeFetch = (async (input: URL | string) => {
    const url = new URL(String(input));
    requested.push(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('/debug_token')) {
      return json({ data: { is_valid: tokenValid, type: 'SYSTEM_USER', expires_at: 0, scopes: ['leads_retrieval'] } });
    }
    if (url.searchParams.get('after') === 'p2') {
      return json({ data: [{ id: ids.page2, created_time: hoursAgo(3), platform: 'fb', is_organic: false }] });
    }
    return json({
      data: [
        { id: ids.recent, created_time: hoursAgo(0.01), platform: 'ig', is_organic: false },
        { id: ids.present, created_time: hoursAgo(1), platform: 'ig', is_organic: false },
        { id: ids.missed, created_time: hoursAgo(2), platform: 'ig', is_organic: false },
        { id: ids.old, created_time: hoursAgo(48), platform: 'fb', is_organic: false },
      ],
      paging: { next: 'https://graph.facebook.com/v27.0/form-test/leads?after=p2' },
    });
  }) as typeof fetch;
  const notifications: string[] = [];
  const config: MonitoringConfiguration = {
    accessToken: 'test-token',
    graphApiVersion: 'v27.0',
    formId: 'form-test',
    pageId: 'page-test',
    recoverSince: new Date(Date.now() - 24 * 3_600_000),
    missingAfterMinutes: 15,
    notify: async (text) => { notifications.push(text); },
    fetchImpl: fakeFetch,
  };
  const cleanup = async () => {
    await db.query(`DELETE FROM leads WHERE leadgen_id LIKE '8800000%'`);
    await db.query(`DELETE FROM meta_leads WHERE leadgen_id LIKE '8800000%'`);
    await db.query(`DELETE FROM alerts`);
    await db.query(`DELETE FROM system_state`);
  };

  try {
    await initializeDatabase(db);
    await cleanup();
    await db.query(
      `INSERT INTO leads (leadgen_id, form_id, page_id, ad_id, status) VALUES ($1, 'form-test', 'page-test', '1', 'waiting_config')`,
      [ids.present],
    );

    const status = await runMonitoringCycle(db, config);
    assert.equal(status.ok, true);
    assert.equal(status.listed, 5);
    assert.deepEqual(status.recovered?.sort(), [ids.missed, ids.page2]);
    assert.ok(requested.every((url) => !url.searchParams.get('fields')?.includes('field_data')), 'list never asks for PII');

    const leads = await db.query<{ leadgen_id: string; source: string; status: string }>(
      `SELECT leadgen_id, source, status FROM leads WHERE leadgen_id LIKE '8800000%' ORDER BY leadgen_id`,
    );
    assert.deepEqual(leads.rows.map((r) => [r.leadgen_id, r.source, r.status]), [
      [ids.missed, 'reconciliation', 'received'],
      [ids.present, 'webhook', 'waiting_config'],
      [ids.page2, 'reconciliation', 'received'],
    ], 'old lead (before webhook) and recent lead (<15 min) are not recovered');
    const indexed = await db.query(`SELECT COUNT(*)::int AS n FROM meta_leads WHERE leadgen_id LIKE '8800000%'`);
    assert.equal(indexed.rows[0].n, 5);

    const missedAlert = await db.query(`SELECT item_count FROM alerts WHERE dedupe_key = 'webhook_missed' AND resolved_at IS NULL`);
    assert.equal(missedAlert.rows[0]?.item_count, 2);
    assert.equal(notifications.filter((n) => n.includes('Webhook perdeu')).length, 1);
    assert.equal((await evaluateAlerts(db, true, config.notify)).webhook_missed, 'updated');
    assert.equal(notifications.filter((n) => n.includes('Webhook perdeu')).length, 1, 'no repeated notification');

    // Recuperado já processado nunca é reivindicado para envio ao Syonet.
    await db.query(
      `UPDATE leads SET status = 'waiting_config', meta_processed_at = NOW() WHERE leadgen_id IN ($1, $2)`,
      [ids.missed, ids.page2],
    );
    const claimable = await db.query(
      `SELECT 1 FROM leads WHERE leadgen_id IN ($1, $2) AND status = 'waiting_config'
         AND meta_processed_at IS NOT NULL AND source = 'webhook'`,
      [ids.missed, ids.page2],
    );
    assert.equal(claimable.rowCount, 0, 'Syonet claim branch excludes reconciliation leads');
    const syonet = { apiUrl: 'https://example.test' } as SyonetSendConfiguration;
    assert.equal(syonetConfigurationFor(ids.missed, syonet, 'reconciliation'), undefined);
    assert.equal(syonetConfigurationFor(ids.present, syonet, 'webhook'), syonet);

    const health = await getHealthSummary(db, { recoverSince: config.recoverSince, missingAfterMinutes: 15, syonetEnabled: false, metaConfigured: true });
    const since = health.delivery.find((d) => d.label === 'desde_webhook');
    assert.deepEqual(since && { meta: since.metaTotal, webhook: since.viaWebhook, recovered: since.recovered, missing: since.missing },
      { meta: 3, webhook: 1, recovered: 2, missing: 0 });
    assert.equal(health.historicalBeforeWebhook, 1);

    // Segunda passada é incremental (filtro por time_created) e o token inválido abre alerta.
    tokenValid = false;
    await db.query(`DELETE FROM system_state WHERE key = 'meta_token'`);
    requested.length = 0;
    await runMonitoringCycle(db, config);
    assert.ok(requested.some((url) => url.searchParams.get('filtering')?.includes('time_created')));
    const tokenAlert = await db.query(`SELECT 1 FROM alerts WHERE dedupe_key = 'meta_token' AND resolved_at IS NULL`);
    assert.equal(tokenAlert.rowCount, 1);
  } finally {
    await cleanup().catch(() => {});
    await db.end();
  }
});
