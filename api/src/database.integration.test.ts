import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import test from 'node:test';
import { claimLead, initializeDatabase, persistWebhook } from './database.js';
import { runWorker } from './worker.js';
import type { MetaWebhookPayload } from './types.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (testDatabaseUrl) {
  const databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.slice(1));
  if (!databaseName.toLowerCase().includes('test')) {
    throw new Error('TEST_DATABASE_URL must point to a dedicated database whose name contains "test".');
  }
}

function testPayload(leadgenId: string): MetaWebhookPayload {
  return {
    object: 'page',
    entry: [{
      id: 'test-page',
      changes: [{
        field: 'leadgen',
        value: {
          leadgen_id: leadgenId,
          page_id: 'test-page',
          form_id: 'test-form',
          created_time: 1_800_000_000,
        },
      }],
    }],
  };
}

test('PostgreSQL deduplicates Meta events and processes synthetic leads without Syonet', {
  skip: testDatabaseUrl ? false : 'Set TEST_DATABASE_URL to an isolated PostgreSQL test database.',
}, async () => {
  const databaseUrl = testDatabaseUrl;
  if (!databaseUrl) return;

  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
  const schemaName = `synclead_it_${process.pid}_${randomBytes(4).toString('hex')}`;
  let pool: Pool | undefined;

  try {
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName}`,
      max: 3,
    });
    await initializeDatabase(pool);

    const duplicatePayload = testPayload('synthetic-duplicate-lead');
    assert.equal(await persistWebhook(pool, duplicatePayload, false), 1);
    assert.equal(await persistWebhook(pool, duplicatePayload, false), 0);

    const claimed = await claimLead(pool, true, false);
    assert.equal(claimed?.leadgen_id, 'synthetic-duplicate-lead');
    assert.equal(claimed?.attempts, 1);

    const workerPayload = testPayload('synthetic-meta-worker-lead');
    assert.equal(await persistWebhook(pool, workerPayload, false), 1);

    const originalFetch = globalThis.fetch;
    const graphRequests: URL[] = [];
    const nonGraphRequests: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const requestUrl = new URL(String(input));
      if (requestUrl.hostname !== 'graph.facebook.com') {
        nonGraphRequests.push(requestUrl.hostname);
        throw new Error('Network calls other than the synthetic Graph API are disabled in tests.');
      }
      graphRequests.push(requestUrl);
      return new Response(JSON.stringify({
        id: 'synthetic-meta-worker-lead',
        platform: 'fb',
        field_data: [
          { name: 'full_name', values: ['Pessoa Sintética'] },
          { name: 'email', values: ['synthetic@example.test'] },
          { name: 'phone_number', values: ['(35) 90000-0000'] },
          { name: 'store_choice', values: ['VW Lavras'] },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const abortController = new AbortController();
    const workerPromise = runWorker(pool, {
      metaPageAccessToken: 'test-page-token',
      metaGraphApiVersion: 'v27.0',
      metaFormId: 'test-form',
    }, abortController.signal);

    try {
      const deadline = Date.now() + 5_000;
      let processedLead: {
        status: string;
        meta_processed_at: Date | null;
        selected_store_answer: string | null;
        syonet_company_id: number | null;
        attempts: number;
      } | undefined;

      while (Date.now() < deadline) {
        const result = await pool.query<{
          status: string;
          meta_processed_at: Date | null;
          selected_store_answer: string | null;
          syonet_company_id: number | null;
          attempts: number;
        }>(
          `SELECT status, meta_processed_at, selected_store_answer, syonet_company_id, attempts
           FROM leads
           WHERE leadgen_id = $1`,
          ['synthetic-meta-worker-lead'],
        );
        processedLead = result.rows[0];
        if (processedLead?.meta_processed_at) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      assert.ok(processedLead?.meta_processed_at, 'Meta worker did not finish lead validation.');
      assert.equal(processedLead.status, 'waiting_config');
      assert.equal(processedLead.selected_store_answer, 'VW Lavras');
      assert.equal(processedLead.syonet_company_id, 3);
      assert.equal(processedLead.attempts, 0);
      assert.equal(graphRequests.length, 1);
      assert.equal(graphRequests[0].searchParams.get('fields'), 'id,field_data,platform,is_organic,ad_id');
      assert.deepEqual(nonGraphRequests, []);
    } finally {
      abortController.abort();
      await workerPromise;
      globalThis.fetch = originalFetch;
    }

    const waitingForMetaPayload = testPayload('synthetic-waiting-for-meta-config');
    assert.equal(await persistWebhook(pool, waitingForMetaPayload, true), 1);
    assert.equal(await claimLead(pool, false, false), undefined);
    const metaReadyLead = await claimLead(pool, true, false);
    assert.equal(metaReadyLead?.leadgen_id, 'synthetic-waiting-for-meta-config');
    assert.equal(metaReadyLead?.attempts, 1);
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await adminPool.end();
  }
});
