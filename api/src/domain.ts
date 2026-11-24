import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MetaLeadResponse, NormalizedLead } from './types.js';

export interface StoreMapping {
  answer: string;
  companyId: number;
  active: boolean;
}

export const storeMappings: StoreMapping[] = [
  { answer: 'VW São João Del Rei', companyId: 1, active: true },
  { answer: 'VW Alfenas', companyId: 2, active: true },
  { answer: 'VW Lavras', companyId: 3, active: true },
  { answer: 'VW Varginha', companyId: 4, active: true },
  { answer: 'VW Itajubá', companyId: 5, active: true },
  { answer: 'GM Lavras', companyId: 6, active: true },
  { answer: 'GM Varginha', companyId: 7, active: true },
  { answer: 'GM Ubá', companyId: 8, active: false },
  { answer: 'GM Barbacena', companyId: 9, active: true },
  { answer: 'GM São João Del Rey', companyId: 10, active: true },
  { answer: 'BYD Ubá', companyId: 11, active: true },
];

export function normalizeAnswer(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .toLocaleLowerCase('pt-BR');
}

export function resolveStoreAnswer(value: string): StoreMapping | undefined {
  const normalized = normalizeAnswer(value);
  return storeMappings.find((mapping) => normalizeAnswer(mapping.answer) === normalized);
}

export function getFieldValue(lead: MetaLeadResponse, names: string[]): string | undefined {
  const field = lead.field_data?.find((item) =>
    names.includes(normalizeAnswer(item.name).replaceAll(' ', '_')),
  );
  const value = field?.values?.[0];
  return value === undefined || value === null ? undefined : String(value).trim();
}

export function extractNormalizedLead(lead: MetaLeadResponse): NormalizedLead {
  const firstName = getFieldValue(lead, ['first_name', 'nome']);
  const lastName = getFieldValue(lead, ['last_name', 'sobrenome']);
  const name =
    getFieldValue(lead, ['full_name', 'nome_completo']) ??
    [firstName, lastName].filter(Boolean).join(' ');
  const email = getFieldValue(lead, ['email', 'e_mail']);
  const phone = getFieldValue(lead, [
    'phone_number',
    'phone',
    'telefone',
    'numero_de_telefone',
    'mobile_phone',
  ]);
  const store = lead.field_data?.find((field) =>
    field.values?.some((value) => resolveStoreAnswer(String(value)) !== undefined),
  )?.values?.find((value) => resolveStoreAnswer(String(value)) !== undefined);
  const platform = lead.platform?.trim().toLowerCase();
  const media =
    platform === 'fb' || platform === 'facebook'
      ? 'FACEBOOK'
      : platform === 'ig' || platform === 'instagram'
        ? 'INSTAGRAM'
        : undefined;

  // platform/ad_id ausentes não bloqueiam: o lead segue sem mídia e o painel registra que a origem
  // detalhada não foi informada pela Meta.
  const organicWithoutPlatform = !media;
  if (!name || !email || !phone || store === undefined) {
    throw new Error('Lead sem nome, e-mail, telefone ou loja válidos.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('O e-mail do lead não está em um formato válido.');
  }

  return {
    name,
    email: email.toLowerCase(),
    phone: normalizeBrazilianPhone(phone),
    storeAnswer: String(store),
    media,
    organicWithoutPlatform,
  };
}

export function normalizeBrazilianPhone(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');

  if (trimmed.startsWith('+')) {
    if (digits.length < 10 || digits.length > 15) {
      throw new Error('Telefone em formato internacional inválido.');
    }
    return `+${digits}`;
  }

  if (digits.startsWith('00')) {
    const international = digits.slice(2);
    if (international.length < 10 || international.length > 15) {
      throw new Error('Telefone em formato internacional inválido.');
    }
    return `+${international}`;
  }

  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
    return `+${digits}`;
  }

  throw new Error('Telefone não está em um formato brasileiro reconhecido.');
}

export interface SyonetLeadRequest {
  customer: {
    name: string;
    emails: string[];
    phones: Array<{ ddd: number; numero: number } | { e164Number: string }>;
  };
  event: {
    companyId: number;
    eventGroup: string;
    eventType: string;
    source: string;
    media?: string;
    comment: string;
    leadInfo: Record<string, Record<string, string>>;
  };
  daysToUpdateOpenEvent: number;
}

export function buildSyonetRequest(
  lead: NormalizedLead,
  leadgenId: string,
  options: {
    formId: string;
    daysToUpdateOpenEvent: number;
    eventGroup: string;
    eventType: string;
    source: string;
    phoneFormat?: 'ddd_numero' | 'e164';
  },
): SyonetLeadRequest {
  const store = resolveStoreAnswer(lead.storeAnswer);
  if (!store) {
    throw new Error('A resposta de loja não está mapeada para uma empresa Syonet.');
  }
  if (!store.active) {
    throw new Error(`A loja "${store.answer}" está inativa no mapeamento do Syonet.`);
  }
  const phone = options.phoneFormat === 'e164'
    ? { e164Number: lead.phone }
    : toSyonetPhone(lead.phone);

  return {
    customer: {
      name: lead.name,
      emails: [lead.email],
      phones: [phone],
    },
    event: {
      companyId: store.companyId,
      eventGroup: options.eventGroup,
      eventType: options.eventType,
      source: options.source,
      ...(lead.media ? { media: lead.media } : {}),
      comment: `Leads Tráfego Pago. Lead ID: ${leadgenId}. Loja escolhida: ${store.answer}.`,
      leadInfo: {
        'Origem Meta': {
          leadgen_id: leadgenId,
          form_id: options.formId,
          loja_escolhida: store.answer,
        },
      },
    },
    daysToUpdateOpenEvent: options.daysToUpdateOpenEvent,
  };
}

function toSyonetPhone(phone: string): { ddd: number; numero: number } {
  const digits = phone.replace(/\D/g, '');
  const brazilianNumber = digits.startsWith('55') ? digits.slice(2) : '';
  if (brazilianNumber.length !== 10 && brazilianNumber.length !== 11) {
    throw new Error('A API Lead do Syonet requer telefone brasileiro com DDD.');
  }

  return {
    ddd: Number(brazilianNumber.slice(0, 2)),
    numero: Number(brazilianNumber.slice(2)),
  };
}

export function verifyMetaSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header || !/^sha256=[a-f0-9]{64}$/i.test(header)) return false;
  const expected = Buffer.from(`sha256=${createHmacHex(appSecret, rawBody)}`, 'utf8');
  const received = Buffer.from(header.toLowerCase(), 'utf8');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function createHmacHex(secret: string, payload: Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

