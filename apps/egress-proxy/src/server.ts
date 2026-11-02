import { createServer, type IncomingMessage, type Server } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Decision } from '@swag/egress-proxy-core';

// Спека 026, 4.7: оболочка без Fastify — `node:http` на CONNECT и простой ответ на `/health`.
export interface Authorizer {
  authorize(
    method: string,
    target: string,
    proxyAuthorization: string | undefined,
  ): Promise<Decision>;
}

export interface EgressProxyServer {
  port: number;
  healthPort: number;
  close(): Promise<void>;
}

const REASON_PHRASES: Record<Extract<Decision, { ok: false }>['status'], string> = {
  403: 'Forbidden',
  405: 'Method Not Allowed',
  407: 'Proxy Authentication Required',
  502: 'Bad Gateway',
};

// Порты передаются явно: тесты поднимают прокси на случайных портах (0).
export async function startEgressProxy(options: {
  core: Authorizer;
  host: string;
  port: number;
  healthPort: number;
}): Promise<EgressProxyServer> {
  const clients = new Set<Duplex>();

  const proxy = createServer();
  proxy.on('connect', (req, client, head) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => client.destroy());
    void tunnel(options.core, req, client, head).catch(() => client.destroy());
  });
  proxy.on('request', (_req, res) => {
    res.writeHead(405, { Connection: 'close' }).end();
  });

  const health = createServer((req, res) => {
    const ok = req.method === 'GET' && req.url === '/health';
    res.writeHead(ok ? 200 : 404).end();
  });

  const port = await listen(proxy, options.host, options.port);
  const healthPort = await listen(health, options.host, options.healthPort);

  return {
    port,
    healthPort,
    async close() {
      for (const client of clients) client.destroy();
      await Promise.all([closeServer(proxy), closeServer(health)]);
    },
  };
}

// Спека 026, 4.7: отказ — статус и закрытие; разрешение — 200 и двунаправленный pipe к проверенному адресу.
async function tunnel(
  core: Authorizer,
  req: IncomingMessage,
  client: Duplex,
  head: Buffer,
): Promise<void> {
  // Закрытие клиента до и во время authorize отменяет и последующий connect к upstream.
  const abort = new AbortController();
  client.once('close', () => abort.abort());

  const decision = await core.authorize(
    req.method ?? '',
    req.url ?? '',
    req.headers['proxy-authorization'],
  );
  if (client.destroyed) return;
  if (!decision.ok) {
    const { status } = decision;
    client.end(`HTTP/1.1 ${status} ${REASON_PHRASES[status]}\r\nConnection: close\r\n\r\n`);
    return;
  }

  const socket = connect({ port: decision.port, host: decision.address, signal: abort.signal });
  let established = false;
  socket.once('connect', () => {
    established = true;
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) socket.write(head);
    client.pipe(socket).pipe(client);
  });
  socket.on('error', () => {
    if (established) client.destroy();
    else client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  });
  socket.on('close', () => client.destroy());
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
