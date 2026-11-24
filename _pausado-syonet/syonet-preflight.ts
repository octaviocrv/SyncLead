// Pré-validação da homologação Syonet, sem criar leads:
// 1) POST com corpo vazio: 401 = credencial/modo inválido; 412 = autenticação aceita (nada é criado).
// 2) Mostra o payload final que seria enviado para cada lead da allowlist.
// Uso: docker compose exec api node dist/syonet-preflight.js
import { config } from './config.js';
import { createPool } from './database.js';
import { getDashboardLeadDetail } from './dashboard.js';
import { buildSyonetAuthHeaders, type SyonetAuthConfiguration } from './worker.js';

const problems: string[] = [];
if (!config.syonetLeadApiUrl) problems.push('SYONET_LEAD_API_URL vazio');
if (config.syonetAuthMode === 'apikey' && !config.syonetApiKey) problems.push('SYONET_API_KEY vazio');
if (config.syonetAuthMode === 'basic' && (!config.syonetBasicUser || !config.syonetBasicPassword)) {
  problems.push('SYONET_BASIC_USER/SYONET_BASIC_PASSWORD vazios');
}
if (!config.syonetEventGroup || !config.syonetEventType || !config.syonetSource) problems.push('eventGroup/eventType/source incompletos');
if (config.syonetDaysToUpdateOpenEvent === undefined) problems.push('SYONET_DAYS_TO_UPDATE_OPEN_EVENT vazio');
if (config.syonetSendOnlyLeadgenIds.length !== 1) problems.push('SYONET_SEND_ONLY_LEADGEN_IDS deve ter exatamente 1 lead na homologação');
if (problems.length) {
  console.error(`Configuração incompleta: ${problems.join('; ')}.`);
  process.exit(2);
}

const auth: SyonetAuthConfiguration = config.syonetAuthMode === 'basic'
  ? { mode: 'basic', username: config.syonetBasicUser, password: config.syonetBasicPassword }
  : { mode: 'apikey', apiKey: config.syonetApiKey };

const response = await fetch(config.syonetLeadApiUrl, {
  method: 'POST',
  headers: { ...buildSyonetAuthHeaders(auth), 'Content-Type': 'application/json' },
  body: '{}',
  signal: AbortSignal.timeout(20_000),
});
const text = new TextDecoder('iso-8859-1').decode(await response.arrayBuffer());
console.log(`Endpoint ${config.syonetLeadApiUrl} (auth=${config.syonetAuthMode}) -> HTTP ${response.status}: ${text.slice(0, 300)}`);
const authOk = response.status === 412 || response.status === 400;
console.log(authOk ? 'Autenticação aceita (corpo vazio rejeitado na validação, nada criado).' : 'Autenticação NÃO confirmada.');

const pool = createPool(config.databaseUrl);
try {
  for (const leadgenId of config.syonetSendOnlyLeadgenIds) {
    const detail = await getDashboardLeadDetail(pool, leadgenId, { remoteAddr: 'syonet-preflight' }, {
      formId: config.metaFormId,
      eventGroup: config.syonetEventGroup,
      eventType: config.syonetEventType,
      source: config.syonetSource,
      daysToUpdateOpenEvent: config.syonetDaysToUpdateOpenEvent,
      phoneFormat: config.syonetPhoneFormat,
    });
    const data = detail?.personalData;
    if (!detail || !data) {
      console.error(`Lead ${leadgenId}: sem dados guardados; não é possível montar o payload.`);
      process.exitCode = 3;
      continue;
    }
    const preview = data.syonetPreview as { event: { media: string } } | null;
    if (preview && data.normalized?.organicWithoutPlatform && config.syonetHomologationMedia) {
      preview.event.media = config.syonetHomologationMedia;
    }
    const blockers = data.syonetBlockers.filter((b) => !(config.syonetHomologationMedia && /sem plataforma/.test(b)));
    console.log(`Lead ${leadgenId} | status=${detail.lead.status} | loja=${data.store?.answer} | companyId=${data.store?.companyId}`);
    console.log(blockers.length ? `BLOQUEIOS: ${blockers.join(' | ')}` : 'Sem bloqueios.');
    console.log(JSON.stringify(preview, null, 2));
    if (blockers.length || detail.lead.status !== 'waiting_config') process.exitCode = 3;
  }
} finally {
  await pool.end();
}
if (!authOk) process.exitCode = 4;
