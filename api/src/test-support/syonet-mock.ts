import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type SyonetMockScenario =
  | 'ok'
  | 'unauthorized'
  | 'precondition-failed'
  | 'rate-limited'
  | 'server-error'
  | 'forbidden'
  | 'customer-error'
  | 'timeout'
  | 'malformed'
  | 'not-confirmed'
  | 'iso-8859-1';

export interface SyonetMockRequest {
  headers: IncomingMessage['headers'];
  body: unknown;
}

export interface SyonetMock {
  url: string;
  requests: SyonetMockRequest[];
  scenario: SyonetMockScenario;
  close(): Promise<void>;
}

// Local stand-in for the Syonet Lead API; it never reaches the real service.
export async function startSyonetMock(): Promise<SyonetMock> {
  const requests: SyonetMockRequest[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const mock: SyonetMock = {
    url: '',
    requests,
    scenario: 'ok',
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        body = undefined;
      }
      requests.push({ headers: request.headers, body });

      const json = (status: number, payload: unknown, encoding: BufferEncoding = 'utf8') => {
        response.writeHead(status, { 'Content-Type': `application/json; charset=${encoding === 'latin1' ? 'ISO-8859-1' : 'UTF-8'}` });
        response.end(Buffer.from(JSON.stringify(payload), encoding));
      };

      switch (mock.scenario) {
        case 'ok':
          return json(200, { ok: 1, msg: '987654' });
        case 'unauthorized':
          return json(401, { ok: 0, msg: 'Unauthorized' });
        case 'precondition-failed':
          return json(412, { ok: 0, msg: 'Telefone inválido' }, 'latin1');
        case 'rate-limited':
          return json(429, { ok: 0, msg: 'Too many requests' });
        case 'server-error':
          return json(503, { ok: 0, msg: 'Unavailable' });
        case 'forbidden':
          return json(403, { err: 1, msg: "Event type don't have permission to execute Web Service" });
        case 'customer-error':
          return json(500, { err: 1, msg: 'Error to process customer' });
        case 'timeout':
          return; // never answers
        case 'malformed':
          response.writeHead(200, { 'Content-Type': 'text/html' });
          return void response.end('<html>not json</html>');
        case 'not-confirmed':
          return json(200, { ok: 0, msg: 'Evento não criado' }, 'latin1');
        case 'iso-8859-1':
          return json(200, { ok: 1, msg: 'Lançamento-É-123' }, 'latin1');
      }
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/crm/v1/lead/`;
  return mock;
}
