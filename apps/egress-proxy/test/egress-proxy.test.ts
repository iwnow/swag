import { createServer, Socket, type Server } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEgressGrants } from '@swag/adapter-crypto';
import { createEgressProxyCore } from '@swag/egress-proxy-core';
import { startEgressProxy, type EgressProxyServer } from '../src/server.ts';

// Тестовый ключ: 32 нулевых байта. Годится только для тестов, в проде ключ — из `.env`.
const TEST_KEY = Buffer.alloc(32).toString('base64');
const INVOCATION_ID = '0f8fad5b-d9cb-469f-a165-8c45a5d2c001';

const sockets: Socket[] = [];
let echo: Server;
let echoPort: number;
let proxy: EgressProxyServer;
let token = '';

const logger = { info() {}, warn() {} };

beforeEach(async () => {
  echo = createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk));
  });
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', () => resolve()));
  echoPort = (echo.address() as { port: number }).port;

  const grants = createEgressGrants(TEST_KEY);
  const core = createEgressProxyCore({
    grants,
    resolver: {
      resolve: async (hostname) => {
        if (hostname === 'allowed.test') return ['127.0.0.1'];
        throw new Error(`ENOTFOUND ${hostname}`);
      },
    },
    clock: { now: () => new Date() },
    logger,
    // Тест подменяет проверку адреса: локальный адрес эхо-сервера считается публичным (AC-026-11, D-162).
    isPublic: () => true,
  });
  proxy = await startEgressProxy({ core, host: '127.0.0.1', port: 0, healthPort: 0 });
  token = grants.issue({
    invocationId: INVOCATION_ID,
    egress: [`allowed.test:${echoPort}`],
    expiresAt: Date.now() + 60_000,
  });
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await proxy.close();
  await new Promise<void>((resolve) => echo.close(() => resolve()));
});

// Читает заголовок ответа до пустой строки; остаток данных возвращается отдельно.
function readHead(socket: Socket): Promise<{ head: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      resolve({
        head: buffered.subarray(0, end).toString('latin1'),
        rest: buffered.subarray(end + 4),
      });
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('closed before response')));
  });
}

// Дочитывает `length` байт: сначала остаток из заголовка, затем новые данные сокета.
function readBytes(socket: Socket, initial: Buffer, length: number): Promise<string> {
  return new Promise((resolve) => {
    let buffered = initial;
    const done = () => resolve(buffered.subarray(0, length).toString('utf8'));
    if (buffered.length >= length) return done();
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < length) return;
      socket.off('data', onData);
      done();
    };
    socket.on('data', onData);
  });
}

function open(port: number = proxy.port): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    sockets.push(socket);
    socket.connect(port, '127.0.0.1', () => resolve(socket));
    socket.once('error', reject);
  });
}

const connectRequest = (target: string) =>
  [
    `CONNECT ${target} HTTP/1.1`,
    `Host: ${target}`,
    `Proxy-Authorization: Basic ${Buffer.from(`swag:${token}`).toString('base64')}`,
    '',
    '',
  ].join('\r\n');

describe('egress-proxy shell', () => {
  it('AC-026-11: CONNECT к allowed.test с верным токеном → 200 и эхо через туннель', async () => {
    const socket = await open();
    socket.write(connectRequest(`allowed.test:${echoPort}`));
    const { head } = await readHead(socket);
    expect(head.startsWith('HTTP/1.1 200 Connection Established')).toBe(true);

    const echoed = new Promise<string>((resolve) => {
      socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
    });
    socket.write('ping through tunnel');
    expect(await echoed).toBe('ping through tunnel');
  });

  it('AC-026-11: CONNECT к other.test → 403', async () => {
    const socket = await open();
    socket.write(connectRequest(`other.test:${echoPort}`));
    const { head } = await readHead(socket);
    expect(head.startsWith('HTTP/1.1 403 Forbidden')).toBe(true);
  });

  it('AC-026-11: данные, пришедшие вместе с CONNECT, доходят до upstream', async () => {
    const socket = await open();
    const payload = 'first payload bytes';
    socket.write(connectRequest(`allowed.test:${echoPort}`) + payload);
    const { head, rest } = await readHead(socket);
    expect(head.startsWith('HTTP/1.1 200 Connection Established')).toBe(true);
    expect(await readBytes(socket, rest, payload.length)).toBe(payload);
  });

  it('AC-026-11: после отказа 403 сокет клиента закрыт', async () => {
    const socket = await open();
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.write(connectRequest(`other.test:${echoPort}`));
    const { head } = await readHead(socket);
    expect(head.startsWith('HTTP/1.1 403 Forbidden')).toBe(true);
    await closed;
    expect(socket.destroyed).toBe(true);
  });

  it('AC-026-11: CONNECT без верного токена → 407', async () => {
    const socket = await open();
    socket.write(
      `CONNECT allowed.test:${echoPort} HTTP/1.1\r\nHost: x\r\nProxy-Authorization: Basic AAAA\r\n\r\n`,
    );
    const { head } = await readHead(socket);
    expect(head.startsWith('HTTP/1.1 407')).toBe(true);
  });

  it('AC-026-11: обычный GET → 405', async () => {
    const socket = await open();
    socket.write('GET http://allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\n\r\n');
    const { head } = await readHead(socket);
    expect(head.startsWith('HTTP/1.1 405')).toBe(true);
  });

  it('AC-026-11: GET /health на порту здоровья → 200', async () => {
    const socket = await open(proxy.healthPort);
    socket.write('GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    const { head } = await readHead(socket);
    expect(head.startsWith('HTTP/1.1 200')).toBe(true);
  });
});
