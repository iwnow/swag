import { createNodeRegistry, type NodeRegistry } from '@swag/api-integration';
import { NodeManifest, type EgressGrant, type HostFrame } from '@swag/contracts';
import type {
  LogContext,
  NodeSandboxes,
  NodeSandboxSpec,
  NodeStateStore,
  SecretReader,
  Timers,
} from '../src/index.ts';
import { createInvokeNode, type NodeInvokeDeps } from '../src/node-invoke.ts';

// Фейковые порты узлов (спека 026, 4.9, 4.10). Значения секретов — явно фейковые.
export const ORG = '0b6f6d2e-6a4c-4c3e-9f5e-222222222222';
export const NOW = '2026-10-22T10:00:00.000Z';
export const FAKE_SECRET = 'fake-secret-value';
export const NODE_TEMPLATE = 'swag-node-host:test';

const MANIFESTS = [
  {
    type: 'example/echo',
    version: '1.0.0',
    kind: 'program',
    title: 'Эхо',
    description: 'Возвращает текст с префиксом.',
    settings: { type: 'object', properties: { prefix: { type: 'string' } } },
    credentials: [],
    inputs: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    outputs: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    operations: [],
    egress: [],
  },
  {
    type: 'example/api',
    version: '1.0.0',
    kind: 'connector',
    title: 'API',
    description: 'Коннектор к внешнему API.',
    settings: { type: 'object', properties: {} },
    credentials: [{ name: 'apiKey', title: 'Ключ API', kind: 'api-key' }],
    inputs: null,
    outputs: null,
    operations: [
      {
        name: 'ping',
        title: 'Проверка',
        description: 'Проверяет доступ.',
        access: 'read',
        input: { type: 'object', properties: {} },
        output: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      },
    ],
    egress: ['api.example.com'],
  },
  {
    type: 'example/tick',
    version: '1.0.0',
    kind: 'trigger',
    title: 'Тик',
    description: 'Источник событий.',
    settings: { type: 'object', properties: {} },
    credentials: [],
    inputs: null,
    outputs: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    operations: [],
    egress: [],
  },
  {
    type: 'example/channel',
    version: '1.0.0',
    kind: 'channel',
    title: 'Канал',
    description: 'Отправка сообщений.',
    settings: { type: 'object', properties: {} },
    credentials: [],
    inputs: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    outputs: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    operations: [],
    egress: [],
  },
  {
    type: 'swag/llm-agent',
    version: '1.0.0',
    kind: 'llm-agent',
    title: 'Агент',
    description: 'LLM-агент платформы.',
    settings: { type: 'object', properties: {} },
    credentials: [],
    inputs: null,
    outputs: null,
    operations: [],
    egress: [],
  },
];

const built = createNodeRegistry(MANIFESTS.map((manifest) => NodeManifest.parse(manifest)));
if (!built.ok) throw new Error('реестр фикстур не собран');
const registry: NodeRegistry = built.registry;

// Очередь строк stdout: итератор заканчивается, когда песочницу удалили или поток закрыт.
class LineQueue implements AsyncIterable<string> {
  private readonly items: string[] = [];
  private readonly waiting: ((result: IteratorResult<string>) => void)[] = [];
  private ended = false;

  push(line: string): void {
    const next = this.waiting.shift();
    if (next) next({ value: line, done: false });
    else this.items.push(line);
  }

  end(): void {
    this.ended = true;
    for (const resolve of this.waiting.splice(0)) resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiting.push(resolve));
      },
      return: () => {
        this.ended = true;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export interface Emit {
  raw(line: string): void;
  frame(value: unknown): void;
  end(): void;
}
export type Respond = (frame: HostFrame, emit: Emit) => void;

// Песочница узла: каждый кадр от ядра отдаётся сценарию respond, который отвечает через emit.
export function fakeNodeSandboxes(respond: Respond, onRun: () => void = () => undefined) {
  const alive = new Map<string, { metadata: Record<string, string>; queue: LineQueue }>();
  const runs: NodeSandboxSpec[] = [];
  const removed: string[] = [];
  const hostFrames = new Map<string, HostFrame[]>();
  let counter = 0;

  const sandboxes: NodeSandboxes = {
    async run(spec) {
      counter += 1;
      runs.push(spec);
      onRun();
      const sandboxId = `node-${counter}`;
      const queue = new LineQueue();
      alive.set(sandboxId, { metadata: spec.metadata, queue });
      hostFrames.set(sandboxId, []);
      const emit: Emit = {
        raw: (line) => queue.push(line),
        frame: (value) => queue.push(JSON.stringify(value)),
        end: () => queue.end(),
      };
      return {
        sandboxId,
        write: (line) => {
          const frame = JSON.parse(line) as HostFrame;
          hostFrames.get(sandboxId)?.push(frame);
          respond(frame, emit);
        },
        lines: queue,
      };
    },
    async remove(sandboxId) {
      removed.push(sandboxId);
      const entry = alive.get(sandboxId);
      if (entry) {
        entry.queue.end();
        alive.delete(sandboxId);
      }
    },
    async list(match) {
      return [...alive]
        .filter(([, entry]) =>
          Object.entries(match).every(([key, value]) =>
            value === true ? key in entry.metadata : entry.metadata[key] === value,
          ),
        )
        .map(([id]) => id);
    },
  };

  return {
    sandboxes,
    runs,
    removed,
    hostFrames,
    seed(sandboxId: string, metadata: Record<string, string>) {
      alive.set(sandboxId, { metadata, queue: new LineQueue() });
    },
  };
}

// Таймеры с ручным запуском: fire(ms) срабатывает активные таймеры с этим интервалом.
export function fakeTimers() {
  const pending: { fn: () => void; ms: number; active: boolean }[] = [];
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, active: true };
      pending.push(timer);
      return timer;
    },
    clearTimeout: (id) => {
      (id as { active: boolean }).active = false;
    },
  };
  return {
    timers,
    has: (ms: number): boolean => pending.some((timer) => timer.active && timer.ms === ms),
    fire(ms: number): void {
      for (const timer of pending) {
        if (timer.active && timer.ms === ms) {
          timer.active = false;
          timer.fn();
        }
      }
    },
  };
}

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  ctx?: LogContext;
}

function fakeLog() {
  const entries: LogEntry[] = [];
  const at =
    (level: LogEntry['level']) =>
    (msg: string, ctx?: LogContext): void => {
      entries.push(ctx === undefined ? { level, msg } : { level, msg, ctx });
    };
  return {
    entries,
    logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
  };
}

export interface NodeHarnessOptions {
  respond?: Respond;
  onRun?: () => void;
  frameMaxBytes?: number;
  timeoutMs?: number;
  abortGraceMs?: number;
}

export function nodeHarness(options: NodeHarnessOptions = {}) {
  const sandboxes = fakeNodeSandboxes(options.respond ?? (() => undefined), options.onRun);
  let nowMs = Date.parse(NOW);
  const timers = fakeTimers();
  const log = fakeLog();
  const grants: EgressGrant[] = [];
  const secretStore: Record<string, string> = {
    avito_token: FAKE_SECRET,
    other_secret: 'fake-other-value',
  };
  const stateValues = new Map<string, string>();
  const stateSets: { orgId: string; stateKey: string; key: string; value: string | null }[] = [];

  const secrets: SecretReader = {
    read: async (_orgId, names) =>
      Object.fromEntries(
        names
          .filter((name) => Object.hasOwn(secretStore, name))
          .map((name) => [name, secretStore[name] ?? '']),
      ),
  };
  const nodeState: NodeStateStore = {
    get: async (orgId, stateKey, key) => stateValues.get(`${orgId}|${stateKey}|${key}`) ?? null,
    set: async (orgId, stateKey, key, value) => {
      stateSets.push({ orgId, stateKey, key, value });
      const id = `${orgId}|${stateKey}|${key}`;
      if (value === null) stateValues.delete(id);
      else stateValues.set(id, value);
    },
  };
  let uuid = 0;
  const nodeDeps = {
    nodes: {
      registry,
      packageOf: (ref: string): string | null => (registry.get(ref) ? '@swag/node-example' : null),
    },
    nodeSandboxes: sandboxes.sandboxes,
    secrets,
    nodeState,
    egressGrants: {
      issue: (grant: EgressGrant): string => {
        grants.push(grant);
        return `token-${grants.length}`;
      },
    },
    node: {
      template: NODE_TEMPLATE,
      egressProxyUrl: 'http://egress-proxy:3128',
      timeoutMs: options.timeoutMs ?? 30000,
      abortGraceMs: options.abortGraceMs ?? 1000,
      frameMaxBytes: options.frameMaxBytes ?? 1000,
    },
  };
  const deps: NodeInvokeDeps = {
    ...nodeDeps,
    clock: { now: () => new Date(nowMs).toISOString() },
    ids: { uuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` },
    timers: timers.timers,
    log: log.logger,
  };

  return {
    deps,
    nodeDeps,
    invoke: createInvokeNode(deps),
    sandboxes,
    timers,
    log,
    grants,
    stateSets,
    stateValues,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}
