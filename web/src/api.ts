import { notifyUnauthorized } from './auth';
import { formStoreMappings, leadForm, stores, type Attempt, type Lead, type LeadStatus, type Store } from './data';

interface ApiAttempt {
  stage: string;
  status: string;
  message: string;
  createdAt: string;
}

interface ApiLead {
  leadgenId: string;
  pageId: string;
  formId: string;
  adId: string | null;
  status: string;
  selectedStoreAnswer: string | null;
  syonetCompanyId: number | null;
  syonetEventId: string | null;
  lastError: string | null;
  metaCreatedAt: string | null;
  receivedAt: string;
  updatedAt: string;
  metaProcessedAt: string | null;
  metaPlatform: string | null;
  metaIsOrganic: boolean | null;
  isTest: boolean;
  source?: string;
  personalDataCapturedAt: string | null;
  personalDataPurgeAfter: string | null;
  sendHold?: boolean;
  sendAuthorizedAt?: string | null;
  customerCheck?: { result: 'new' | 'existing' | 'unknown'; at: string; by: string } | null;
  recurrentCount?: number;
  contact?: { name: string | null; phoneMasked: string | null; emailMasked: string | null };
  history: ApiAttempt[];
}

export interface LeadDetail {
  personalDataRestricted?: boolean;
  personalData: null | {
    fieldData: Array<{ name: string; values?: unknown[] }>;
    capturedAt: string;
    purgeAfter: string;
    normalized: null | { name: string; email: string; phone: string; storeAnswer: string; media?: string; organicWithoutPlatform: boolean };
    normalizationError: string | null;
    store: null | { answer: string; companyId: number; active: boolean };
    syonetPreview: unknown;
    syonetBlockers: string[];
    missingConfig: string[];
  };
  syonetDelivery: 'enabled' | 'disabled';
  syonetExchange?: null | { at: string | null; httpStatus: number | null; response?: unknown };
  reviews?: Array<{ action: string; by: string; eventId: string | null; customerResult: string | null; note: string | null; createdAt: string }>;
  earlierLeads?: Array<{ leadgenId: string; receivedAt: string; status: string; storeAnswer: string | null; eventId: string | null }>;
}

export interface DashboardData {
  leads: Lead[];
  syonetDelivery: 'enabled' | 'disabled';
  syonetExchange?: null | { at: string | null; httpStatus: number | null; response?: unknown };
  reviews?: Array<{ action: string; by: string; eventId: string | null; customerResult: string | null; note: string | null; createdAt: string }>;
  earlierLeads?: Array<{ leadgenId: string; receivedAt: string; status: string; storeAnswer: string | null; eventId: string | null }>;
}

const failedStatuses = new Set(['failed', 'blocked', 'ambiguous', 'retry']);

// A Meta devolve a loja como chave (ex.: "vw_lavras", "gm_ubá_") ou como rótulo.
const normalize = (value: string) =>
  value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function resolveStore(lead: ApiLead): Store | undefined {
  return findStore(lead.selectedStoreAnswer, lead.syonetCompanyId);
}

function findStore(storeAnswer: string | null, companyId: number | null): Store | undefined {
  if (companyId != null) {
    const byCompany = stores.find((s) => s.syonetId === companyId);
    if (byCompany) return byCompany;
  }
  if (!storeAnswer) return undefined;
  const answer = normalize(storeAnswer);
  const mapping = formStoreMappings.find((m) => normalize(m.answer) === answer);
  return mapping && stores.find((s) => s.id === mapping.storeId);
}

function toStatus(lead: ApiLead): LeadStatus {
  switch (lead.status) {
    case 'sent': return 'enviado';
    case 'processing': return 'processando';
    case 'received': return 'recebido';
    case 'waiting_config':
      // 'Retido' só existe para leads explicitamente em hold (exceção); o fluxo normal não tem aprovação manual.
      return lead.sendHold && !lead.sendAuthorizedAt ? 'revisao' : 'recebido';
    case 'retry': return 'processando';
    case 'ambiguous': return 'incerto';
    default: return 'erro';
  }
}

// Mensagens técnicas do worker (em inglês, gravadas no banco) apresentadas em português. Desconhecidas passam sem alteração.
const messageRules: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [/^Meta lead notification persisted/, () => 'Notificação recebida da Meta e registrada.'],
  [/^Complete lead data retrieved from Meta/, () => 'Dados completos do lead obtidos na Meta.'],
  [/^Lead fields normalized/, () => 'Campos do lead normalizados.'],
  [/^Selected store is mapped to an active Syonet company/, () => 'Loja escolhida mapeada para uma empresa ativa do Syonet.'],
  [/^Meta lead retrieved, normalized, and routed; Syonet delivery is disabled/, () => 'Lead validado e roteado. O envio ao Syonet estava desligado quando foi processado.'],
  [/^Meta lead retrieved, normalized, and routed; held outside automatic sending/, () => 'Lead validado e roteado, mas retido fora do envio automático.'],
  [/^Selected store is mapped to an active Syonet company; platform not informed by Meta/, () => 'Loja mapeada. Origem detalhada (plataforma/anúncio) não informada pela Meta: segue sem mídia.'],
  [/^Resultado ".*" descartado/, () => 'Um resultado tardio foi descartado porque o lead já havia mudado de estado (verifique o evento no CRM).'],
  [/^Syonet confirmed event creation/, () => 'Enviado com sucesso ao Syonet.'],
  [/^Lead recovered from the Meta form list.*held for manual review/, () => 'Recuperado pela conferência com a Meta (o webhook não entregou). Retido em revisão manual.'],
  [/^Lead recovered from the Meta form list/, () => 'Recuperado automaticamente pela conferência com a Meta (o webhook não entregou).'],
  [/^Syonet rejected the lead data \(HTTP 412[^)]*\)(.*)\.$/, (m) => `Syonet recusou os dados do lead (412)${m[1]}.`],
  [/^Syonet authentication failed/, () => 'Falha de autenticação no Syonet (401). Confira usuário e senha.'],
  [/^Syonet denied the request \(HTTP 403\)/, () => 'Syonet negou a execução (403): o tipo de evento não tem permissão de Web Service.'],
  [/^Syonet rate-limited/, () => 'Syonet limitou as requisições (429); nova tentativa automática.'],
  [/manual review is required|outcome is unknown|could not be (read|interpreted)|did not confirm/, () => 'Não foi possível confirmar se o evento foi criado no Syonet. Confira no CRM antes de reenviar.'],
  [/^Worker stopped during processing/, () => 'Processamento interrompido: não foi possível confirmar se o evento foi criado. Confira no CRM antes de reenviar.'],
  [/^Selected store "(.*)" is marked inactive/, (m) => `A loja "${m[1]}" está inativa e não foi enviada ao Syonet.`],
  [/^Selected store is not mapped/, () => 'Loja escolhida não mapeada para uma empresa do Syonet.'],
  [/^Form ID is not configured/, () => 'Formulário não autorizado para esta integração.'],
  [/^Syonet rejected the lead \(HTTP/, () => 'Syonet retornou erro e recusou o lead.'],
  [/^Meta access token/, () => 'Token da Meta inválido ou sem permissão de leads.'],
  [/^Meta Graph API/, () => 'Falha ao consultar a Meta; nova tentativa automática.'],
];

export function describeMessage(message: string): string {
  for (const [pattern, render] of messageRules) {
    const match = message.match(pattern);
    if (match) return render(match);
  }
  return message;
}

// Todos os horários do painel em America/Sao_Paulo, independentemente do fuso do navegador.
const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'America/Sao_Paulo' });

export function formatDateTime(iso: string | null): string {
  return iso ? dateTime.format(new Date(iso)) : '—';
}

function toLead(lead: ApiLead): Lead {
  const store = resolveStore(lead);
  const attempts: Attempt[] = lead.history.map((a) => ({
    at: formatDateTime(a.createdAt),
    result: failedStatuses.has(a.status) ? 'falha' : 'sucesso',
    stage: a.stage,
    message: describeMessage(a.message),
  }));

  const platform = lead.metaPlatform === 'fb' ? 'Facebook' : lead.metaPlatform === 'ig' ? 'Instagram' : lead.metaPlatform;
  return {
    id: lead.leadgenId,
    name: lead.contact?.name ?? null,
    phoneMasked: lead.contact?.phoneMasked ?? null,
    emailMasked: lead.contact?.emailMasked ?? null,
    platform: platform ?? null,
    hasPersonalData: Boolean(lead.personalDataCapturedAt),
    personalDataPurgeAfter: formatDateTime(lead.personalDataPurgeAfter),
    pageId: lead.pageId,
    formId: lead.formId,
    form: lead.formId === leadForm.id ? leadForm.name : `Formulário ${lead.formId}`,
    adId: lead.adId,
    isTest: lead.isTest,
    recovered: lead.source === 'reconciliation',
    companyId: lead.syonetCompanyId,
    origin: lead.adId || platform
      ? [lead.adId ? 'Anúncio' : null, platform].filter(Boolean).join(' · ')
      : 'Origem detalhada não informada pela Meta',
    storeAnswer: lead.selectedStoreAnswer ?? '—',
    store: store?.name ?? (lead.metaProcessedAt ? 'Loja não mapeada' : 'Aguardando dados da Meta'),
    city: store?.city ?? '—',
    rule: lead.selectedStoreAnswer ? `Loja escolhida no formulário: ${lead.selectedStoreAnswer}` : '—',
    receivedAt: formatDateTime(lead.receivedAt),
    receivedAtIso: lead.receivedAt,
    metaCreatedAt: formatDateTime(lead.metaCreatedAt),
    metaProcessedAt: formatDateTime(lead.metaProcessedAt),
    status: toStatus(lead),
    rawStatus: lead.status,
    lastError: lead.status === 'waiting_config' && lead.sendHold && !lead.sendAuthorizedAt
      ? 'Retido fora do envio automático: só sai com autorização de um administrador.'
      : lead.lastError ? describeMessage(lead.lastError) : null,
    syonetEventId: lead.syonetEventId,
    sendHold: Boolean(lead.sendHold),
    sendAuthorized: Boolean(lead.sendAuthorizedAt),
    customerCheck: lead.customerCheck ?? null,
    recurrentCount: lead.recurrentCount ?? 0,
    attempts,
  };
}

export async function fetchDashboard(signal?: AbortSignal): Promise<DashboardData> {
  const response = await fetch('/api/dashboard/leads', { signal, headers: { accept: 'application/json' }, credentials: 'same-origin' });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error('Sessão expirada. Entre novamente.');
  }
  if (!response.ok) throw new Error(`API respondeu HTTP ${response.status}.`);
  const body = (await response.json()) as { leads: ApiLead[]; syonetDelivery: 'enabled' | 'disabled' };
  return { leads: body.leads.map(toLead), syonetDelivery: body.syonetDelivery };
}

export async function fetchLeadDetail(leadgenId: string, signal?: AbortSignal): Promise<LeadDetail> {
  const response = await fetch(`/api/dashboard/leads/${encodeURIComponent(leadgenId)}`, {
    signal,
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (response.status === 401) notifyUnauthorized();
  if (!response.ok) throw new Error(`API respondeu HTTP ${response.status}.`);
  return (await response.json()) as LeadDetail;
}

export async function postReview(
  leadgenId: string,
  action: 'resolve' | 'authorize-send' | 'customer-check',
  body: Record<string, unknown>,
): Promise<string> {
  // Cabeçalho exigido pela API (proteção CSRF); com SameSite=Strict e JSON, sites de terceiros não conseguem enviar.
  const response = await fetch(`/api/dashboard/leads/${encodeURIComponent(leadgenId)}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-synclead-csrf': '1' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (response.status === 401) notifyUnauthorized();
  const data = (await response.json().catch(() => ({}))) as { message?: string; error?: string };
  if (!response.ok) throw new Error(data.error ?? `API respondeu HTTP ${response.status}.`);
  return data.message ?? 'Registrado.';
}

export interface HealthAlert {
  id: number;
  kind: string;
  severity: 'critical' | 'warning';
  title: string;
  message?: string;
  count?: number;
  openedAt: string;
  lastSeenAt?: string;
  resolvedAt?: string;
}

export interface HealthData {
  delivery: Array<{ label: '24h' | '7d' | 'desde_webhook'; metaTotal: number; viaWebhook: number; recovered: number; missing: number; rate: number | null }>;
  recoverSince: string;
  historicalBeforeWebhook: number;
  queue: Array<{ status: string; count: number }>;
  lastWebhookAt: string | null;
  reconciliation: null | { at: string; ok: boolean; listed?: number; indexed?: number; recovered?: string[]; error?: string };
  token: null | { checkedAt: string; ok: boolean; type?: string; expiresAt?: string | null; missingScopes?: string[]; error?: string };
  openAlerts: HealthAlert[];
  recentAlerts: HealthAlert[];
  syonetDelivery: 'enabled' | 'disabled';
  metaConfigured: boolean;
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthData> {
  const response = await fetch('/api/dashboard/health', { signal, headers: { accept: 'application/json' }, credentials: 'same-origin' });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error('Sessão expirada. Entre novamente.');
  }
  if (!response.ok) throw new Error(`API respondeu HTTP ${response.status}.`);
  return (await response.json()) as HealthData;
}

export function storeLabel(answer: string | null, companyId: number | null): string {
  return findStore(answer, companyId)?.name ?? (answer ? `Loja não mapeada (${answer})` : 'Sem loja informada');
}

export function platformLabel(platform: string | null): string {
  return platform === 'fb' ? 'Facebook' : platform === 'ig' ? 'Instagram' : platform ?? 'Não informada';
}

export interface StatsData {
  from: string;
  to: string;
  total: number;
  testsExcluded: number;
  daily: Array<{ date: string; count: number }>;
  byStore: Array<{ answer: string | null; companyId: number | null; count: number }>;
  byPlatform: Array<{ platform: string | null; count: number }>;
  byAd: Array<{ adId: string | null; adName: string | null; adsetName: string | null; campaignName: string | null; count: number }>;
}

export async function fetchStats(from: string, to: string, signal?: AbortSignal): Promise<StatsData> {
  const query = new URLSearchParams({ from, to });
  const response = await fetch(`/api/dashboard/stats?${query}`, { signal, headers: { accept: 'application/json' }, credentials: 'same-origin' });
  if (response.status === 401) {
    notifyUnauthorized();
    throw new Error('Sessão expirada. Entre novamente.');
  }
  if (!response.ok) throw new Error(response.status === 400 ? 'Período inválido (máximo 400 dias).' : `API respondeu HTTP ${response.status}.`);
  return (await response.json()) as StatsData;
}
