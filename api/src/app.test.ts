import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApiServer, type ApiServerDependencies } from './app.js';
import type { MetaWebhookPayload } from './types.js';

const appSecret = 'test-app-secret';

function createDependencies(
  overrides: Partial<ApiServerDependencies> = {},
): ApiServerDependencies {
  return {
    configuration: {
      metaAppSecret: appSecret,
      metaWebhookVerifyToken: 'test-verify-token',
      metaAllowedPageIds: ['test-page'],
      metaProcessingConfigured: false,
      syonetSendingConfigured: false,
    },
    healthCheck: async () => {},
    persistWebhook: async () => 1,
    ...overrides,
  };
}

async function startServer(dependencies: ApiServerDependencies): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createApiServer(dependencies);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await closed;
    },
  };
}

function testPayload(leadgenId = 'synthetic-lead-1'): MetaWebhookPayload {
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
        },
      }],
    }],
  };
}

function signature(body: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(body).digest('hex')}`;
}

test('GET webhook returns the challenge only for the configured verify token', async (t) => {
  const server = await startServer(createDependencies());
  t.after(server.close);

  const valid = await fetch(
    `${server.baseUrl}/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=challenge-123`,
  );
  assert.equal(valid.status, 200);
  assert.equal(await valid.text(), 'challenge-123');

  const invalid = await fetch(
    `${server.baseUrl}/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-123`,
  );
  assert.equal(invalid.status, 403);
});

test('POST webhook verifies the signature and persists before acknowledging duplicates', async (t) => {
  const received = new Set<string>();
  const persistedWaitingForMeta: boolean[] = [];
  const server = await startServer(createDependencies({
    persistWebhook: async (payload: MetaWebhookPayload, waitingForMeta: boolean) => {
      persistedWaitingForMeta.push(waitingForMeta);
      const id = String(payload.entry?.[0]?.changes?.[0]?.value?.leadgen_id);
      if (received.has(id)) return 0;
      received.add(id);
      return 1;
    },
  }));
  t.after(server.close);

  const body = JSON.stringify(testPayload());
  const headers = {
    'content-type': 'application/json',
    'x-hub-signature-256': signature(body),
  };

  const first = await fetch(`${server.baseUrl}/api/webhooks/meta`, {
    method: 'POST',
    headers,
    body,
  });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { received: true });

  const duplicate = await fetch(`${server.baseUrl}/api/webhooks/meta`, {
    method: 'POST',
    headers,
    body,
  });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { received: true });
  assert.deepEqual(persistedWaitingForMeta, [true, true]);
});

test('POST webhook rejects invalid signatures, unsupported pages, content types, and malformed JSON', async (t) => {
  let persistenceCalls = 0;
  const server = await startServer(createDependencies({
    persistWebhook: async () => {
      persistenceCalls += 1;
      return 1;
    },
  }));
  t.after(server.close);

  const validBody = JSON.stringify(testPayload());
  const invalidSignature = await fetch(`${server.baseUrl}/api/webhooks/meta`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signature(`${validBody} `),
    },
    body: validBody,
  });
  assert.equal(invalidSignature.status, 401);

  const wrongPageBody = JSON.stringify({
    ...testPayload(),
    entry: [{ id: 'not-allowed', changes: [] }],
  });
  const wrongPage = await fetch(`${server.baseUrl}/api/webhooks/meta`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signature(wrongPageBody),
    },
    body: wrongPageBody,
  });
  assert.equal(wrongPage.status, 403);

  const wrongContentType = await fetch(`${server.baseUrl}/api/webhooks/meta`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: validBody,
  });
  assert.equal(wrongContentType.status, 415);

  const malformedBody = '{';
  const malformedJson = await fetch(`${server.baseUrl}/api/webhooks/meta`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signature(malformedBody),
    },
    body: malformedBody,
  });
  assert.equal(malformedJson.status, 400);
  assert.equal(persistenceCalls, 0);
});

test('POST webhook rejects bodies over the configured size limit', async (t) => {
  const server = await startServer(createDependencies());
  t.after(server.close);

  const body = JSON.stringify({ payload: 'x'.repeat(1_000_001) });
  const response = await fetch(`${server.baseUrl}/api/webhooks/meta`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signature(body),
    },
    body,
  });
  assert.equal(response.status, 413);
});

test('health endpoint reports database and Meta/Syonet processing states', async (t) => {
  const server = await startServer(createDependencies());
  t.after(server.close);

  const response = await fetch(`${server.baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'ok',
    database: 'connected',
    metaProcessing: 'waiting_config',
    syonetDelivery: 'disabled',
  });
});

test('webhook returns 500 when persistence fails so Meta can retry', async (t) => {
  const server = await startServer(createDependencies({
    persistWebhook: async () => {
      throw new Error('test database unavailable');
    },
  }));
  t.after(server.close);

  const body = JSON.stringify(testPayload());
  const response = await fetch(`${server.baseUrl}/api/webhooks/meta`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signature(body),
    },
    body,
  });
  assert.equal(response.status, 500);
});

const adminUser = { id: 1, email: 'admin@example.test', name: 'Admin', role: 'admin' as const };
const sessionAuth = {
  authenticate: async (token: string | undefined) => (token === 'valid-session' ? adminUser : undefined),
  login: async (email: string, password: string) => (email === 'admin@example.test' && password === 'correta'
    ? { ok: true as const, token: 'valid-session', user: adminUser }
    : { ok: false as const, reason: email === 'locked@example.test' ? 'locked' as const : 'invalid' as const }),
  logout: async () => {},
};
const json = { 'content-type': 'application/json' };

test('login sets an HttpOnly session cookie and rejects invalid or locked credentials', async (t) => {
  const server = await startServer({ ...createDependencies(), auth: sessionAuth, listLeads: async () => [] });
  t.after(server.close);
  const url = `${server.baseUrl}/api/auth/login`;
  const post = (body: unknown, headers: Record<string, string> = json) =>
    fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });

  assert.equal((await post({ email: 'admin@example.test', password: 'errada' })).status, 401);
  assert.equal((await post({ email: 'locked@example.test', password: 'x' })).status, 429);
  assert.equal((await post({ email: 'admin@example.test' })).status, 400);
  // Formulário cross-site (sem application/json) é recusado.
  assert.equal((await post({ email: 'admin@example.test', password: 'correta' }, { 'content-type': 'text/plain' })).status, 415);

  const ok = await post({ email: 'admin@example.test', password: 'correta' });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie') ?? '';
  assert.match(cookie, /^sl_session=valid-session; Path=\/api; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/);
  assert.deepEqual(await ok.json(), { user: { email: 'admin@example.test', name: 'Admin', role: 'admin' } });

  const me = await fetch(`${server.baseUrl}/api/auth/me`, { headers: { cookie: 'sl_session=valid-session' } });
  assert.equal(me.status, 200);
  assert.equal((await fetch(`${server.baseUrl}/api/auth/me`)).status, 401);
});

test('dashboard endpoints require a session and pass the user to the data layer', async (t) => {
  const seen: Array<{ id?: string; role: string; remoteAddr?: string | null }> = [];
  const server = await startServer({
    ...createDependencies(),
    auth: sessionAuth,
    listLeads: async (user) => {
      seen.push({ role: user.role });
      return [{ leadgenId: '1' }] as never;
    },
    getLeadDetail: async (id, access) => {
      seen.push({ id, role: access.user.role, remoteAddr: access.remoteAddr });
      return id === '123' ? { lead: { leadgenId: id } } : undefined;
    },
  });
  t.after(server.close);
  const session = { cookie: 'sl_session=valid-session', 'x-forwarded-for': '203.0.113.7, 10.0.0.1' };

  assert.equal((await fetch(`${server.baseUrl}/api/dashboard/leads`)).status, 401);
  assert.equal((await fetch(`${server.baseUrl}/api/dashboard/leads`, { headers: { cookie: 'sl_session=forjado' } })).status, 401);
  assert.equal((await fetch(`${server.baseUrl}/api/dashboard/leads/123`)).status, 401);

  const list = await fetch(`${server.baseUrl}/api/dashboard/leads`, { headers: session });
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${server.baseUrl}/api/dashboard/leads`, { method: 'POST', headers: session })).status, 405);

  assert.equal((await fetch(`${server.baseUrl}/api/dashboard/leads/123`, { headers: session })).status, 200);
  assert.equal((await fetch(`${server.baseUrl}/api/dashboard/leads/999`, { headers: session })).status, 404);
  assert.equal((await fetch(`${server.baseUrl}/api/dashboard/leads/abc`, { headers: session })).status, 404);
  assert.deepEqual(seen, [
    { role: 'admin' },
    { id: '123', role: 'admin', remoteAddr: '203.0.113.7' },
    { id: '999', role: 'admin', remoteAddr: '203.0.113.7' },
  ]);
});

test('panel routes are hidden when authentication is not wired', async (t) => {
  const server = await startServer(createDependencies({ listLeads: async () => [] }));
  t.after(server.close);
  assert.equal((await fetch(`${server.baseUrl}/api/dashboard/leads`)).status, 404);
  assert.equal((await fetch(`${server.baseUrl}/api/auth/me`)).status, 404);
});
