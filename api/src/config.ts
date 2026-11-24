import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function requiredPageIds(): string[] {
  const ids = required('META_ALLOWED_PAGE_IDS')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0 || ids.some((id) => !/^\d+$/.test(id))) {
    throw new Error('META_ALLOWED_PAGE_IDS must contain one or more numeric Page IDs.');
  }
  return ids;
}

function parseBoolean(name: string, fallback: boolean): boolean {
  const value = optional(name);
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be either true or false.`);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  return port;
}

function parseSyonetLeadApiUrl(value: string): string {
  if (!value) return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('SYONET_LEAD_API_URL must be a valid HTTPS URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('SYONET_LEAD_API_URL must use HTTPS and must not contain credentials, query, or fragment.');
  }
  return value;
}

function parseOptionalNonNegativeInteger(name: string): number | undefined {
  const value = optional(name);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function parseChoice<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = optional(name, fallback);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

const syonetSendEnabled = parseBoolean('SYONET_SEND_ENABLED', false);

export const config = {
  host: optional('HOST', '0.0.0.0'),
  port: parsePort(optional('PORT', '3000')),
  databaseUrl: required('DATABASE_URL'),
  metaAppSecret: required('META_APP_SECRET'),
  metaWebhookVerifyToken: required('META_WEBHOOK_VERIFY_TOKEN'),
  metaPageAccessToken: optional('META_PAGE_ACCESS_TOKEN'),
  metaFormId: optional('META_FORM_ID', '1030408329895026'),
  metaGraphApiVersion: optional('META_GRAPH_API_VERSION', 'v27.0'),
  metaAllowedPageIds: requiredPageIds(),
  syonetLeadApiUrl: parseSyonetLeadApiUrl(optional('SYONET_LEAD_API_URL')),
  syonetAuthMode: parseChoice('SYONET_AUTH_MODE', ['apikey', 'basic'], 'apikey'),
  syonetApiKey: optional('SYONET_API_KEY'),
  syonetBasicUser: optional('SYONET_BASIC_USER'),
  syonetBasicPassword: optional('SYONET_BASIC_PASSWORD'),
  syonetPhoneFormat: parseChoice('SYONET_PHONE_FORMAT', ['ddd_numero', 'e164'], 'ddd_numero'),
  syonetEventGroup: optional('SYONET_EVENT_GROUP'),
  syonetEventType: optional('SYONET_EVENT_TYPE'),
  syonetSource: optional('SYONET_SOURCE'),
  syonetDaysToUpdateOpenEvent: parseOptionalNonNegativeInteger('SYONET_DAYS_TO_UPDATE_OPEN_EVENT'),
  syonetSendEnabled,
  syonetSendOnlyLeadgenIds: optional('SYONET_SEND_ONLY_LEADGEN_IDS')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
  syonetHomologationMedia: optional('SYONET_HOMOLOGATION_MEDIA') || undefined,
};

if (config.syonetSendOnlyLeadgenIds.some((id) => !/^\d{1,32}$/.test(id))) {
  throw new Error('SYONET_SEND_ONLY_LEADGEN_IDS must contain numeric leadgen IDs separated by commas.');
}
if (config.syonetHomologationMedia && !['FACEBOOK', 'INSTAGRAM'].includes(config.syonetHomologationMedia)) {
  throw new Error('SYONET_HOMOLOGATION_MEDIA must be FACEBOOK or INSTAGRAM.');
}
if (config.syonetHomologationMedia && config.syonetSendOnlyLeadgenIds.length === 0) {
  throw new Error('SYONET_HOMOLOGATION_MEDIA requires SYONET_SEND_ONLY_LEADGEN_IDS.');
}

if (parseBoolean('SYONET_REQUIRE_ALLOWLIST', false) && config.syonetSendEnabled && config.syonetSendOnlyLeadgenIds.length === 0) {
  throw new Error('SYONET_REQUIRE_ALLOWLIST=true requires SYONET_SEND_ONLY_LEADGEN_IDS when Syonet sending is enabled.');
}

export const metaProcessingConfigured = Boolean(config.metaPageAccessToken);

function getSyonetSendConfiguration() {
  if (!config.syonetSendEnabled) return undefined;

  const {
    syonetLeadApiUrl,
    syonetAuthMode,
    syonetApiKey,
    syonetBasicUser,
    syonetBasicPassword,
    syonetPhoneFormat,
    syonetEventGroup,
    syonetEventType,
    syonetSource,
    syonetDaysToUpdateOpenEvent,
  } = config;
  if (
    !syonetLeadApiUrl ||
    (syonetAuthMode === 'apikey' && !syonetApiKey) ||
    (syonetAuthMode === 'basic' && (!syonetBasicUser || !syonetBasicPassword)) ||
    !syonetEventGroup ||
    !syonetEventType ||
    !syonetSource ||
    syonetDaysToUpdateOpenEvent === undefined
  ) {
    throw new Error(
      'SYONET_SEND_ENABLED=true requires the Syonet endpoint, credentials for SYONET_AUTH_MODE, event group/type, source, and open-event policy.',
    );
  }

  return {
    apiUrl: syonetLeadApiUrl,
    auth: syonetAuthMode === 'basic'
      ? { mode: 'basic' as const, username: syonetBasicUser, password: syonetBasicPassword }
      : { mode: 'apikey' as const, apiKey: syonetApiKey },
    phoneFormat: syonetPhoneFormat,
    eventGroup: syonetEventGroup,
    eventType: syonetEventType,
    source: syonetSource,
    daysToUpdateOpenEvent: syonetDaysToUpdateOpenEvent,
    onlyLeadgenIds: config.syonetSendOnlyLeadgenIds,
    homologationMedia: config.syonetHomologationMedia as 'FACEBOOK' | 'INSTAGRAM' | undefined,
  };
}

export const syonetSendConfiguration = getSyonetSendConfiguration();
