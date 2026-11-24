import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { initializeDatabase } from './database.js';
import { getStorageStatus, syncStorageAlert, type StorageStatus } from './storage.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl) {
  const databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.slice(1));
  if (!databaseName.toLowerCase().includes('test')) throw new Error('TEST_DATABASE_URL must point to a dedicated database whose name contains "test".');
}

test('disk usage alert opens, escalates once, updates quietly and resolves; status reads the real disk and PostgreSQL size', {
  skip: testDatabaseUrl ? false : 'Set TEST_DATABASE_URL to an isolated PostgreSQL test database.',
}, async () => {
  const databaseUrl = testDatabaseUrl;
  if (!databaseUrl) return;
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
  const schemaName = `synclead_it_${process.pid}_${randomBytes(4).toString('hex')}`;
  let pool: Pool | undefined;
  try {
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}`, max: 2 });
    await initializeDatabase(pool);

    const real = await getStorageStatus(pool, { path: '/', reportFile: '/nonexistent/report.json', warnPercent: 70, criticalPercent: 85 });
    assert.ok(real.totalBytes > 0 && real.percent >= 0 && real.percent <= 100);
    assert.ok((real.postgresBytes ?? 0) > 0, 'PostgreSQL size is read from the database');
    assert.equal(real.backupsBytes, null, 'no host report: breakdown is unknown, not invented');

    const notifications: string[] = [];
    const notify = async (text: string) => { notifications.push(text); };
    const at = (percent: number, level: StorageStatus['level']): StorageStatus => ({
      ...real, percent, level, usedBytes: percent * 1e9, totalBytes: 100e9,
    });

    assert.equal(await syncStorageAlert(pool, at(60, 'ok'), notify), 'none');
    assert.equal(await syncStorageAlert(pool, at(78, 'warning'), notify), 'opened');
    assert.equal(await syncStorageAlert(pool, at(80, 'warning'), notify), 'updated');
    assert.equal(notifications.length, 1, 'no repeated notification while the level is the same');
    assert.equal(await syncStorageAlert(pool, at(90, 'critical'), notify), 'worsened');
    assert.equal(notifications.length, 2);
    assert.match(notifications[1], /crítico/i);
    const open = await pool.query(`SELECT severity FROM alerts WHERE dedupe_key = 'disk_usage' AND resolved_at IS NULL`);
    assert.deepEqual(open.rows, [{ severity: 'critical' }]);
    assert.equal(await syncStorageAlert(pool, at(50, 'ok'), notify), 'resolved');
    assert.equal((await pool.query(`SELECT 1 FROM alerts WHERE dedupe_key = 'disk_usage' AND resolved_at IS NULL`)).rowCount, 0);
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await adminPool.end();
  }
});
