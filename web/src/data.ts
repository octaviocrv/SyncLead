// Lojas e IDs refletem o formulário e a referência do Syonet. Os leads vêm da API (ver api.ts).

export type LeadStatus = 'recebido' | 'processando' | 'validado' | 'enviado' | 'pendente' | 'incerto' | 'revisao' | 'erro';

export interface Attempt {
  at: string;
  result: 'sucesso' | 'falha';
  stage: string;
  message: string;
}

// Na listagem, telefone e e-mail chegam mascarados pela API; o detalhe completo é buscado sob demanda.
export interface Lead {
  id: string;
  name: string | null;
  phoneMasked: string | null;
  emailMasked: string | null;
  platform: string | null;
  hasPersonalData: boolean;
  personalDataPurgeAfter: string;
  pageId: string;
  formId: string;
  form: string;
  adId: string | null;
  // Sem ad_id: lead de teste/orgânico, fora das métricas.
  isTest: boolean;
  recovered?: boolean;
  origin: string;
  storeAnswer: string;
  store: string;
  city: string;
  rule: string;
  receivedAt: string;
  receivedAtIso: string;
  metaCreatedAt: string;
  metaProcessedAt: string;
  status: LeadStatus;
  rawStatus: string;
  lastError: string | null;
  syonetEventId: string | null;
  // Revisão manual (admin): em hold ou recuperado, só sai com autorização.
  sendHold: boolean;
  sendAuthorized: boolean;
  customerCheck: { result: 'new' | 'existing' | 'unknown'; at: string; by: string } | null;
  // Leads anteriores do mesmo contato no nosso banco (dentro da retenção). Não indica cliente no Syonet.
  recurrentCount: number;
  attempts: Attempt[];
}

export interface Store {
  id: string;
  name: string;
  brand: 'VW' | 'GM' | 'BYD';
  city: string;
  syonetId: number;
  active: boolean;
}

export interface FormStoreMapping {
  answer: string;
  storeId: string;
}

export const stores: Store[] = [
  { id: 'cacel-vw-sjdr', name: 'Cacel - VW São João del Rei', brand: 'VW', city: 'São João del Rei', syonetId: 1, active: true },
  { id: 'cacel-vw-alfenas', name: 'Cacel - VW Alfenas', brand: 'VW', city: 'Alfenas', syonetId: 2, active: true },
  { id: 'cacel-vw-lavras', name: 'Cacel - VW Lavras', brand: 'VW', city: 'Lavras', syonetId: 3, active: true },
  { id: 'cacel-vw-varginha', name: 'Cacel - VW Varginha', brand: 'VW', city: 'Varginha', syonetId: 4, active: true },
  { id: 'cacel-vw-itajuba', name: 'Cacel - VW Itajubá', brand: 'VW', city: 'Itajubá', syonetId: 5, active: true },
  { id: 'mapi-gm-lavras', name: 'Mapi - GM Lavras', brand: 'GM', city: 'Lavras', syonetId: 6, active: true },
  { id: 'mapi-gm-varginha', name: 'Mapi - GM Varginha', brand: 'GM', city: 'Varginha', syonetId: 7, active: true },
  { id: 'mapi-gm-uba', name: 'Mapi - GM Ubá', brand: 'GM', city: 'Ubá', syonetId: 8, active: false },
  { id: 'mapi-gm-barbacena', name: 'Mapi - GM Barbacena', brand: 'GM', city: 'Barbacena', syonetId: 9, active: true },
  { id: 'mapi-gm-sjdr', name: 'Mapi - GM São João del Rei', brand: 'GM', city: 'São João del Rei', syonetId: 10, active: true },
  { id: 'cacel-byd-uba', name: 'Cacel - BYD Ubá', brand: 'BYD', city: 'Ubá', syonetId: 11, active: true },
];

export const leadForm = {
  id: '1030408329895026',
  name: 'Cacel | Forms | Lojas 2026 (17/08)',
  storeQuestion: 'Por qual loja quer ser atendido?',
};

export const formStoreMappings: FormStoreMapping[] = [
  { answer: 'VW São João Del Rei', storeId: 'cacel-vw-sjdr' },
  { answer: 'VW Alfenas', storeId: 'cacel-vw-alfenas' },
  { answer: 'VW Lavras', storeId: 'cacel-vw-lavras' },
  { answer: 'VW Varginha', storeId: 'cacel-vw-varginha' },
  { answer: 'VW Itajubá', storeId: 'cacel-vw-itajuba' },
  { answer: 'GM Lavras', storeId: 'mapi-gm-lavras' },
  { answer: 'GM Varginha', storeId: 'mapi-gm-varginha' },
  { answer: 'GM Ubá', storeId: 'mapi-gm-uba' },
  { answer: 'GM Barbacena', storeId: 'mapi-gm-barbacena' },
  { answer: 'GM São João Del Rey', storeId: 'mapi-gm-sjdr' },
  { answer: 'BYD Ubá', storeId: 'cacel-byd-uba' },
];

export const statusLabel: Record<LeadStatus, string> = {
  recebido: 'Recebido',
  processando: 'Processando',
  validado: 'Validado na Meta',
  enviado: 'Enviado ao Syonet',
  pendente: 'Pendente',
  incerto: 'Resultado incerto',
  revisao: 'Em revisão',
  erro: 'Erro',
};

export const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? '—';
