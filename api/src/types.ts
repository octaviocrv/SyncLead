export interface MetaWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    changes?: Array<{
      field?: string;
      value?: {
        leadgen_id?: string | number;
        page_id?: string | number;
        form_id?: string | number;
        ad_id?: string | number;
        adgroup_id?: string | number;
        created_time?: number;
      };
    }>;
  }>;
}

export interface MetaLeadResponse {
  id: string;
  created_time?: string;
  ad_id?: string;
  form_id?: string;
  platform?: string;
  is_organic?: boolean;
  field_data?: Array<{
    name: string;
    values?: Array<string | number | boolean>;
  }>;
}

export interface NormalizedLead {
  name: string;
  email: string;
  phone: string;
  storeAnswer: string;
  media?: 'FACEBOOK' | 'INSTAGRAM';
  organicWithoutPlatform: boolean;
}

export type LeadStatus =
  | 'received'
  | 'waiting_config'
  | 'processing'
  | 'retry'
  | 'sent'
  | 'blocked'
  | 'failed'
  | 'ambiguous';

export interface PersistedLead {
  leadgen_id: string;
  form_id: string;
  page_id: string;
  ad_id: string | null;
  adgroup_id: string | null;
  created_time: number | null;
  status: LeadStatus;
  attempts: number;
  selected_store_answer: string | null;
  source?: 'webhook' | 'reconciliation';
}
