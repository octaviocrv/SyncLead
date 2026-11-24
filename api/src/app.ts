import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readSessionCookie, sessionCookie, type LoginResult, type SessionUser } from './auth.js';
import { parseStatsRange, type DashboardLeadSummary } from './dashboard.js';
import { verifyMetaSignature } from './domain.js';
import type { MetaWebhookPayload } from './types.js';
import type { ReviewAction, ReviewResult } from './reviews.js';

const maxBodyBytes = 1_000_000;

export interface ApiServerConfiguration {
  metaAppSecret: string;
  metaWebhookVerifyToken: string;
  metaAllowedPageIds: string[];
  metaProcessingConfigured: boolean;
  syonetSendingConfigured: boolean;
}

export interface ApiAuthDependencies {
  authenticate: (token: string | undefined) => Promise<SessionUser | undefined>;
  login: (email: string, password: string, context: { remoteAddr: string | null; userAgent: string | null }) => Promise<LoginResult>;
  logout: (token: string | undefined, remoteAddr: string | null) => Promise<void>;
}

export interface ApiServerDependencies {
  configuration: ApiServerConfiguration;
  healthCheck: () => Promise<void>;
  persistWebhook: (payload: MetaWebhookPayload, waitingForMeta: boolean) => Promise<number>;
  auth?: ApiAuthDependencies;
  listLeads?: (user: SessionUser) => Promise<DashboardLeadSummary[]>;
  getLeadDetail?: (leadgenId: string, access: { remoteAddr: string | null; user: SessionUser }) => Promise<object | undefined>;
  getHealth?: () => Promise<object>;
  getStats?: (range: { from: string; to: string }) => Promise<object>;
  reviewLead?: (leadgenId: string, action: ReviewAction, body: Record<string, unknown>, user: SessionUser) => Promise<ReviewResult>;
}

function clientAddress(request: IncomingMessage): string | null {
  const forwarded = request.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || request.socket.remoteAddress || null;
}

function sendJson(reply: ServerResponse, status: number, body: Record<string, unknown>): void {
  reply.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' });
  reply.end(JSON.stringify(body));
}

function sendText(reply: ServerResponse, status: number, body: string): void {
  reply.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  reply.end(body);
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    request.resume();
    return undefined;
  }

  const chunks: Buffer[] = [];
  let length = 0;
  let exceededLimit = false;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBodyBytes) {
      exceededLimit = true;
      chunks.length = 0;
      continue;
    }
    if (!exceededLimit) chunks.push(buffer);
  }
  return exceededLimit ? undefined : Buffer.concat(chunks);
}

export function createApiServer(dependencies: ApiServerDependencies) {
  const server = createServer((request, reply) => {
    void handleRequest(request, reply, dependencies).catch((error: unknown) => {
      console.error('Unhandled API request error:', error);
      if (!reply.headersSent) sendJson(reply, 500, { error: 'Internal server error.' });
      else reply.destroy();
    });
  });

  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  return server;
}

async function handleRequest(
  request: IncomingMessage,
  reply: ServerResponse,
  dependencies: ApiServerDependencies,
): Promise<void> {
  const { configuration } = dependencies;
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (request.method === 'GET' && url.pathname === '/health') {
    try {
      await dependencies.healthCheck();
      sendJson(reply, 200, {
        status: 'ok',
        database: 'connected',
        metaProcessing: configuration.metaProcessingConfigured ? 'configured' : 'waiting_config',
        syonetDelivery: configuration.syonetSendingConfigured ? 'enabled' : 'disabled',
      });
    } catch {
      sendJson(reply, 503, { status: 'error', database: 'unavailable' });
    }
    return;
  }

  if (url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/dashboard/')) {
    reply.setHeader('cache-control', 'no-store');
    if (!dependencies.auth) {
      sendJson(reply, 404, { error: 'Not found.' });
      return;
    }
    await handlePanelRequest(request, reply, url, dependencies, dependencies.auth);
    return;
  }

  if (url.pathname !== '/api/webhooks/meta') {
    sendJson(reply, 404, { error: 'Not found.' });
    return;
  }

  if (request.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === configuration.metaWebhookVerifyToken && challenge) {
      sendText(reply, 200, challenge);
    } else {
      sendJson(reply, 403, { error: 'Webhook verification failed.' });
    }
    return;
  }

  if (request.method !== 'POST') {
    reply.writeHead(405, { allow: 'GET, POST' });
    reply.end();
    return;
  }

  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
    sendJson(reply, 415, { error: 'Expected application/json.' });
    return;
  }

  const rawBody = await readBody(request);
  if (!rawBody) {
    sendJson(reply, 413, { error: 'Webhook payload is too large.' });
    return;
  }

  const signature = request.headers['x-hub-signature-256'];
  if (!verifyMetaSignature(
    rawBody,
    typeof signature === 'string' ? signature : undefined,
    configuration.metaAppSecret,
  )) {
    sendJson(reply, 401, { error: 'Invalid Meta webhook signature.' });
    return;
  }

  let payload: MetaWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as MetaWebhookPayload;
  } catch {
    sendJson(reply, 400, { error: 'Malformed JSON payload.' });
    return;
  }

  if (payload.object !== 'page' || !Array.isArray(payload.entry)) {
    sendJson(reply, 400, { error: 'Unsupported Meta webhook payload.' });
    return;
  }

  const receivedPageIds = payload.entry.flatMap((entry) => [
    String(entry.id ?? ''),
    ...(entry.changes ?? []).map((change) => String(change.value?.page_id ?? '')),
  ]).filter(Boolean);
  if (
    configuration.metaAllowedPageIds.length > 0 &&
    receivedPageIds.some((id) => !configuration.metaAllowedPageIds.includes(id))
  ) {
    sendJson(reply, 403, { error: 'Webhook page is not configured.' });
    return;
  }

  try {
    const inserted = await dependencies.persistWebhook(payload, !configuration.metaProcessingConfigured);
    console.info(`Meta webhook persisted; new events: ${inserted}.`);
    sendJson(reply, 200, { received: true });
  } catch (error) {
    console.error('Could not persist Meta webhook event:', error);
    sendJson(reply, 500, { error: 'Could not persist webhook event.' });
  }
}

const isJson = (request: IncomingMessage) =>
  typeof request.headers['content-type'] === 'string' && request.headers['content-type'].toLowerCase().startsWith('application/json');

async function handlePanelRequest(
  request: IncomingMessage,
  reply: ServerResponse,
  url: URL,
  dependencies: ApiServerDependencies,
  auth: ApiAuthDependencies,
): Promise<void> {
  const remoteAddr = clientAddress(request);
  const token = readSessionCookie(request.headers.cookie);
  const { configuration } = dependencies;

  // Exigir JSON nos POST impede envio cross-site por formulário (CSRF), junto com SameSite=Strict.
  if (url.pathname === '/api/auth/login') {
    if (request.method !== 'POST' || !isJson(request)) {
      sendJson(reply, request.method !== 'POST' ? 405 : 415, { error: 'Use POST application/json.' });
      return;
    }
    const raw = await readBody(request);
    let body: { login?: unknown; email?: unknown; password?: unknown } = {};
    try {
      body = raw && raw.length <= 4096 ? JSON.parse(raw.toString('utf8')) : {};
    } catch {
      // Corpo inválido cai na validação abaixo.
    }
    const identifier = body.login ?? body.email;
    if (typeof identifier !== 'string' || typeof body.password !== 'string' || !identifier.trim() || !body.password || body.password.length > 200) {
      sendJson(reply, 400, { error: 'Informe e-mail ou usuário e a senha.' });
      return;
    }
    const result = await auth.login(identifier, body.password, {
      remoteAddr,
      userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    });
    if (!result.ok) {
      sendJson(reply, result.reason === 'locked' ? 429 : 401, {
        error: result.reason === 'locked'
          ? 'Muitas tentativas. Aguarde 15 minutos e tente novamente.'
          : 'E-mail/usuário ou senha inválidos.',
      });
      return;
    }
    reply.setHeader('set-cookie', sessionCookie(result.token));
    sendJson(reply, 200, { user: publicUser(result.user) });
    return;
  }

  if (url.pathname === '/api/auth/logout') {
    if (request.method !== 'POST' || !isJson(request)) {
      sendJson(reply, request.method !== 'POST' ? 405 : 415, { error: 'Use POST application/json.' });
      return;
    }
    request.resume();
    await auth.logout(token, remoteAddr);
    reply.setHeader('set-cookie', sessionCookie('', 0));
    sendJson(reply, 200, { ok: true });
    return;
  }

  const user = await auth.authenticate(token);
  if (!user) {
    sendJson(reply, 401, { error: 'Sessão expirada ou inexistente.' });
    return;
  }

  if (url.pathname === '/api/auth/me' && request.method === 'GET') {
    sendJson(reply, 200, { user: publicUser(user) });
    return;
  }

  if (url.pathname === '/api/dashboard/health' && dependencies.getHealth) {
    if (request.method !== 'GET') {
      reply.writeHead(405, { allow: 'GET' });
      reply.end();
      return;
    }
    sendJson(reply, 200, { ...(await dependencies.getHealth()), generatedAt: new Date().toISOString() });
    return;
  }

  if (url.pathname === '/api/dashboard/stats' && dependencies.getStats) {
    if (request.method !== 'GET') {
      reply.writeHead(405, { allow: 'GET' });
      reply.end();
      return;
    }
    const range = parseStatsRange(url.searchParams.get('from'), url.searchParams.get('to'));
    if (!range) {
      sendJson(reply, 400, { error: 'Período inválido (use from/to no formato AAAA-MM-DD, até 400 dias).' });
      return;
    }
    sendJson(reply, 200, { ...(await dependencies.getStats(range)) });
    return;
  }

  // Ações de revisão: únicas rotas do painel que alteram dados. Somente admin; exigem POST application/json
  // (bloqueia formulário cross-site), cookie SameSite=Strict e o cabeçalho x-synclead-csrf (um site de terceiros
  // não consegue enviá-lo sem pré-autorização CORS, que a API não concede).
  const reviewMatch = /^\/api\/dashboard\/leads\/(\d{1,32})\/(resolve|authorize-send|customer-check)$/.exec(url.pathname);
  if (reviewMatch && dependencies.reviewLead) {
    if (request.method !== 'POST') {
      reply.writeHead(405, { allow: 'POST' });
      reply.end();
      return;
    }
    if (user.role !== 'admin') {
      request.resume();
      sendJson(reply, 403, { error: 'Apenas administradores podem executar esta ação.' });
      return;
    }
    if (!isJson(request) || request.headers['x-synclead-csrf'] !== '1') {
      request.resume();
      sendJson(reply, !isJson(request) ? 415 : 403, { error: 'Requisição não autorizada.' });
      return;
    }
    const raw = await readBody(request);
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = raw && raw.length <= 4096 ? JSON.parse(raw.toString('utf8')) : undefined;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      else throw new Error('invalid');
    } catch {
      sendJson(reply, 400, { error: 'Corpo inválido.' });
      return;
    }
    const result = await dependencies.reviewLead(reviewMatch[1], reviewMatch[2] as ReviewAction, body, user);
    if (!result.ok) {
      sendJson(reply, result.status, { error: result.error });
      return;
    }
    sendJson(reply, 200, { ok: true, message: result.message });
    return;
  }

  const detailMatch = /^\/api\/dashboard\/leads\/([^/]+)$/.exec(url.pathname);
  if ((url.pathname === '/api/dashboard/leads' || detailMatch) && dependencies.listLeads) {
    if (request.method !== 'GET') {
      reply.writeHead(405, { allow: 'GET' });
      reply.end();
      return;
    }
    if (detailMatch) {
      const leadgenId = detailMatch[1];
      const detail = /^\d{1,32}$/.test(leadgenId) && dependencies.getLeadDetail
        ? await dependencies.getLeadDetail(leadgenId, { remoteAddr, user })
        : undefined;
      if (!detail) {
        sendJson(reply, 404, { error: 'Lead not found.' });
        return;
      }
      sendJson(reply, 200, {
        ...detail,
        syonetDelivery: configuration.syonetSendingConfigured ? 'enabled' : 'disabled',
        generatedAt: new Date().toISOString(),
      });
      return;
    }
    sendJson(reply, 200, {
      leads: await dependencies.listLeads(user),
      syonetDelivery: configuration.syonetSendingConfigured ? 'enabled' : 'disabled',
      generatedAt: new Date().toISOString(),
    });
    return;
  }

  sendJson(reply, 404, { error: 'Not found.' });
}

const publicUser = (user: SessionUser) => ({ email: user.email, name: user.name, role: user.role });
