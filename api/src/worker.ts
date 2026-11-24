import type { Pool } from 'pg';
import { claimLead, recoverStaleLeads, updateLead } from './database.js';
import { buildSyonetRequest, extractNormalizedLead, resolveStoreAnswer } from './domain.js';
import type { LeadStatus, MetaLeadResponse, PersistedLead } from './types.js';
import type { SyonetLeadRequest } from './domain.js';
import { saveLeadCapture, saveSyonetExchange } from './personal-data.js';

const MAX_ATTEMPTS = 5;

export type SyonetAuthConfiguration =
  | { mode: 'apikey'; apiKey: string }
  | { mode: 'basic'; username: string; password: string };

export interface SyonetSendConfiguration {
  apiUrl: string;
  auth: SyonetAuthConfiguration;
  eventGroup: string;
  eventType: string;
  source: string;
  daysToUpdateOpenEvent: number;
  phoneFormat?: 'ddd_numero' | 'e164';
  timeoutMs?: number;
  // Homologação: quando preenchida, só estes leadgen_id podem ser enviados.
  onlyLeadgenIds?: string[];
  // Homologação: mídia aplicada apenas a leads liberados que são orgânicos/teste sem plataforma.
  homologationMedia?: 'FACEBOOK' | 'INSTAGRAM';
}

export function syonetConfigurationFor(
  leadgenId: string,
  syonet: SyonetSendConfiguration | undefined,
  access: { sendHold?: boolean; authorized?: boolean } = {},
): SyonetSendConfiguration | undefined {
  // Webhook e reconciliação seguem a mesma regra. Só um lead explicitamente retido (send_hold)
  // precisa de autorização de um admin; a reconciliação não aplica mais hold.
  if (!syonet) return undefined;
  if (!access.authorized && access.sendHold) return undefined;
  if (syonet.onlyLeadgenIds?.length && !syonet.onlyLeadgenIds.includes(leadgenId)) return undefined;
  return syonet;
}

export interface WorkerConfiguration {
  metaPageAccessToken: string;
  metaGraphApiVersion: string;
  metaFormId: string;
  syonet?: SyonetSendConfiguration;
}

class ProcessingError extends Error {
  constructor(
    message: string,
    readonly outcome: 'retry' | 'failed' | 'blocked' | 'ambiguous',
    readonly stage = 'processing',
  ) {
    super(message);
  }
}

export async function fetchMetaLead(leadgenId: string, workerConfig: WorkerConfiguration): Promise<MetaLeadResponse> {
  const url = new URL(
    `https://graph.facebook.com/${workerConfig.metaGraphApiVersion}/${encodeURIComponent(leadgenId)}`,
  );
  url.searchParams.set('access_token', workerConfig.metaPageAccessToken);
  url.searchParams.set('fields', 'id,field_data,platform,is_organic,ad_id');

  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new ProcessingError('Meta Graph API could not be reached.', 'retry', 'meta_fetch');
  }

  if (response.status === 429 || response.status >= 500) {
    throw new ProcessingError(`Meta Graph API returned HTTP ${response.status}.`, 'retry', 'meta_fetch');
  }
  if (response.status === 401 || response.status === 403) {
    throw new ProcessingError('Meta access token or lead access permissions are invalid.', 'blocked', 'meta_fetch');
  }
  if (!response.ok) {
    throw new ProcessingError(`Meta Graph API rejected the lead (HTTP ${response.status}).`, 'failed', 'meta_fetch');
  }

  const data = (await response.json()) as MetaLeadResponse;
  if (!data.id || !Array.isArray(data.field_data)) {
    throw new ProcessingError('Meta returned an incomplete lead record.', 'failed', 'meta_fetch');
  }
  return data;
}

export function buildSyonetAuthHeaders(auth: SyonetAuthConfiguration): Record<string, string> {
  if (auth.mode === 'basic') {
    const credentials = Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64');
    return { Authorization: `Basic ${credentials}` };
  }
  return { apikey: auth.apiKey };
}

export async function sendToSyonet(
  requestBody: SyonetLeadRequest,
  syonetConfig: SyonetSendConfiguration,
  onResponse?: (status: number, body: string | null) => void,
): Promise<string> {
  const url = new URL(syonetConfig.apiUrl);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        ...buildSyonetAuthHeaders(syonetConfig.auth),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(syonetConfig.timeoutMs ?? 20_000),
    });
  } catch {
    throw new ProcessingError(
      'Syonet request outcome is unknown after a network error; manual review is required to avoid a duplicate.',
      'ambiguous',
      'syonet',
    );
  }

  if (response.status === 429) {
    onResponse?.(response.status, null);
    throw new ProcessingError('Syonet rate-limited the request; it can be retried.', 'retry');
  }

  let responseText: string;
  try {
    responseText = new TextDecoder('iso-8859-1').decode(await response.arrayBuffer());
  } catch {
    throw new ProcessingError(
      'Syonet response could not be read; manual review is required before retry.',
      'ambiguous',
      'syonet',
    );
  }
  onResponse?.(response.status, responseText);

  if (response.status === 401) {
    throw new ProcessingError(
      'Syonet authentication failed (HTTP 401): the credentials or authentication mode are invalid. Fix SYONET_AUTH_MODE and the credentials before reprocessing.',
      'blocked',
      'syonet_auth',
    );
  }
  if (response.status >= 500) {
    // Documentado: 500 = "Error to process customer" ou "Error to create event". O cliente pode ter sido criado; sem reenvio automático.
    throw new ProcessingError(
      `Syonet returned HTTP ${response.status}${describeSyonetMessage(responseText)}; manual review is required before retry to avoid a duplicate.`,
      'ambiguous',
      'syonet',
    );
  }
  if (response.status === 403) {
    throw new ProcessingError(
      `Syonet denied the request (HTTP 403): the event group/type is not allowed to run via Web Service${describeSyonetMessage(responseText)}. Enable it in the CRM before reprocessing.`,
      'blocked',
      'syonet_permission',
    );
  }
  if (response.status === 412) {
    throw new ProcessingError(
      `Syonet rejected the lead data (HTTP 412, validation error)${describeSyonetMessage(responseText)}.`,
      'failed',
      'syonet_validation',
    );
  }
  if (!response.ok) {
    throw new ProcessingError(`Syonet rejected the lead (HTTP ${response.status}).`, 'failed', 'syonet');
  }

  let result: { ok?: number; msg?: string; err?: number };
  try {
    result = JSON.parse(responseText) as { ok?: number; msg?: string; err?: number };
  } catch {
    throw new ProcessingError(
      'Syonet response could not be interpreted; manual review is required.',
      'ambiguous',
      'syonet',
    );
  }

  if (result.ok !== 1 || !result.msg) {
    throw new ProcessingError(
      'Syonet did not confirm event creation; manual review is required.',
      'ambiguous',
      'syonet',
    );
  }
  return result.msg;
}

function describeSyonetMessage(responseText: string): string {
  try {
    const { msg } = JSON.parse(responseText) as { msg?: unknown };
    if (typeof msg === 'string' && msg.trim()) return `: ${msg.trim().slice(0, 200)}`;
  } catch {
    // The body is informational only for rejected requests.
  }
  return '';
}

function retryDelaySeconds(attempt: number): number {
  return Math.min(30 * 2 ** (attempt - 1), 30 * 60);
}

async function processLead(
  pool: Pool,
  lead: PersistedLead,
  workerConfig: WorkerConfiguration,
): Promise<void> {
  if (lead.form_id !== workerConfig.metaFormId) {
    await updateLead(pool, lead.leadgen_id, 'blocked', 'Form ID is not configured for this integration.', {
      stage: 'form_validation',
    });
    return;
  }

  let metaLead: MetaLeadResponse;
  try {
    metaLead = await fetchMetaLead(lead.leadgen_id, workerConfig);
    await updateLead(pool, lead.leadgen_id, 'processing', 'Complete lead data retrieved from Meta.', {
      stage: 'meta_fetch',
    });
  } catch (error) {
    await handleError(pool, lead, error);
    return;
  }

  // Falha ao guardar a cópia para o painel não pode alterar o fluxo do lead.
  try {
    await saveLeadCapture(pool, lead.leadgen_id, metaLead);
  } catch (error) {
    console.error(`Could not store personal data for lead ${lead.leadgen_id}:`, error instanceof Error ? error.message : 'unknown error');
  }

  const syonet = syonetConfigurationFor(lead.leadgen_id, workerConfig.syonet, {
    sendHold: lead.send_hold,
    authorized: lead.send_authorized,
  });
  let normalized;
  let mapping;
  let requestBody: SyonetLeadRequest;
  try {
    normalized = extractNormalizedLead(metaLead);
    await updateLead(pool, lead.leadgen_id, 'processing', 'Lead fields normalized.', {
      stage: 'normalization',
    });
    mapping = resolveStoreAnswer(normalized.storeAnswer);
    if (!mapping) {
      throw new ProcessingError('Selected store is not mapped to a Syonet company.', 'blocked', 'routing');
    }
    if (!mapping.active) {
      throw new ProcessingError(
        `Selected store "${mapping.answer}" is marked inactive and was not sent to Syonet.`,
        'blocked',
        'routing',
      );
    }
    if (!syonet) {
      await updateLead(pool, lead.leadgen_id, 'waiting_config', lead.send_hold && !lead.send_authorized
        ? 'Meta lead retrieved, normalized, and routed; held outside automatic sending.'
        : 'Meta lead retrieved, normalized, and routed; Syonet delivery is disabled.', {
        companyId: mapping.companyId,
        storeAnswer: normalized.storeAnswer,
        stage: 'meta_validation',
        metaProcessed: true,
      });
      return;
    }

    if (normalized.organicWithoutPlatform && syonet.onlyLeadgenIds?.length && syonet.homologationMedia) {
      normalized = { ...normalized, media: syonet.homologationMedia, organicWithoutPlatform: false };
    }

    await updateLead(pool, lead.leadgen_id, 'processing', normalized.media
      ? 'Selected store is mapped to an active Syonet company.'
      : 'Selected store is mapped to an active Syonet company; platform not informed by Meta.', {
      companyId: mapping.companyId,
      storeAnswer: normalized.storeAnswer,
      stage: 'routing',
      metaProcessed: true,
    });
    requestBody = buildSyonetRequest(normalized, lead.leadgen_id, {
      formId: workerConfig.metaFormId,
      daysToUpdateOpenEvent: syonet.daysToUpdateOpenEvent,
      eventGroup: syonet.eventGroup,
      eventType: syonet.eventType,
      source: syonet.source,
      phoneFormat: syonet.phoneFormat,
    });
  } catch (error) {
    await handleError(pool, lead, error);
    return;
  }

  let syonetResponse: { status: number; body: string | null } | undefined;
  try {
    if (!syonet) return;
    const eventId = await sendToSyonet(requestBody, syonet, (status, body) => {
      syonetResponse = { status, body };
    });
    await updateLead(pool, lead.leadgen_id, 'sent', 'Syonet confirmed event creation.', {
      companyId: mapping.companyId,
      eventId,
      storeAnswer: normalized.storeAnswer,
      stage: 'syonet',
    });
  } catch (error) {
    await handleError(pool, lead, error, {
      companyId: mapping.companyId,
      storeAnswer: normalized.storeAnswer,
    });
  } finally {
    if (syonet) {
      await saveSyonetExchange(pool, lead.leadgen_id, requestBody, syonetResponse).catch((error: unknown) => {
        console.error(`Could not store Syonet exchange for lead ${lead.leadgen_id}:`, error instanceof Error ? error.message : 'unknown error');
      });
    }
  }
}

async function handleError(
  pool: Pool,
  lead: PersistedLead,
  error: unknown,
  details: { companyId?: number; storeAnswer?: string } = {},
): Promise<void> {
  const processingError =
    error instanceof ProcessingError
      ? error
      : new ProcessingError(
          error instanceof Error ? error.message : 'Unexpected processing error.',
          'failed',
          'normalization',
        );
  const outcome = processingError.outcome;
  const shouldRetry = outcome === 'retry' && lead.attempts < MAX_ATTEMPTS;
  const status: LeadStatus = shouldRetry ? 'retry' : outcome === 'retry' ? 'failed' : outcome;

  await updateLead(pool, lead.leadgen_id, status, processingError.message, {
    ...details,
    stage: processingError.stage,
    retryAfterSeconds: shouldRetry ? retryDelaySeconds(lead.attempts) : undefined,
  });
}

export async function runWorker(
  pool: Pool,
  workerConfig: WorkerConfiguration,
  signal: AbortSignal,
): Promise<void> {
  if (!workerConfig.metaPageAccessToken) return;

  let lastRecovery = Date.now();
  while (!signal.aborted) {
    try {
      if (Date.now() - lastRecovery >= 60_000) {
        await recoverStaleLeads(pool);
        lastRecovery = Date.now();
      }
      const lead = await claimLead(pool, true, Boolean(workerConfig.syonet), workerConfig.syonet?.onlyLeadgenIds);
      if (lead) {
        await processLead(pool, lead, workerConfig);
        continue;
      }
    } catch (error) {
      console.error('Lead worker iteration failed:', error);
    }

    await new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const timeout = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, 1_000);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
