import { config, metaProcessingConfigured, syonetSendConfiguration } from './config.js';
import { createApiServer } from './app.js';
import { authenticate, login, logout, purgeAuthData } from './auth.js';
import { createPool, initializeDatabase, persistWebhook, recoverStaleLeads } from './database.js';
import { getDashboardLeadDetail, getDashboardStats, listDashboardLeads } from './dashboard.js';
import { reviewLead } from './reviews.js';
import { purgeExpiredData, type RetentionPolicy } from './personal-data.js';
import { getHealthSummary, purgeMonitoringData, runMonitoringCycle, telegramNotifier, type MonitoringConfiguration } from './monitoring.js';
import { runWorker } from './worker.js';

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

const retentionPolicy: RetentionPolicy = {
  sentDays: positiveInteger('PII_RETENTION_SENT_DAYS', 30),
  unsentDays: positiveInteger('PII_RETENTION_UNSENT_DAYS', 90),
  operationalMonths: positiveInteger('OPERATIONAL_RETENTION_MONTHS', 24),
};

function isoDate(name: string, fallback: string): Date {
  const value = new Date(process.env[name]?.trim() || fallback);
  if (Number.isNaN(value.getTime())) throw new Error(`${name} must be an ISO date-time.`);
  return value;
}

const telegramBotToken = process.env.ALERT_TELEGRAM_BOT_TOKEN?.trim();
const telegramChatId = process.env.ALERT_TELEGRAM_CHAT_ID?.trim();
const monitoringConfig: MonitoringConfiguration = {
  accessToken: config.metaPageAccessToken,
  graphApiVersion: config.metaGraphApiVersion,
  formId: config.metaFormId,
  pageId: config.metaAllowedPageIds[0],
  // Início do webhook em produção (primeiro lead recebido): antes disso só indexamos ids, sem PII.
  recoverSince: isoDate('RECONCILIATION_RECOVER_SINCE', '2026-11-23T23:40:00Z'),
  missingAfterMinutes: positiveInteger('ALERT_MISSING_LEAD_MINUTES', 15),
  notify: telegramBotToken && telegramChatId ? telegramNotifier(telegramBotToken, telegramChatId) : undefined,
};
const reconciliationIntervalMs = positiveInteger('RECONCILIATION_INTERVAL_MINUTES', 15) * 60 * 1000;

const pool = createPool(config.databaseUrl);
const workerAbort = new AbortController();
const server = createApiServer({
  configuration: {
    metaAppSecret: config.metaAppSecret,
    metaWebhookVerifyToken: config.metaWebhookVerifyToken,
    metaAllowedPageIds: config.metaAllowedPageIds,
    metaProcessingConfigured,
    syonetSendingConfigured: Boolean(syonetSendConfiguration),
  },
  healthCheck: async () => {
    await pool.query('SELECT 1');
  },
  persistWebhook: (payload, waitingForMeta) => persistWebhook(pool, payload, waitingForMeta),
  auth: {
    authenticate: (token) => authenticate(pool, token),
    login: (email, password, context) => login(pool, email, password, context),
    logout: (token, remoteAddr) => logout(pool, token, remoteAddr),
  },
  listLeads: (user) => listDashboardLeads(pool, user.role, retentionPolicy),
  getLeadDetail: (leadgenId, access) => getDashboardLeadDetail(pool, leadgenId, access, {
    formId: config.metaFormId,
    eventGroup: config.syonetEventGroup,
    eventType: config.syonetEventType,
    source: config.syonetSource,
    daysToUpdateOpenEvent: config.syonetDaysToUpdateOpenEvent,
    phoneFormat: config.syonetPhoneFormat,
  }, retentionPolicy),
  getStats: (range) => getDashboardStats(pool, range),
  reviewLead: (leadgenId, action, body, user) => reviewLead(pool, leadgenId, action, body, user),
  getHealth: () => getHealthSummary(pool, {
    recoverSince: monitoringConfig.recoverSince,
    missingAfterMinutes: monitoringConfig.missingAfterMinutes,
    syonetEnabled: Boolean(syonetSendConfiguration),
    metaConfigured: metaProcessingConfigured,
  }),
});

async function runRetention(): Promise<void> {
  try {
    const purged = await purgeExpiredData(pool, retentionPolicy);
    const auth = await purgeAuthData(pool, 12);
    const monitoring = await purgeMonitoringData(pool, retentionPolicy.operationalMonths);
    if (purged.personalData || purged.leads || purged.accessLog || auth.sessions || auth.authLog || monitoring.metaLeads || monitoring.alerts) {
      console.info(`Retention purge: personal data ${purged.personalData}, leads ${purged.leads}, access log ${purged.accessLog}, sessions ${auth.sessions}, auth log ${auth.authLog}, meta index ${monitoring.metaLeads}, alerts ${monitoring.alerts}.`);
    }
  } catch (error) {
    console.error('Retention purge failed:', error instanceof Error ? error.message : 'unknown error');
  }
}
let retentionTimer: NodeJS.Timeout | undefined;
let monitoringTimer: NodeJS.Timeout | undefined;
let monitoringRunning = false;

async function runMonitoring(): Promise<void> {
  if (monitoringRunning) return;
  monitoringRunning = true;
  try {
    const status = await runMonitoringCycle(pool, monitoringConfig);
    if (!status.ok) console.error('Reconciliation failed:', status.error);
  } catch (error) {
    console.error('Monitoring cycle failed:', error instanceof Error ? error.message : 'unknown error');
  } finally {
    monitoringRunning = false;
  }
}

try {
  await initializeDatabase(pool);
  await recoverStaleLeads(pool);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  console.info(`SyncLead API listening on ${config.host}:${config.port}.`);
  void runRetention();
  retentionTimer = setInterval(() => void runRetention(), 60 * 60 * 1000);
  retentionTimer.unref();
  if (metaProcessingConfigured) {
    setTimeout(() => void runMonitoring(), 30_000).unref();
    monitoringTimer = setInterval(() => void runMonitoring(), reconciliationIntervalMs);
    monitoringTimer.unref();
    console.info(`Meta reconciliation every ${reconciliationIntervalMs / 60000} min; alerts ${monitoringConfig.notify ? 'via Telegram and panel' : 'in the panel only'}.`);
  }
  if (!metaProcessingConfigured) {
    console.warn('Webhook is ready; Meta lead retrieval is paused until a Page access token is configured.');
  }
  if (!syonetSendConfiguration) {
    console.info('Syonet delivery is disabled; Meta test leads can be validated without CRM credentials.');
  }
  void runWorker(pool, {
    metaPageAccessToken: config.metaPageAccessToken,
    metaGraphApiVersion: config.metaGraphApiVersion,
    metaFormId: config.metaFormId,
    syonet: syonetSendConfiguration,
  }, workerAbort.signal);
} catch (error) {
  await pool.end();
  console.error('Could not start SyncLead API:', error);
  process.exitCode = 1;
}

const shutdown = async () => {
  workerAbort.abort();
  clearInterval(retentionTimer);
  clearInterval(monitoringTimer);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await pool.end();
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
