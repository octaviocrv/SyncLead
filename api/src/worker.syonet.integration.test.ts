import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { initializeDatabase, persistWebhook } from './database.js';
import { startSyonetMock, type SyonetMockScenario } from './test-support/syonet-mock.js';
import { getDashboardLeadDetail, listDashboardLeads } from './dashboard.js';
import { runWorker } from './worker.js';
import type { MetaWebhookPayload } from './types.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (testDatabaseUrl) {
  const databaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.slice(1));
  if (!databaseName.toLowerCase().includes('test')) {
    throw new Error('TEST_DATABASE_URL must point to a dedicated database whose name contains "test".');
  }
}

function payload(leadgenId: string): MetaWebhookPayload {
  return {
    object: 'page',
    entry: [{
      id: 'test-page',
      changes: [{
        field: 'leadgen',
        value: { leadgen_id: leadgenId, page_id: 'test-page', form_id: 'test-form', created_time: 1_800_000_000 },
      }],
    }],
  };
}

function metaLead(leadgenId: string, organic: boolean) {
  return {
    id: leadgenId,
    ...(organic ? { is_organic: true } : { platform: 'fb' }),
    field_data: [
      { name: 'full_name', values: ['Pessoa Sintética'] },
      { name: 'email', values: ['synthetic@example.test'] },
      { name: 'phone_number', values: ['(35) 90000-0000'] },
      { name: 'store_choice', values: ['VW Lavras'] },
    ],
  };
}

test('worker Syonet delivery flow against the simulated Syonet API', {
  skip: testDatabaseUrl ? false : 'Set TEST_DATABASE_URL to an isolated PostgreSQL test database.',
}, async () => {
  const databaseUrl = testDatabaseUrl;
  if (!databaseUrl) return;

  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
  const schemaName = `synclead_sy_${process.pid}_${randomBytes(4).toString('hex')}`;
  const syonet = await startSyonetMock();
  const originalFetch = globalThis.fetch;
  const organicLeads = new Set<string>();
  let pool: Pool | undefined;
  let abort: AbortController | undefined;
  let workerPromise: Promise<void> | undefined;

  try {
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}`, max: 3 });
    const db = pool;
    await initializeDatabase(db);

    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'graph.facebook.com') {
        const leadgenId = decodeURIComponent(url.pathname.split('/').pop() ?? '');
        return new Response(JSON.stringify(metaLead(leadgenId, organicLeads.has(leadgenId))), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.hostname === '127.0.0.1') return originalFetch(input, init);
      throw new Error(`Unexpected network call to ${url.hostname}.`);
    };

    abort = new AbortController();
    workerPromise = runWorker(db, {
      metaPageAccessToken: 'test-page-token',
      metaGraphApiVersion: 'v27.0',
      metaFormId: 'test-form',
      syonet: {
        apiUrl: syonet.url,
        auth: { mode: 'basic', username: 'fake-user', password: 'fake-password' },
        eventGroup: 'group',
        eventType: 'type',
        source: 'source',
        daysToUpdateOpenEvent: 0,
        timeoutMs: 300,
      },
    }, abort.signal);

    async function run(leadgenId: string, scenario: SyonetMockScenario, organic = false) {
      organicLeads[organic ? 'add' : 'delete'](leadgenId);
      syonet.scenario = scenario;
      assert.equal(await persistWebhook(db, payload(leadgenId), false), 1);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const { rows } = await db.query<{ status: string; last_error: string | null; syonet_event_id: string | null }>(
          'SELECT status, last_error, syonet_event_id FROM leads WHERE leadgen_id = $1',
          [leadgenId],
        );
        if (rows[0] && !['received', 'processing'].includes(rows[0].status)) {
          const attempts = await db.query<{ stage: string; status: string }>(
            'SELECT stage, status FROM processing_attempts WHERE leadgen_id = $1 ORDER BY id',
            [leadgenId],
          );
          return { lead: rows[0], attempts: attempts.rows };
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Lead ${leadgenId} did not finish processing.`);
    }

    const sentBefore = () => syonet.requests.length;

    let before = sentBefore();
    const sent = await run('sy-ok', 'ok');
    assert.equal(sent.lead.status, 'sent');
    assert.equal(sent.lead.syonet_event_id, '987654');
    assert.equal(syonet.requests.length - before, 1);
    const authorization = syonet.requests.at(-1)?.headers.authorization;
    assert.equal(authorization, `Basic ${Buffer.from('fake-user:fake-password').toString('base64')}`);

    before = sentBefore();
    const unauthorized = await run('sy-401', 'unauthorized');
    assert.equal(unauthorized.lead.status, 'blocked');
    assert.match(unauthorized.lead.last_error ?? '', /authentication failed/i);
    assert.equal(unauthorized.attempts.at(-1)?.stage, 'syonet_auth');
    assert.equal(syonet.requests.length - before, 1);

    before = sentBefore();
    const invalid = await run('sy-412', 'precondition-failed');
    assert.equal(invalid.lead.status, 'failed');
    assert.match(invalid.lead.last_error ?? '', /validation/i);
    assert.equal(invalid.attempts.at(-1)?.stage, 'syonet_validation');
    assert.equal(syonet.requests.length - before, 1);

    before = sentBefore();
    const rateLimited = await run('sy-429', 'rate-limited');
    assert.equal(rateLimited.lead.status, 'retry');
    assert.equal(syonet.requests.length - before, 1);

    // 429 must stop after the total attempt limit instead of retrying forever.
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
      const { rows } = await db.query<{ status: string }>('SELECT status FROM leads WHERE leadgen_id = $1', ['sy-429']);
      if (rows[0]?.status === 'failed') break;
      if (rows[0]?.status === 'retry') await db.query('UPDATE leads SET available_at = NOW() WHERE leadgen_id = $1', ['sy-429']);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const exhausted = await db.query<{ status: string; attempts: number }>('SELECT status, attempts FROM leads WHERE leadgen_id = $1', ['sy-429']);
    assert.deepEqual(exhausted.rows[0], { status: 'failed', attempts: 5 });
    assert.equal(syonet.requests.length - before, 5);

    for (const [leadgenId, scenario] of [
      ['sy-5xx', 'server-error'],
      ['sy-malformed', 'malformed'],
      ['sy-timeout', 'timeout'],
    ] as const) {
      before = sentBefore();
      const ambiguous = await run(leadgenId, scenario);
      assert.equal(ambiguous.lead.status, 'ambiguous', leadgenId);
      assert.equal(syonet.requests.length - before, 1, leadgenId);
    }

    // The worker must not resend ambiguous leads: give it time to prove it.
    const total = syonet.requests.length;
    syonet.scenario = 'ok';
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(syonet.requests.length, total);

    before = sentBefore();
    const organic = await run('sy-organic-test', 'ok', true);
    assert.equal(organic.lead.status, 'blocked');
    assert.match(organic.lead.last_error ?? '', /never sent to Syonet/);
    assert.equal(syonet.requests.length, before);
  } finally {
    abort?.abort();
    await workerPromise;
    globalThis.fetch = originalFetch;
    await syonet.close();
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await adminPool.end();
  }
});

test('homologation allowlist sends only the released lead and keeps evidence', {
  skip: testDatabaseUrl ? false : 'Set TEST_DATABASE_URL to an isolated PostgreSQL test database.',
}, async () => {
  const databaseUrl = testDatabaseUrl;
  if (!databaseUrl) return;

  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
  const schemaName = `synclead_hm_${process.pid}_${randomBytes(4).toString('hex')}`;
  const syonet = await startSyonetMock();
  const originalFetch = globalThis.fetch;
  let pool: Pool | undefined;
  let abort: AbortController | undefined;
  let workerPromise: Promise<void> | undefined;

  try {
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}`, max: 3 });
    const db = pool;
    await initializeDatabase(db);

    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'graph.facebook.com') {
        const leadgenId = decodeURIComponent(url.pathname.split('/').pop() ?? '');
        return new Response(JSON.stringify(metaLead(leadgenId, leadgenId === 'hm-allowed')), { status: 200 });
      }
      if (url.hostname === '127.0.0.1') return originalFetch(input, init);
      throw new Error(`Unexpected network call to ${url.hostname}.`);
    };

    abort = new AbortController();
    workerPromise = runWorker(db, {
      metaPageAccessToken: 'test-page-token',
      metaGraphApiVersion: 'v27.0',
      metaFormId: 'test-form',
      syonet: {
        apiUrl: syonet.url,
        auth: { mode: 'apikey', apiKey: 'fake-key' },
        eventGroup: 'OPORTUNIDADE',
        eventType: 'CONSORCIO WEB',
        source: 'INTERNET',
        daysToUpdateOpenEvent: 0,
        timeoutMs: 300,
        onlyLeadgenIds: ['hm-allowed'],
        homologationMedia: 'FACEBOOK',
      },
    }, abort.signal);

    async function waitFor(leadgenId: string, statuses: string[]) {
      for (const deadline = Date.now() + 5_000; Date.now() < deadline;) {
        const { rows } = await db.query<{ status: string; attempts: number }>(
          'SELECT status, attempts FROM leads WHERE leadgen_id = $1', [leadgenId]);
        if (rows[0] && statuses.includes(rows[0].status)) return rows[0];
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Lead ${leadgenId} did not reach ${statuses.join('/')}.`);
    }

    // Lead real fora da allowlist: processado da Meta, mas estacionado sem envio.
    await persistWebhook(db, payload('hm-other'), false);
    const parked = await waitFor('hm-other', ['waiting_config']);
    assert.equal(syonet.requests.length, 0);

    await persistWebhook(db, payload('hm-allowed'), false);
    assert.equal((await waitFor('hm-allowed', ['sent', 'blocked', 'failed', 'ambiguous'])).status, 'sent');
    assert.equal(syonet.requests.length, 1);
    const body = syonet.requests[0].body as { event: { companyId: number; media: string }; customer: { phones: unknown[] } };
    assert.equal(body.event.companyId, 3);
    assert.equal(body.event.media, 'FACEBOOK');
    assert.deepEqual(body.customer.phones, [{ ddd: 35, numero: 900000000 }]);

    await new Promise((resolve) => setTimeout(resolve, 800));
    const stillParked = await db.query<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM leads WHERE leadgen_id = $1', ['hm-other']);
    assert.deepEqual(stillParked.rows[0], parked);
    assert.equal(syonet.requests.length, 1);

    const evidence = await db.query<{ syonet_request: unknown; syonet_response: { httpStatus: number; body: { ok: number } } }>(
      'SELECT syonet_request, syonet_response FROM lead_personal_data WHERE leadgen_id = $1', ['hm-allowed']);
    assert.deepEqual(evidence.rows[0].syonet_request, body);
    assert.equal(evidence.rows[0].syonet_response.httpStatus, 200);
    assert.equal(evidence.rows[0].syonet_response.body.ok, 1);

    const listed = (await listDashboardLeads(db, 'admin')).find((lead) => lead.leadgenId === 'hm-other');
    assert.deepEqual(listed?.contact, { name: 'Pessoa Sintética', phoneMasked: '(35) •••••-••00', emailMasked: 'sy•••@e•••.test' });
    assert.equal(JSON.stringify(listed).includes('synthetic@example.test'), false);

    const previewOptions = {
      formId: 'test-form', eventGroup: 'OPORTUNIDADE', eventType: 'CONSORCIO WEB', source: 'INTERNET', daysToUpdateOpenEvent: 0,
    };
    const gestor = { id: 2, email: 'gestor@example.test', name: 'Gestor', role: 'gestor' as const };
    const gestorList = (await listDashboardLeads(db, 'gestor')).find((lead) => lead.leadgenId === 'hm-other');
    assert.equal(gestorList?.contact.name, 'Pessoa S.');
    const gestorDetail = await getDashboardLeadDetail(db, 'hm-other', { remoteAddr: '127.0.0.1', user: gestor }, previewOptions);
    assert.equal(gestorDetail?.personalData, null);
    assert.equal(gestorDetail?.personalDataRestricted, true);
    assert.equal(JSON.stringify(gestorDetail).includes('Sintética'), false);
    assert.equal(JSON.stringify(gestorDetail).includes('synthetic@example.test'), false);

    const admin = { id: 1, email: 'admin@example.test', name: 'Admin', role: 'admin' as const };
    const detail = await getDashboardLeadDetail(db, 'hm-other', { remoteAddr: '127.0.0.1', user: admin }, previewOptions);
    assert.equal(detail?.personalData?.normalized?.email, 'synthetic@example.test');
    assert.equal(detail?.personalData?.store?.companyId, 3);
    assert.deepEqual(detail?.personalData?.syonetBlockers, []);
    assert.equal((detail?.personalData?.syonetPreview as { event: { media: string } }).event.media, 'FACEBOOK');
    const accessLog = await db.query('SELECT user_id FROM data_access_log WHERE leadgen_id = $1', ['hm-other']);
    assert.deepEqual(accessLog.rows, [{ user_id: '1' }]);
  } finally {
    abort?.abort();
    await workerPromise;
    globalThis.fetch = originalFetch;
    await syonet.close();
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await adminPool.end();
  }
});
