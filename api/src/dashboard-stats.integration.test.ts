import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { initializeDatabase } from './database.js';
import { getDashboardStats, parseStatsRange } from './dashboard.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test('stats range accepts São Paulo dates and rejects invalid or oversized periods', () => {
  assert.deepEqual(parseStatsRange('2003-03-01', '2003-03-31'), { from: '2003-03-01', to: '2003-03-31' });
  assert.equal(parseStatsRange('2003-03-31', '2003-03-01'), undefined);
  assert.equal(parseStatsRange('2003-01-01', '2005-01-01'), undefined);
  assert.equal(parseStatsRange("2003-03-01'; --", null), undefined);
  const defaults = parseStatsRange(null, null);
  assert.ok(defaults);
  assert.equal((Date.parse(defaults.to) - Date.parse(defaults.from)) / 86_400_000, 29);
});

test('stats group by São Paulo day, exclude test leads and break down by store, platform and ad', {
  skip: testDatabaseUrl ? false : 'Set TEST_DATABASE_URL to an isolated PostgreSQL test database.',
}, async () => {
  if (!testDatabaseUrl || !decodeURIComponent(new URL(testDatabaseUrl).pathname).toLowerCase().includes('test')) return;
  const db = new Pool({ connectionString: testDatabaseUrl });
  // Datas em 2003 isolam este teste dos demais, que rodam em paralelo no mesmo banco.
  const ids = ['870000000000001', '870000000000002', '870000000000003'];
  try {
    await initializeDatabase(db);
    await db.query(`DELETE FROM leads WHERE leadgen_id = ANY($1)`, [ids]);
    const insert = `INSERT INTO leads (leadgen_id, form_id, page_id, ad_id, status, created_time, meta_platform, selected_store_answer, syonet_company_id, ad_name, campaign_name)
                    VALUES ($1, 'form-stats', 'page-stats', $2, 'waiting_config', $3, $4, $5, $6, $7, $8)`;
    // 02:30 UTC de 10/03 = 23:30 de 09/03 em São Paulo.
    await db.query(insert, [ids[0], 'ad-1', Date.parse('2003-03-10T02:30:00Z') / 1000, 'ig', 'vw_lavras', 3, 'Criativo A', 'Campanha X']);
    await db.query(insert, [ids[1], 'ad-1', Date.parse('2003-03-10T15:00:00Z') / 1000, 'fb', 'vw_lavras', 3, 'Criativo A', 'Campanha X']);
    await db.query(insert, [ids[2], null, Date.parse('2003-03-10T16:00:00Z') / 1000, null, 'vw_lavras', 3, null, null]);

    const stats = await getDashboardStats(db, { from: '2003-03-09', to: '2003-03-11' });
    assert.equal(stats.total, 2);
    assert.equal(stats.testsExcluded, 1);
    assert.deepEqual(stats.daily, [
      { date: '2003-03-09', count: 1 },
      { date: '2003-03-10', count: 1 },
      { date: '2003-03-11', count: 0 },
    ]);
    assert.deepEqual(stats.byStore, [{ answer: 'vw_lavras', companyId: 3, count: 2 }]);
    assert.deepEqual(stats.byPlatform.map((p) => [p.platform, p.count]).sort(), [['fb', 1], ['ig', 1]]);
    assert.deepEqual(stats.byAd, [{ adId: 'ad-1', adName: 'Criativo A', adsetName: null, campaignName: 'Campanha X', count: 2 }]);
  } finally {
    await db.query(`DELETE FROM leads WHERE leadgen_id = ANY($1)`, [ids]).catch(() => undefined);
    await db.end();
  }
});
