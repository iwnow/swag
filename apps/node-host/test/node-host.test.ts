import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SandboxFrame } from '@swag/contracts';
import { describe, expect, it } from 'vitest';

// Спека 026, 4.8, AC-026-20. Фейковые значения: токен прокси и секреты в тестах не настоящие.
const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const FIXTURE = (name: string): string =>
  pathToFileURL(fileURLToPath(new URL(`./fixtures/${name}.ts`, import.meta.url))).href;
const EGRESS = { url: 'http://egress-proxy:3128', token: 'fake-egress-token' };
const TIMEOUT_MS = 30_000;

interface Host {
  proc: ChildProcessWithoutNullStreams;
  // Сырой stdout, как его получает оркестратор.
  raw(): string;
  // Остаток stdout без перевода строки: кадр ещё не собран.
  pending(): string;
  send(frame: object): void;
  waitFor(match: (frame: SandboxFrame) => boolean): Promise<SandboxFrame>;
  exit: Promise<number | null>;
}

function startHost(): Host {
  const proc = spawn(process.execPath, [MAIN], { stdio: ['pipe', 'pipe', 'pipe'] });
  let raw = '';
  let buffer = '';
  const frames: SandboxFrame[] = [];
  const listeners = new Set<() => void>();
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    raw += chunk;
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      frames.push(SandboxFrame.parse(JSON.parse(buffer.slice(0, newline))));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
    listeners.forEach((notify) => notify());
  });
  const exit = new Promise<number | null>((resolve) => proc.on('close', (code) => resolve(code)));
  return {
    proc,
    raw: () => raw,
    pending: () => buffer,
    send: (frame) => proc.stdin.write(`${JSON.stringify(frame)}\n`),
    waitFor: (match) =>
      new Promise((resolve) => {
        const check = (): void => {
          const found = frames.find(match);
          if (!found) return;
          listeners.delete(check);
          resolve(found);
        };
        listeners.add(check);
        check();
      }),
    exit,
  };
}

function invoke(
  package_: string,
  definition: { type: string; version: string },
  call: object,
  settings: object,
): object {
  return {
    t: 'invoke',
    invocationId: randomUUID(),
    package: package_,
    definition,
    call,
    settings,
    secrets: {},
    egressProxy: EGRESS,
    deadline: Date.now() + 20_000,
  };
}

describe('apps/node-host', () => {
  it(
    'AC-026-20: stdout пуст до invoke; echo дает result ok и выход 0',
    async () => {
      const host = startHost();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(host.raw()).toBe('');

      host.send(
        invoke(
          '@swag/node-example',
          { type: 'example/echo', version: '1.0.0' },
          { kind: 'execute', input: { text: 'hi' } },
          { prefix: '> ' },
        ),
      );
      const result = await host.waitFor((frame) => frame.t === 'result');
      expect(result).toEqual({ t: 'result', ok: true, output: { text: '> hi' } });
      expect(await host.exit).toBe(0);
      expect(host.pending()).toBe('');
    },
    TIMEOUT_MS,
  );

  it(
    'AC-026-20: логи, прямой вывод, state.get и отсутствующий секрет',
    async () => {
      const host = startHost();
      host.send(
        invoke(
          FIXTURE('logs'),
          { type: 'test/logs', version: '1.0.0' },
          { kind: 'execute', input: {} },
          {},
        ),
      );

      const hello = await host.waitFor((frame) => frame.t === 'log' && frame.msg === 'hello');
      expect(hello).toEqual({ t: 'log', level: 'info', msg: 'hello', data: { a: 1 } });
      expect(await host.waitFor((frame) => frame.t === 'log' && frame.msg === 'dbg')).toEqual({
        t: 'log',
        level: 'info',
        msg: 'dbg',
      });
      expect(await host.waitFor((frame) => frame.t === 'log' && frame.msg === 'raw')).toEqual({
        t: 'log',
        level: 'info',
        msg: 'raw',
      });

      const get = await host.waitFor((frame) => frame.t === 'state.get');
      if (get.t !== 'state.get') throw new Error('unreachable');
      expect(get.key).toBe('k');
      host.send({ t: 'state', id: get.id, value: null });

      const result = await host.waitFor((frame) => frame.t === 'result');
      expect(result).toEqual({
        t: 'result',
        ok: false,
        code: 'secret_not_declared',
        message: 'секрет missing не объявлен',
      });
      expect(await host.exit).toBe(0);
      expect(host.pending()).toBe('');
    },
    TIMEOUT_MS,
  );

  it(
    'AC-026-20: process.exit(3) до result дает node_failed child exited 3',
    async () => {
      const host = startHost();
      host.send(
        invoke(
          FIXTURE('exit'),
          { type: 'test/exit', version: '1.0.0' },
          { kind: 'execute', input: {} },
          {},
        ),
      );
      const result = await host.waitFor((frame) => frame.t === 'result');
      expect(result).toEqual({
        t: 'result',
        ok: false,
        code: 'node_failed',
        message: 'child exited 3',
      });
      expect(await host.exit).toBe(0);
    },
    TIMEOUT_MS,
  );
});

describe('apps/node-host, 4.8', () => {
  it(
    '4.8: первый кадр не invoke — выход 1 и пустой stdout',
    async () => {
      const host = startHost();
      host.send({ t: 'abort' });
      expect(await host.exit).toBe(1);
      expect(host.raw()).toBe('');
    },
    TIMEOUT_MS,
  );

  it(
    '4.8: definition mismatch — result node_failed',
    async () => {
      const host = startHost();
      host.send(
        invoke(
          '@swag/node-example',
          { type: 'example/echo', version: '9.9.9' },
          { kind: 'execute', input: { text: 'hi' } },
          { prefix: '> ' },
        ),
      );
      expect(await host.waitFor((frame) => frame.t === 'result')).toEqual({
        t: 'result',
        ok: false,
        code: 'node_failed',
        message: 'definition mismatch',
      });
      expect(await host.exit).toBe(0);
      expect(host.pending()).toBe('');
    },
    TIMEOUT_MS,
  );

  it(
    '4.8: хост вне egress — egress_denied до сетевого запроса',
    async () => {
      const host = startHost();
      host.send(
        invoke(
          FIXTURE('egress'),
          { type: 'test/egress', version: '1.0.0' },
          { kind: 'execute', input: {} },
          {},
        ),
      );
      expect(await host.waitFor((frame) => frame.t === 'result')).toEqual({
        t: 'result',
        ok: false,
        code: 'egress_denied',
        message: 'хост example.com вне egress',
      });
      expect(await host.exit).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    '4.8: ответ state с error доходит до узла исключением',
    async () => {
      const host = startHost();
      host.send(
        invoke(
          FIXTURE('state-error'),
          { type: 'test/state-error', version: '1.0.0' },
          { kind: 'execute', input: {} },
          {},
        ),
      );
      const get = await host.waitFor((frame) => frame.t === 'state.get');
      if (get.t !== 'state.get') throw new Error('unreachable');
      host.send({ t: 'state', id: get.id, error: 'boom' });

      expect(await host.waitFor((frame) => frame.t === 'log' && frame.msg === 'boom')).toEqual({
        t: 'log',
        level: 'warn',
        msg: 'boom',
      });
      expect(await host.waitFor((frame) => frame.t === 'result')).toEqual({
        t: 'result',
        ok: true,
        output: {},
      });
      expect(await host.exit).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    '4.8: строки stdout ребёнка, в том числе без перевода строки, приходят раньше result',
    async () => {
      const host = startHost();
      host.send(
        invoke(
          FIXTURE('stdout'),
          { type: 'test/stdout', version: '1.0.0' },
          { kind: 'execute', input: {} },
          {},
        ),
      );
      await host.waitFor((frame) => frame.t === 'result');
      expect(await host.exit).toBe(0);

      const frames = host
        .raw()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => SandboxFrame.parse(JSON.parse(line)));
      const resultAt = frames.findIndex((frame) => frame.t === 'result');
      const firstAt = frames.findIndex((frame) => frame.t === 'log' && frame.msg === 'first');
      const tailAt = frames.findIndex((frame) => frame.t === 'log' && frame.msg === 'no-newline');
      expect(firstAt).toBeGreaterThanOrEqual(0);
      expect(tailAt).toBeGreaterThanOrEqual(0);
      expect(firstAt).toBeLessThan(tailAt);
      expect(tailAt).toBeLessThan(resultAt);
      expect(host.pending()).toBe('');
    },
    TIMEOUT_MS,
  );
});
