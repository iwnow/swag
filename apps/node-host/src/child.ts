import type { EgressHost, HostFrame, SandboxFrame } from '@swag/contracts';
import { egressMatches } from '@swag/contracts';
import { NodeError, type NodeContext, type NodeDefinition } from '@swag/node-sdk';
import { invokeNode, parseSettings } from '@swag/node-sdk/runtime';
import { fetch as undiciFetch, ProxyAgent, type RequestInit as UndiciRequestInit } from 'undici';

// Спека 026, 4.8 (REQ-026-5, REQ-026-10, REQ-026-11). Дочерний процесс: здесь исполняется код узла.
// Сообщения IPC — кадры протокола без invocationId, с deadlineMs вместо deadline.
type Invoke = Omit<Extract<HostFrame, { t: 'invoke' }>, 'invocationId' | 'deadline'> & {
  deadlineMs: number;
};
type ParentMessage =
  Invoke | Extract<HostFrame, { t: 'state' }> | Extract<HostFrame, { t: 'abort' }>;
type ResultFrame = Extract<SandboxFrame, { t: 'result' }>;
type StateRequest =
  Extract<SandboxFrame, { t: 'state.get' }> | Extract<SandboxFrame, { t: 'state.set' }>;
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface Waiter {
  resolve(value: string | null): void;
  reject(error: Error): void;
}

const MAX_TIMER_MS = 2_147_483_647;

const controller = new AbortController();
const waiters = new Map<number, Waiter>();
let nextId = 1;
let agent: ProxyAgent | undefined;

process.on('message', (message: ParentMessage) => {
  switch (message.t) {
    case 'invoke':
      void run(message);
      return;
    case 'state':
      settle(message);
      return;
    case 'abort':
      controller.abort();
      return;
  }
});
process.on('disconnect', () => controller.abort());

function send(frame: SandboxFrame): void {
  if (process.connected) process.send?.(frame);
}

// Итог уходит родителю, после этого процесс завершается, когда сброшены канал и stdout/stderr.
function finish(frame: ResultFrame): void {
  const exit = (): void => {
    process.stdout.write('', () => process.stderr.write('', () => process.exit(0)));
  };
  if (process.connected) process.send?.(frame, exit);
  else exit();
}

// Данные лога уходят JSON-кадром: циклические и несериализуемые значения теряются, вызов не падает.
function toJsonData(data: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(data)) as unknown;
  } catch {
    return undefined;
  }
}

function emit(level: LogLevel) {
  return (msg: string, data?: object): void =>
    send({ t: 'log', level, msg, data: toJsonData(data) });
}

function request(build: (id: number) => StateRequest): Promise<string | null> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    send(build(id));
  });
}

function settle(message: Extract<HostFrame, { t: 'state' }>): void {
  const waiter = waiters.get(message.id);
  if (!waiter) return;
  waiters.delete(message.id);
  if ('error' in message) waiter.reject(new Error(message.error));
  else waiter.resolve(message.value);
}

async function httpFetch(
  definition: NodeDefinition,
  invoke: Invoke,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new NodeError('egress_denied', 'адрес не разбирается');
  }
  const port = target.port === '' ? 443 : Number(target.port);
  const egress: readonly EgressHost[] = definition.egress ?? [];
  if (target.protocol !== 'https:' || !egressMatches(egress, target.hostname, port)) {
    throw new NodeError('egress_denied', `хост ${target.host} вне egress`);
  }
  // undici-вызов fetch и ProxyAgent из одного пакета: глобальный fetch Node не принимает чужой dispatcher.
  agent ??= new ProxyAgent({
    uri: invoke.egressProxy.url,
    token: `Basic ${Buffer.from(`swag:${invoke.egressProxy.token}`).toString('base64')}`,
  });
  // Типы RequestInit у global и undici разные (два пакета undici-types); поля совпадают, приводим явно.
  const requestInit = { ...init, dispatcher: agent } as unknown as UndiciRequestInit;
  return (await undiciFetch(url, requestInit)) as unknown as Response;
}

function createContext(
  definition: NodeDefinition,
  invoke: Invoke,
  settings: unknown,
): NodeContext<unknown> {
  return {
    settings,
    secrets: {
      async get(name) {
        const value = Object.hasOwn(invoke.secrets, name) ? invoke.secrets[name] : undefined;
        if (value === undefined) {
          throw new NodeError('secret_not_declared', `секрет ${name} не объявлен`);
        }
        return value;
      },
    },
    http: {
      fetch: (url, init) => httpFetch(definition, invoke, url, init),
    },
    log: {
      debug: emit('debug'),
      info: emit('info'),
      warn: emit('warn'),
      error: emit('error'),
    },
    state: {
      get: (key) => request((id) => ({ t: 'state.get', id, key })),
      async set(key, value) {
        await request((id) => ({ t: 'state.set', id, key, value }));
      },
    },
    signal: controller.signal,
  };
}

async function run(invoke: Invoke): Promise<void> {
  // Дедлайн вызова: по нему прерывается сигнал узла, даже если abort от родителя не пришёл.
  // setTimeout не принимает задержку больше 2^31-1 мс: дальний дедлайн иначе сработает сразу.
  const delay = Math.min(MAX_TIMER_MS, Math.max(0, invoke.deadlineMs - Date.now()));
  const timer = setTimeout(() => controller.abort(), delay);
  try {
    const mod = (await import(invoke.package)) as { default?: NodeDefinition };
    const definition = mod.default;
    if (
      !definition ||
      definition.type !== invoke.definition.type ||
      definition.version !== invoke.definition.version
    ) {
      throw new Error('definition mismatch');
    }
    const settings = parseSettings(definition, invoke.settings);
    const output = await invokeNode(
      definition,
      invoke.call,
      createContext(definition, invoke, settings),
    );
    finish({ t: 'result', ok: true, output });
  } catch (error) {
    if (error instanceof NodeError) {
      finish({ t: 'result', ok: false, code: error.code, message: error.message });
    } else {
      finish({
        t: 'result',
        ok: false,
        code: 'node_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    clearTimeout(timer);
  }
}
