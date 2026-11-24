import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  buildSyonetRequest,
  extractNormalizedLead,
  normalizeBrazilianPhone,
  resolveStoreAnswer,
  verifyMetaSignature,
} from './domain.js';

test('resolves form choices without accent or case differences', () => {
  assert.equal(resolveStoreAnswer('vw sao joao del rei')?.companyId, 1);
  assert.equal(resolveStoreAnswer('BYD UBÁ')?.companyId, 11);
});

test('keeps the inactive GM Ubá unit blocked', () => {
  const lead = {
    name: 'Lead de teste',
    email: 'teste@example.com',
    phone: '+5535999999999',
    storeAnswer: 'GM Ubá',
    media: 'FACEBOOK' as const,
    organicWithoutPlatform: false,
  };
  assert.throws(() => buildSyonetRequest(lead, 'test-lead', {
    formId: 'form-test',
    daysToUpdateOpenEvent: 30,
    eventGroup: 'OPORTUNIDADE',
    eventType: 'CONSORCIO WEB',
    source: 'TEST_SOURCE',
  }), /inativa/);
});

test('normalizes Brazilian phone numbers and rejects ambiguous lengths', () => {
  assert.equal(normalizeBrazilianPhone('(35) 99999-9999'), '+5535999999999');
  assert.equal(normalizeBrazilianPhone('+1 202 555 0184'), '+12025550184');
  assert.throws(() => normalizeBrazilianPhone('12345'), /formato brasileiro/);
});

test('extracts and maps the form response to the Syonet company', () => {
  const lead = extractNormalizedLead({
    id: 'lead-1',
    platform: 'fb',
    field_data: [
      { name: 'full_name', values: ['Pessoa Teste'] },
      { name: 'email', values: ['TESTE@example.com'] },
      { name: 'phone_number', values: ['(35) 99999-9999'] },
      { name: 'por_qual_loja_quer_ser_atendido', values: ['GM Lavras'] },
    ],
  });
  assert.equal(lead.email, 'teste@example.com');
  assert.equal(lead.phone, '+5535999999999');
  assert.equal(lead.media, 'FACEBOOK');
  const request = buildSyonetRequest(lead, 'lead-1', {
    formId: 'form-test',
    daysToUpdateOpenEvent: 30,
    eventGroup: 'OPORTUNIDADE',
    eventType: 'CONSORCIO WEB',
    source: 'TEST_SOURCE',
  });
  assert.equal(request.event.companyId, 6);
  assert.equal(request.daysToUpdateOpenEvent, 30);
  assert.equal(request.event.media, 'FACEBOOK');
  assert.equal(request.event.source, 'TEST_SOURCE');
  assert.deepEqual(request.customer.phones, [{ ddd: 35, numero: 999999999 }]);
});

test('combines first and last name when Meta does not return full_name', () => {
  const lead = extractNormalizedLead({
    id: 'lead-2',
    platform: 'ig',
    field_data: [
      { name: 'first_name', values: ['Maria'] },
      { name: 'last_name', values: ['de Souza'] },
      { name: 'email', values: ['maria@example.com'] },
      { name: 'phone_number', values: ['5535999999999'] },
      { name: 'store_choice', values: ['BYD Ubá'] },
    ],
  });
  assert.equal(lead.name, 'Maria de Souza');
  assert.equal(lead.phone, '+5535999999999');
  assert.equal(lead.media, 'INSTAGRAM');
});

test('lead without platform or ad_id is not blocked: it goes on without media', () => {
  const base = {
    id: 'lead-3',
    field_data: [
      { name: 'full_name', values: ['Pessoa Teste'] },
      { name: 'email', values: ['teste@example.com'] },
      { name: 'phone_number', values: ['(35) 99999-9999'] },
      { name: 'store_choice', values: ['VW Lavras'] },
    ],
  };
  for (const extra of [{}, { is_organic: true }, { is_organic: false }, { is_organic: true, ad_id: '123' }]) {
    const lead = extractNormalizedLead({ ...base, ...extra });
    assert.equal(lead.media, undefined);
    assert.equal(lead.organicWithoutPlatform, true);
    const request = buildSyonetRequest(lead, 'lead-3', {
      formId: 'form-test', daysToUpdateOpenEvent: 30, eventGroup: 'G', eventType: 'T', source: 'S',
    });
    assert.equal('media' in request.event, false, 'media is omitted, never invented');
  }
  const withPlatform = extractNormalizedLead({ ...base, platform: 'ig' });
  assert.equal(withPlatform.media, 'INSTAGRAM');
  assert.equal(withPlatform.organicWithoutPlatform, false);
});

test('still rejects a lead without name, e-mail, phone or store', () => {
  assert.throws(() => extractNormalizedLead({
    id: 'lead-5',
    platform: 'fb',
    field_data: [{ name: 'full_name', values: ['Pessoa Teste'] }],
  }), /nome, e-mail, telefone ou loja/);
});

test('verifies Meta SHA-256 signatures against the original body', () => {
  const secret = 'app-secret-test-only';
  const body = Buffer.from('{"object":"page"}');
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifyMetaSignature(body, signature, secret), true);
  assert.equal(verifyMetaSignature(Buffer.from('tampered'), signature, secret), false);
  assert.equal(verifyMetaSignature(body, undefined, secret), false);
});
