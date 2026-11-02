import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http, { type IncomingHttpHeaders } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import Docker from 'dockerode';
import { afterEach, describe, expect, it } from 'vitest';
import { createDockerNodeSandboxes } from '../src/index.ts';

// Фейковый демон Docker на локальном сокете: attach принимается как upgrade, сокет — канал к stdio контейнера.
const VERSION = 'v1.52';
const realModem = new Docker().modem;

function frame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

interface AttachRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  head: number;
}

interface Daemon {
  socketPath: string;
  requests: AttachRequest[];
  socket?: Duplex; // серверная сторона attach-соединения
}

async function startDaemon(calls: string[], attachError: boolean): Promise<Daemon> {
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\swag-attach-${randomUUID()}`
      : path.join(os.tmpdir(), `swag-attach-${randomUUID()}.sock`);
  const daemon: Daemon = { socketPath, requests: [] };
  const connections = new Set<Socket>();
  const server = http.createServer();
  server.on('connection', (connection) => {
    connections.add(connection);
    connection.on('close', () => connections.delete(connection));
  });
  server.on('upgrade', (req, socket, head) => {
    calls.push('attach');
    daemon.requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      head: head.length,
    });
    socket.on('error', () => undefined);
    socket.resume();
    if (attachError) {
      const body = '{"message":"No such container: nc-1"}';
      socket.end(
        `HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
      return;
    }
    daemon.socket = socket;
    socket.write(
      'HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n',
    );
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(async () => {
    for (const connection of connections) connection.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return daemon;
}

function nextData(socket: Duplex): Promise<string> {
  return new Promise((resolve) =>
    socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8'))),
  );
}

interface Fake {
  docker: Docker;
  daemon: Daemon;
  calls: string[];
  createOptions: Record<string, unknown>[];
  removeOptions: Record<string, unknown>[];
}

async function fakeDocker(
  options: { failStart?: boolean; attachError?: boolean; socketPathFn?: boolean } = {},
): Promise<Fake> {
  const calls: string[] = [];
  const createOptions: Record<string, unknown>[] = [];
  const removeOptions: Record<string, unknown>[] = [];
  const daemon = await startDaemon(calls, options.attachError ?? false);
  const container = {
    id: 'nc-1',
    start: async () => {
      calls.push('start');
      if (options.failStart) throw new Error('start failed');
    },
    remove: async (removeOpts: Record<string, unknown>) => {
      calls.push('remove');
      removeOptions.push(removeOpts);
    },
  };
  const docker = {
    modem: {
      socketPath: options.socketPathFn ? async () => daemon.socketPath : daemon.socketPath,
      protocol: 'http',
      version: VERSION,
      demuxStream: realModem.demuxStream.bind(realModem),
    },
    createContainer: async (createOpts: Record<string, unknown>) => {
      calls.push('create');
      createOptions.push(createOpts);
      return container;
    },
    getContainer: (id: string) => ({
      remove: async (removeOpts: Record<string, unknown>) => {
        if (id !== 'nc-1') throw Object.assign(new Error('no such container'), { statusCode: 404 });
        calls.push('remove');
        removeOptions.push(removeOpts);
      },
    }),
    listContainers: async () => [{ Id: 'nc-1' }],
  } as unknown as Docker;
  return { docker, daemon, calls, createOptions, removeOptions };
}

const MAX_LINE = 1048576;

const SPEC = {
  template: 'swag-node-host:dev',
  metadata: { 'swag.kind': 'node', 'swag.invocation': 'inv-1', 'swag.org': 'org-1' },
};

describe('createDockerNodeSandboxes', () => {
  it('AC-026-19: createContainer получает поля 4.9, без Binds, PortBindings и секретов в env; attach раньше start', async () => {
    const fake = await fakeDocker();
    const sandboxes = createDockerNodeSandboxes({
      network: 'swag-nodes',
      docker: fake.docker,
      maxLineBytes: MAX_LINE,
    });
    const session = await sandboxes.run(SPEC);
    fake.daemon.socket!.end();
    expect(session.sandboxId).toBe('nc-1');

    expect(fake.calls).toEqual(['create', 'attach', 'start']);
    expect(fake.daemon.requests[0]).toMatchObject({
      method: 'POST',
      url: `/${VERSION}/containers/nc-1/attach?stream=1&stdin=1&stdout=1&stderr=1`,
    });
    const options = fake.createOptions[0]!;
    expect(options).toMatchObject({
      Image: 'swag-node-host:dev',
      Labels: SPEC.metadata,
      User: 'node',
      OpenStdin: true,
      StdinOnce: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      HostConfig: {
        NetworkMode: 'swag-nodes',
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,size=64m' },
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Memory: 268435456,
        NanoCpus: 500000000,
        PidsLimit: 64,
      },
    });
    const env = options['Env'] as string[];
    expect(env.every((entry) => entry.startsWith('TRACEPARENT='))).toBe(true);
    expect(
      env.filter((entry) => /NATS_URL|LLM_GATEWAY_URL|OTEL_|SECRET|KEY|TOKEN/.test(entry)),
    ).toEqual([]);
    const hostConfig = options['HostConfig'] as Record<string, unknown>;
    expect(hostConfig).not.toHaveProperty('Binds');
    expect(hostConfig).not.toHaveProperty('PortBindings');
  });

  it('AC-026-19: stdout разбит по строкам, stderr не попадает в lines, write добавляет перевод строки', async () => {
    const fake = await fakeDocker();
    const debug: string[] = [];
    const sandboxes = createDockerNodeSandboxes({
      network: 'swag-nodes',
      docker: fake.docker,
      maxLineBytes: MAX_LINE,
      log: { debug: (msg) => debug.push(msg) },
    });
    const session = await sandboxes.run(SPEC);
    const socket = fake.daemon.socket!;
    const sent = nextData(socket);
    session.write('{"t":"abort"}');
    expect(await sent).toBe('{"t":"abort"}\n');

    socket.write(frame(1, 'hel'));
    socket.write(frame(2, 'warn line\n'));
    socket.write(frame(1, 'lo\n'));
    socket.write(frame(1, 'тест\n'));
    socket.end();

    const lines: string[] = [];
    for await (const line of session.lines) lines.push(line);
    expect(lines).toEqual(['hello', 'тест']);
    expect(debug).toEqual(['node sandbox stderr']);
  });

  it('AC-026-19: неполная последняя строка stdout отдаётся при конце потока', async () => {
    const fake = await fakeDocker();
    const sandboxes = createDockerNodeSandboxes({
      network: 'swag-nodes',
      docker: fake.docker,
      maxLineBytes: MAX_LINE,
    });
    const session = await sandboxes.run(SPEC);
    fake.daemon.socket!.write(frame(1, 'last'));
    fake.daemon.socket!.end();
    const lines: string[] = [];
    for await (const line of session.lines) lines.push(line);
    expect(lines).toEqual(['last']);
  });

  it('AC-026-19: remove удаляет с force; повторное удаление — не ошибка', async () => {
    const fake = await fakeDocker();
    const sandboxes = createDockerNodeSandboxes({
      network: 'swag-nodes',
      docker: fake.docker,
      maxLineBytes: MAX_LINE,
    });
    await sandboxes.remove('nc-1');
    expect(fake.removeOptions).toEqual([{ force: true }]);
    await expect(sandboxes.remove('nc-missing')).resolves.toBeUndefined();
  });

  it('AC-026-19: list ищет по меткам; true — только наличие ключа', async () => {
    const fake = await fakeDocker();
    const sandboxes = createDockerNodeSandboxes({
      network: 'swag-nodes',
      docker: fake.docker,
      maxLineBytes: MAX_LINE,
    });
    expect(await sandboxes.list({ 'swag.kind': 'node', 'swag.org': true })).toEqual(['nc-1']);
  });

  it('AC-026-19: строка длиннее maxLineBytes отдаётся маркером вне JSON, остаток до перевода строки отбрасывается', async () => {
    const fake = await fakeDocker();
    const sandboxes = createDockerNodeSandboxes({
      network: 'swag-nodes',
      docker: fake.docker,
      maxLineBytes: 10,
    });
    const session = await sandboxes.run(SPEC);
    const socket = fake.daemon.socket!;
    socket.write(frame(1, 'short\n'));
    socket.write(frame(1, 'x'.repeat(30)));
    socket.write(frame(1, 'yyy\nok\n'));
    socket.end();

    const lines: string[] = [];
    for await (const line of session.lines) lines.push(line);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('short');
    expect(() => JSON.parse(lines[1]!)).toThrow();
    expect(lines[2]).toBe('ok');
  });

  it('AC-026-19: граница maxLineBytes считается в байтах UTF-8, не в символах', async () => {
    const fake = await fakeDocker();
    const sandboxes = createDockerNodeSandboxes({
      network: 'swag-nodes',
      docker: fake.docker,
      maxLineBytes: 4,
    });
    const session = await sandboxes.run(SPEC);
    fake.daemon.socket!.write(frame(1, 'яя\nяяа\n'));
    fake.daemon.socket!.end();

    const lines: string[] = [];
    for await (const line of session.lines) lines.push(line);
    expect(lines[0]).toBe('яя');
    expect(() => JSON.parse(lines[1]!)).toThrow();
  });

  it('AC-026-19: строки stderr в debug обрезаются до 1000 символов', async () => {
    const fake = await fakeDocker();
    const debug: { msg: string; ctx: object | undefined }[] = [];
    const sandboxes = createDockerNodeSandboxes({
      network: 'swag-nodes',
      docker: fake.docker,
      maxLineBytes: MAX_LINE,
      log: { debug: (msg, ctx) => debug.push({ msg, ctx }) },
    });
    await sandboxes.run(SPEC);
    fake.daemon.socket!.write(frame(2, `${'e'.repeat(1500)}\n`));
    fake.daemon.socket!.end();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(debug).toEqual([{ msg: 'node sandbox stderr', ctx: { line: 'e'.repeat(1000) } }]);
  });

  it('AC-026-19: закрытие потока attach без конца — lines заканчивается', async () => {
    const fake = await fakeDocker();
    const sandboxes = createDockerNodeSandboxes({
      network: 'swag-nodes',
      docker: fake.docker,
      maxLineBytes: MAX_LINE,
    });
    const session = await sandboxes.run(SPEC);
    const socket = fake.daemon.socket!;
    socket.write(frame(1, 'partial'), () => socket.destroy());
    const lines: string[] = [];
    for await (const line of session.lines) lines.push(line);
    expect(lines).toEqual(['partial']);
  });

  it('attach с socketPath-функцией из docker-modem (Linux по умолчанию) — тот же путь', async () => {
    const fake = await fakeDocker({ socketPathFn: true });
    const sandboxes = createDockerNodeSandboxes({
      network: 'swag-nodes',
      docker: fake.docker,
      maxLineBytes: MAX_LINE,
    });
    const session = await sandboxes.run(SPEC);
    expect(fake.daemon.requests).toHaveLength(1);
    expect(fake.daemon.requests[0]?.method).toBe('POST');
    session.write('{"t":"invoke"}');
    fake.daemon.socket!.end();
  });

  it('AC-026-19: сбой start — поток attach закрыт, контейнер удалён, ошибка наружу', async () => {
    const fake = await fakeDocker({ failStart: true });
    const sandboxes = createDockerNodeSandboxes({
      network: 'swag-nodes',
      docker: fake.docker,
      maxLineBytes: MAX_LINE,
    });
    await expect(sandboxes.run(SPEC)).rejects.toThrow('start failed');
    const socket = fake.daemon.socket!;
    if (!socket.readableEnded) await once(socket, 'end');
    expect(fake.removeOptions).toEqual([{ force: true }]);
  });

  it('attach без тела запроса: в stdin только наши байты', async () => {
    const fake = await fakeDocker();
    const sandboxes = createDockerNodeSandboxes({
      network: 'swag-nodes',
      docker: fake.docker,
      maxLineBytes: MAX_LINE,
    });
    const session = await sandboxes.run(SPEC);
    const [request] = fake.daemon.requests;
    expect(request?.headers['transfer-encoding']).toBeUndefined();
    expect(request?.headers['content-length'] ?? '0').toBe('0');
    expect(request?.head).toBe(0);

    const socket = fake.daemon.socket!;
    const sent = nextData(socket);
    session.write('{"t":"invoke"}');
    expect(await sent).toBe('{"t":"invoke"}\n');
    socket.end();
  });

  it('attach с ответом не 101 — ошибка со статусом демона, контейнер удалён', async () => {
    const fake = await fakeDocker({ attachError: true });
    const sandboxes = createDockerNodeSandboxes({
      network: 'swag-nodes',
      docker: fake.docker,
      maxLineBytes: MAX_LINE,
    });
    await expect(sandboxes.run(SPEC)).rejects.toThrow(
      'attach: 404 {"message":"No such container: nc-1"}',
    );
    expect(fake.removeOptions).toEqual([{ force: true }]);
  });
});
