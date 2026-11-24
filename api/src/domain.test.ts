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

test('rejects leads without the Facebook/Instagram source instead of guessing media', () => {
  assert.throws(() => extractNormalizedLead({
    id: 'lead-3',
    field_data: [
      { name: 'full_name', values: ['Pessoa Teste'] },
      { name: 'email', values: ['teste@example.com'] },
      { name: 'phone_number', values: ['(35) 99999-9999'] },
      { name: 'store_choice', values: ['VW Lavras'] },
    ],
  }), /plataforma reconhecida/);
});

test('accepts a lead without platform only when Meta marks it as organic', () => {
  const base = {
    id: 'lead-4',
    field_data: [
      { name: 'full_name', values: ['Pessoa Teste'] },
      { name: 'email', values: ['teste@example.com'] },
      { name: 'phone_number', values: ['(35) 99999-9999'] },
      { name: 'store_choice', values: ['VW Lavras'] },
    ],
  };
  const organic = extractNormalizedLead({ ...base, is_organic: true });
  assert.equal(organic.organicWithoutPlatform, true);
  assert.equal(organic.media, undefined);
  assert.throws(() => buildSyonetRequest(organic, 'lead-4', {
    formId: 'form-test', daysToUpdateOpenEvent: 30, eventGroup: 'G', eventType: 'T', source: 'S',
  }), /sem plataforma/);
  assert.throws(() => extractNormalizedLead({ ...base, is_organic: false }), /plataforma reconhecida/);
  assert.throws(() => extractNormalizedLead({ ...base, is_organic: true, ad_id: '123' }), /plataforma reconhecida/);
});

test('verifies Meta SHA-256 signatures against the original body', () => {
  const secret = 'app-secret-test-only';
  const body = Buffer.from('{"object":"page"}');
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifyMetaSignature(body, signature, secret), true);
  assert.equal(verifyMetaSignature(Buffer.from('tampered'), signature, secret), false);
  assert.equal(verifyMetaSignature(body, undefined, secret), false);
});
