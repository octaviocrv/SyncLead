import type { Pool } from 'pg';
import { buildSyonetRequest, extractNormalizedLead, getFieldValue, resolveStoreAnswer } from './domain.js';
import type { MetaLeadResponse, NormalizedLead } from './types.js';

export type MetaFieldData = NonNullable<MetaLeadResponse['field_data']>;

export interface RetentionPolicy {
  sentDays: number;
  unsentDays: number;
  operationalMonths: number;
}

export const defaultRetentionPolicy: RetentionPolicy = { sentDays: 30, unsentDays: 90, operationalMonths: 24 };

export interface SyonetPreviewOptions {
  formId: string;
  eventGroup?: string;
  eventType?: string;
  source?: string;
  daysToUpdateOpenEvent?: number;
  phoneFormat?: 'ddd_numero' | 'e164';
}

// Grava apenas field_data (única cópia de PII) e metadados não pessoais da Meta.
export async function saveLeadCapture(pool: Pool, leadgenId: string, metaLead: MetaLeadResponse): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO lead_personal_data (leadgen_id, field_data)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (leadgen_id) DO UPDATE SET field_data = EXCLUDED.field_data, captured_at = NOW()`,
      [leadgenId, JSON.stringify(metaLead.field_data ?? [])],
    );
    await client.query(
      `UPDATE leads SET meta_platform = $2, meta_is_organic = $3 WHERE leadgen_id = $1`,
      [leadgenId, metaLead.platform?.trim() || null, metaLead.is_organic ?? null],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function saveSyonetExchange(
  pool: Pool,
  leadgenId: string,
  requestBody: unknown,
  response: { status: number; body: string | null } | undefined,
): Promise<void> {
  let parsedBody: unknown = response?.body ?? null;
  try {
    if (response?.body) parsedBody = JSON.parse(response.body);
  } catch {
    // Mantém o texto bruto quando a resposta não é JSON.
  }
  await pool.query(
    `UPDATE lead_personal_data
     SET syonet_request = $2::jsonb, syonet_response = $3::jsonb, syonet_exchanged_at = NOW()
     WHERE leadgen_id = $1`,
    [
      leadgenId,
      JSON.stringify(requestBody),
      JSON.stringify(response ? { httpStatus: response.status, body: parsedBody } : { httpStatus: null, body: 'Sem resposta (erro de rede/timeout).' }),
    ],
  );
}

export function maskEmail(email: string | undefined): string | null {
  if (!email) return null;
  const [user, domain] = email.split('@');
  if (!domain) return '•••';
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${user.slice(0, 2)}•••@${host.slice(0, 1)}•••${tld}`;
}

export function maskPhone(phone: string | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return '•••';
  const local = digits.startsWith('55') && digits.length >= 12 ? digits.slice(2) : digits;
  return `(${local.slice(0, 2)}) •••••-••${local.slice(-2)}`;
}

function contactFrom(fieldData: MetaFieldData) {
  const lead: MetaLeadResponse = { id: '', field_data: fieldData };
  const fullName = getFieldValue(lead, ['full_name', 'nome_completo']);
  const name = fullName ?? [getFieldValue(lead, ['first_name', 'nome']), getFieldValue(lead, ['last_name', 'sobrenome'])]
    .filter(Boolean)
    .join(' ');
  return {
    name: name || undefined,
    email: getFieldValue(lead, ['email', 'e_mail'])?.toLowerCase(),
    phone: getFieldValue(lead, ['phone_number', 'phone', 'telefone', 'numero_de_telefone', 'mobile_phone']),
  };
}

export function maskedContact(fieldData: MetaFieldData | null) {
  if (!fieldData) return { name: null, phoneMasked: null, emailMasked: null };
  const contact = contactFrom(fieldData);
  return {
    name: contact.name ?? null,
    phoneMasked: maskPhone(contact.phone),
    emailMasked: maskEmail(contact.email),
  };
}

const notConfigured = (name: string) => `<${name} não configurado>`;

// Reaplica as mesmas funções puras do worker sobre o field_data salvo. Nunca chama o Syonet.
export function diagnoseLead(
  leadgenId: string,
  capture: { fieldData: MetaFieldData; platform: string | null; isOrganic: boolean | null; adId: string | null },
  options: SyonetPreviewOptions,
) {
  const metaLead: MetaLeadResponse = {
    id: leadgenId,
    field_data: capture.fieldData,
    platform: capture.platform ?? undefined,
    is_organic: capture.isOrganic ?? undefined,
    ad_id: capture.adId ?? undefined,
  };

  let normalized: NormalizedLead;
  try {
    normalized = extractNormalizedLead(metaLead);
  } catch (error) {
    return {
      normalized: null,
      normalizationError: error instanceof Error ? error.message : 'Falha na normalização.',
      store: null,
      syonetPreview: null,
      syonetBlockers: [] as string[],
      missingConfig: [] as string[],
    };
  }

  const mapping = resolveStoreAnswer(normalized.storeAnswer);
  const missingConfig = [
    !options.eventGroup && 'SYONET_EVENT_GROUP',
    !options.eventType && 'SYONET_EVENT_TYPE',
    !options.source && 'SYONET_SOURCE',
    options.daysToUpdateOpenEvent === undefined && 'SYONET_DAYS_TO_UPDATE_OPEN_EVENT',
  ].filter((item): item is string => Boolean(item));

  const syonetBlockers: string[] = [];
  if (!mapping) syonetBlockers.push('A resposta de loja não está mapeada para uma empresa Syonet.');
  else if (!mapping.active) syonetBlockers.push(`A loja "${mapping.answer}" está inativa no mapeamento do Syonet.`);
  if (!normalized.media) {
    syonetBlockers.push(
      normalized.organicWithoutPlatform
        ? 'Lead orgânico/teste sem plataforma: nunca é enviado ao Syonet.'
        : 'Plataforma (Facebook/Instagram) não identificada.',
    );
  }

  let syonetPreview: unknown = null;
  if (mapping?.active) {
    try {
      // Placeholders só para exibir o formato; bloqueios ficam listados em syonetBlockers.
      syonetPreview = buildSyonetRequest(
        { ...normalized, media: normalized.media ?? ('<plataforma ausente>' as NormalizedLead['media']) },
        leadgenId,
        {
          formId: options.formId,
          eventGroup: options.eventGroup || notConfigured('SYONET_EVENT_GROUP'),
          eventType: options.eventType || notConfigured('SYONET_EVENT_TYPE'),
          source: options.source || notConfigured('SYONET_SOURCE'),
          daysToUpdateOpenEvent: options.daysToUpdateOpenEvent ?? (null as unknown as number),
          phoneFormat: options.phoneFormat,
        },
      );
    } catch (error) {
      syonetBlockers.push(error instanceof Error ? error.message : 'Falha ao montar o payload do Syonet.');
    }
  }

  return {
    normalized,
    normalizationError: null,
    store: mapping ? { answer: mapping.answer, companyId: mapping.companyId, active: mapping.active } : null,
    syonetPreview,
    syonetBlockers,
    missingConfig,
  };
}

export function purgeAfterSql(policy: RetentionPolicy): string {
  return `CASE WHEN l.status = 'sent' THEN l.updated_at + INTERVAL '${policy.sentDays} days'
               ELSE p.captured_at + INTERVAL '${policy.unsentDays} days' END`;
}

export async function purgeExpiredData(pool: Pool, policy: RetentionPolicy) {
  const personal = await pool.query(
    `DELETE FROM lead_personal_data p USING leads l
     WHERE p.leadgen_id = l.leadgen_id AND ${purgeAfterSql(policy)} < NOW()`,
  );
  const operational = await pool.query(
    `DELETE FROM leads
     WHERE received_at < NOW() - make_interval(months => $1)
       AND status NOT IN ('received', 'processing', 'retry')`,
    [policy.operationalMonths],
  );
  const accessLog = await pool.query(
    `DELETE FROM data_access_log WHERE accessed_at < NOW() - make_interval(months => 12)`,
  );
  return {
    personalData: personal.rowCount ?? 0,
    leads: operational.rowCount ?? 0,
    accessLog: accessLog.rowCount ?? 0,
  };
}
