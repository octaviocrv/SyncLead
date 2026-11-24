import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSyonetAuthHeaders, sendToSyonet, type SyonetSendConfiguration } from './worker.js';
import { startSyonetMock, type SyonetMockScenario } from './test-support/syonet-mock.js';
import type { SyonetLeadRequest } from './domain.js';

const requestBody: SyonetLeadRequest = {
  customer: { name: 'Pessoa Sintética', emails: ['synthetic@example.test'], phones: [{ ddd: 35, numero: 900000000 }] },
  event: {
    companyId: 3,
    eventGroup: 'group',
    eventType: 'type',
    source: 'source',
    media: 'FACEBOOK',
    comment: 'synthetic',
    leadInfo: {},
  },
  daysToUpdateOpenEvent: 0,
};

function configFor(url: string, overrides: Partial<SyonetSendConfiguration> = {}): SyonetSendConfiguration {
  return {
    apiUrl: url,
    auth: { mode: 'apikey', apiKey: 'fake-key' },
    eventGroup: 'group',
    eventType: 'type',
    source: 'source',
    daysToUpdateOpenEvent: 0,
    ...overrides,
  };
}

async function outcomeFor(scenario: SyonetMockScenario, overrides: Partial<SyonetSendConfiguration> = {}) {
  const mock = await startSyonetMock();
  mock.scenario = scenario;
  try {
    const result = await sendToSyonet(requestBody, configFor(mock.url, overrides)).then(
      (eventId) => ({ eventId }),
      (error: { outcome: string; stage: string; message: string }) => ({
        outcome: error.outcome,
        stage: error.stage,
        message: error.message,
      }),
    );
    return { result, mock };
  } finally {
    await mock.close();
  }
}

test('sends apikey or Basic authentication according to the configured mode', async () => {
  assert.deepEqual(buildSyonetAuthHeaders({ mode: 'apikey', apiKey: 'k' }), { apikey: 'k' });
  assert.deepEqual(buildSyonetAuthHeaders({ mode: 'basic', username: 'user', password: 'pa:ss' }), {
    Authorization: `Basic ${Buffer.from('user:pa:ss').toString('base64')}`,
  });

  const apikey = await outcomeFor('ok');
  assert.equal(apikey.mock.requests[0].headers.apikey, 'fake-key');
  assert.equal(apikey.mock.requests[0].headers.authorization, undefined);

  const basic = await outcomeFor('ok', { auth: { mode: 'basic', username: 'u', password: 'p' } });
  assert.equal(basic.mock.requests[0].headers.authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
  assert.equal(basic.mock.requests[0].headers.apikey, undefined);
});

test('200 confirmed returns the Syonet event id', async () => {
  const { result, mock } = await outcomeFor('ok');
  assert.deepEqual(result, { eventId: '987654' });
  assert.equal(mock.requests.length, 1);
});

test('decodes ISO-8859-1 responses', async () => {
  const { result } = await outcomeFor('iso-8859-1');
  assert.deepEqual(result, { eventId: 'Lançamento-É-123' });
});

test('401 is blocked with an authentication cause', async () => {
  const { result } = await outcomeFor('unauthorized');
  assert.deepEqual({ ...result, message: undefined }, { outcome: 'blocked', stage: 'syonet_auth', message: undefined });
  assert.match((result as { message: string }).message, /authentication failed/i);
});

test('412 is a permanent validation failure with the decoded Syonet message', async () => {
  const { result } = await outcomeFor('precondition-failed');
  const error = result as { outcome: string; stage: string; message: string };
  assert.equal(error.outcome, 'failed');
  assert.equal(error.stage, 'syonet_validation');
  assert.match(error.message, /412.*validation/i);
  assert.match(error.message, /Telefone inválido/);
});

test('429 is the only retryable Syonet response', async () => {
  const { result } = await outcomeFor('rate-limited');
  assert.equal((result as { outcome: string }).outcome, 'retry');
});

test('5xx, timeout, malformed and unconfirmed responses are ambiguous and never retried', async () => {
  for (const scenario of ['server-error', 'malformed', 'not-confirmed'] as const) {
    const { result, mock } = await outcomeFor(scenario);
    assert.equal((result as { outcome: string }).outcome, 'ambiguous', scenario);
    assert.equal(mock.requests.length, 1, scenario);
  }
  const timeout = await outcomeFor('timeout', { timeoutMs: 150 });
  assert.equal((timeout.result as { outcome: string }).outcome, 'ambiguous');
  assert.equal(timeout.mock.requests.length, 1);
});

test('network error is ambiguous', async () => {
  const mock = await startSyonetMock();
  const url = mock.url;
  await mock.close();
  await assert.rejects(sendToSyonet(requestBody, configFor(url)), (error: { outcome: string }) => error.outcome === 'ambiguous');
});

test('403 (event type without Web Service permission) is blocked, not retried', async () => {
  const { result, mock } = await outcomeFor('forbidden');
  const error = result as { outcome: string; stage: string; message: string };
  assert.equal(error.outcome, 'blocked');
  assert.equal(error.stage, 'syonet_permission');
  assert.match(error.message, /permission to execute Web Service/);
  assert.equal(mock.requests.length, 1);
});

test('500 documented customer error is ambiguous, keeps the Syonet message and is never retried', async () => {
  const { result, mock } = await outcomeFor('customer-error');
  const error = result as { outcome: string; message: string };
  assert.equal(error.outcome, 'ambiguous');
  assert.match(error.message, /Error to process customer/);
  assert.equal(mock.requests.length, 1);
});
