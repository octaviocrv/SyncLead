// Local end-to-end run: signed webhook -> API -> PostgreSQL -> worker -> simulated Syonet.
// Usage: TEST_DATABASE_URL=postgres://.../synclead_test npx tsx src/test-support/e2e-local.ts
import { createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { createApiServer } from '../app.js';
import { initializeDatabase, persistWebhook } from '../database.js';
import { runWorker } from '../worker.js';
import { startSyonetMock, type SyonetMockScenario } from './syonet-mock.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.toLowerCase().includes('test')) {
  throw new Error('Set TEST_DATABASE_URL to a dedicated database whose name contains "test".');
}

const appSecret = 'local-fake-app-secret';
const schemaName = `synclead_e2e_${randomBytes(4).toString('hex')}`;
const admin = new Pool({ connectionString: databaseUrl, max: 1 });
await admin.query(`CREATE SCHEMA "${schemaName}"`);
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}`, max: 4 });
await initializeDatabase(pool);

const syonet = await startSyonetMock();
const organic = new Set<string>();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.hostname === 'graph.facebook.com') {
    const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
    return new Response(JSON.stringify({
      id,
      ...(organic.has(id) ? { is_organic: true } : { platform: 'ig' }),
      field_data: [
        { name: 'full_name', values: ['Pessoa Sintética'] },
        { name: 'email', values: ['synthetic@example.test'] },
        { name: 'phone_number', values: ['(35) 90000-0000'] },
        { name: 'store_choice', values: ['VW Lavras'] },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.hostname === '127.0.0.1') return originalFetch(input, init);
  throw new Error(`Blocked network call to ${url.hostname}`);
};

const api = createApiServer({
  configuration: {
    metaAppSecret: appSecret,
    metaWebhookVerifyToken: 'local-verify',
    metaAllowedPageIds: ['372411372613737'],
    metaProcessingConfigured: true,
    syonetSendingConfigured: true,
  },
  healthCheck: async () => void (await pool.query('SELECT 1')),
  persistWebhook: (payload, waiting) => persistWebhook(pool, payload, waiting),
});
await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api/webhooks/meta`;

const abort = new AbortController();
const worker = runWorker(pool, {
  metaPageAccessToken: 'fake-page-token',
  metaGraphApiVersion: 'v27.0',
  metaFormId: '1030408329895026',
  syonet: {
    apiUrl: syonet.url,
    auth: { mode: 'basic', username: 'fake-user', password: 'fake-password' },
    eventGroup: 'OPORTUNIDADE',
    eventType: 'CONSORCIO WEB',
    source: 'INTERNET',
    daysToUpdateOpenEvent: 0,
    timeoutMs: 400,
  },
}, abort.signal);

async function post(leadgenId: string): Promise<number> {
  const body = JSON.stringify({
    object: 'page',
    entry: [{ id: '372411372613737', changes: [{ field: 'leadgen', value: {
      leadgen_id: leadgenId, page_id: '372411372613737', form_id: '1030408329895026', created_time: 1_800_000_000,
    } }] }],
  });
  const signature = `sha256=${createHmac('sha256', appSecret).update(body).digest('hex')}`;
  const response = await originalFetch(apiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body,
  });
  return response.status;
}

const terminal = ['sent', 'blocked', 'failed', 'ambiguous', 'retry'];
async function scenario(label: string, leadgenId: string, mode: SyonetMockScenario, isOrganic = false) {
  organic[isOrganic ? 'add' : 'delete'](leadgenId);
  syonet.scenario = mode;
  const before = syonet.requests.length;
  const http = await post(leadgenId);
  let lead: Record<string, unknown> | undefined;
  for (const deadline = Date.now() + 5_000; Date.now() < deadline;) {
    lead = (await pool.query(
      'SELECT status, attempts, syonet_company_id, syonet_event_id, last_error FROM leads WHERE leadgen_id=$1', [leadgenId],
    )).rows[0];
    if (lead && terminal.includes(String(lead.status))) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const attempts = (await pool.query('SELECT stage, status, message FROM processing_attempts WHERE leadgen_id=$1 ORDER BY id', [leadgenId])).rows;
  const sent = syonet.requests.slice(before);
  console.log(`\n=== ${label} (webhook HTTP ${http}, chamadas ao mock Syonet: ${sent.length}) ===`);
  if (sent[0]) console.log('payload enviado:', JSON.stringify(sent[0].body));
  console.log('lead:', JSON.stringify(lead));
  console.table(attempts);
}

await scenario('200 sucesso', 'e2e-200', 'ok');
await scenario('401 autenticação', 'e2e-401', 'unauthorized');
await scenario('412 validação', 'e2e-412', 'precondition-failed');
await scenario('5xx', 'e2e-5xx', 'server-error');
await scenario('timeout', 'e2e-timeout', 'timeout');
await scenario('orgânico sem platform', 'e2e-organic', 'ok', true);

// 429: attempts accumulate until the limit; skip the backoff wait by making the lead due again.
organic.delete('e2e-429');
syonet.scenario = 'rate-limited';
const before429 = syonet.requests.length;
await post('e2e-429');
for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
  const { rows } = await pool.query('SELECT status FROM leads WHERE leadgen_id=$1', ['e2e-429']);
  if (rows[0]?.status === 'failed') break;
  if (rows[0]?.status === 'retry') await pool.query("UPDATE leads SET available_at = NOW() WHERE leadgen_id=$1", ['e2e-429']);
  await new Promise((r) => setTimeout(r, 50));
}
const final429 = (await pool.query('SELECT status, attempts, last_error FROM leads WHERE leadgen_id=$1', ['e2e-429'])).rows[0];
console.log(`\n=== 429 limite de tentativas (chamadas ao mock: ${syonet.requests.length - before429}) ===`);
console.log('lead:', JSON.stringify(final429));
console.table((await pool.query('SELECT stage, status, message FROM processing_attempts WHERE leadgen_id=$1 ORDER BY id', ['e2e-429'])).rows);

abort.abort();
await worker;
globalThis.fetch = originalFetch;
await syonet.close();
await new Promise((resolve) => api.close(resolve));
await pool.end();
await admin.query(`DROP SCHEMA "${schemaName}" CASCADE`);
await admin.end();
