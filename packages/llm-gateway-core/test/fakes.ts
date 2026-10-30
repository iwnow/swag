import type { LlmSwarmRegistration, ModelCatalog, PlatformEventInput } from '@swag/contracts';
import type {
  ChatRequest,
  Clock,
  EventPublisher,
  Ids,
  LlmGatewayDeps,
  LlmUpstream,
  LogContext,
  Logger,
  PriceBook,
  TraceContext,
  UpstreamModels,
  UpstreamResponse,
  UpstreamStream,
  UpstreamStreamError,
} from '../src/index.ts';
import { type FakeBudgets, fakeBudgets } from './fake-budgets.ts';

// Спека 002, 4.4: фейковые порты ядра в памяти. Сценарии задаёт тест.
// Спека 004, 4.4: по умолчанию рой TEST_SWARM уже зарегистрирован (registered: false — без регистрации).

export const TEST_SWARM_ID = '6f1c2a4e-8b3d-4e5f-9a1b-2c3d4e5f6a7b';

export const TEST_SWARM: LlmSwarmRegistration = {
  swarmId: TEST_SWARM_ID,
  budgetMicroUsd: 1_000_000_000,
  expiresAt: null,
  agents: [{ agentId: 'agent-1', model: 'chat-small', budgetMicroUsd: null }],
};

const PRICES = {
  inputPerMTokUsd: '3.00',
  cachedInputPerMTokUsd: '0.30',
  outputPerMTokUsd: '15.00',
};

export const testCatalog: ModelCatalog = {
  models: [
    { id: 'chat-small', prices: PRICES },
    { id: 'chat-large', prices: PRICES },
  ],
};

export interface UpstreamCall {
  op: 'complete' | 'stream' | 'listModels';
  body?: ChatRequest;
}

export interface UpstreamScript {
  models?: UpstreamModels;
  complete?: UpstreamResponse;
  stream?: UpstreamStream;
}

export interface FakeUpstream extends LlmUpstream {
  readonly calls: UpstreamCall[];
}

const unscripted = (op: string): never => {
  throw new Error(`fake upstream: сценарий для ${op} не задан`);
};

export function fakeUpstream(script: UpstreamScript = {}): FakeUpstream {
  const calls: UpstreamCall[] = [];
  return {
    calls,
    async complete(body: ChatRequest) {
      calls.push({ op: 'complete', body });
      return script.complete ?? unscripted('complete');
    },
    async stream(body: ChatRequest) {
      calls.push({ op: 'stream', body });
      return script.stream ?? unscripted('stream');
    },
    async listModels() {
      calls.push({ op: 'listModels' });
      return script.models ?? unscripted('listModels');
    },
  };
}

// Поток из заданных payload'ов; если передан error — после них бросает его, как UpstreamStreamError из порта.
// closed — итератор закрыт (return() или конец): тест фиксирует, что ядро закрыло апстрим.
export function chunksThen(
  payloads: string[],
  error?: UpstreamStreamError,
): AsyncGenerator<string> & { readonly closed: boolean } {
  let closed = false;
  async function* gen(): AsyncGenerator<string> {
    try {
      for (const payload of payloads) yield payload;
      if (error) throw error;
    } finally {
      closed = true;
    }
  }
  return Object.defineProperty(gen(), 'closed', { get: () => closed }) as AsyncGenerator<string> & {
    readonly closed: boolean;
  };
}

export interface FakeEvents extends EventPublisher {
  readonly published: PlatformEventInput[];
}

// fail: publishEvent отклоняет промис, событие не запоминается (сбой шины).
export function fakeEvents(options: { fail?: boolean } = {}): FakeEvents {
  const published: PlatformEventInput[] = [];
  return {
    published,
    async publishEvent(event: PlatformEventInput) {
      if (options.fail) throw new Error('bus unavailable');
      published.push(event);
    },
  };
}

export interface FakeClock extends Clock {
  advance(ms: number): void;
}

export function fakeClock(start = new Date('2026-10-27T10:00:00.000Z')): FakeClock {
  let elapsed = 0;
  return {
    now: () => new Date(start.getTime() + elapsed),
    monotonicMs: () => elapsed,
    advance(ms: number) {
      elapsed += ms;
    },
  };
}

export function fakeIds(): Ids {
  let counter = 0;
  return { uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}` };
}

export function fakeTrace(traceId: string | null = null): TraceContext {
  return { currentTraceId: () => traceId };
}

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  ctx?: LogContext;
}

export interface FakeLog extends Logger {
  readonly entries: LogEntry[];
}

export function fakeLog(): FakeLog {
  const entries: LogEntry[] = [];
  const write =
    (level: LogEntry['level']) =>
    (msg: string, ctx?: LogContext): void => {
      entries.push(ctx === undefined ? { level, msg } : { level, msg, ctx });
    };
  return {
    entries,
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
  };
}

// Цены из каталога: в проде их отдаёт PriceBook поверх models.json и OpenRouter (4.9).
export function fakePrices(catalog: ModelCatalog): PriceBook {
  return {
    prices(model) {
      const entry = catalog.models.find((candidate) => candidate.id === model);
      if (!entry) throw new Error(`fake prices: модель ${model} не в каталоге`);
      return entry.prices;
    },
  };
}

export function fakeDeps(
  options: {
    upstream?: UpstreamScript;
    traceId?: string | null;
    publishFails?: boolean;
    registered?: boolean;
    settleFails?: boolean;
  } = {},
): {
  deps: LlmGatewayDeps;
  upstream: FakeUpstream;
  events: FakeEvents;
  clock: FakeClock;
  log: FakeLog;
  budgets: FakeBudgets;
} {
  const upstream = fakeUpstream(options.upstream);
  const events = fakeEvents({ fail: options.publishFails ?? false });
  const clock = fakeClock();
  const log = fakeLog();
  const budgets = fakeBudgets({ settleFails: options.settleFails ?? false });
  if (options.registered ?? true) budgets.seed(TEST_SWARM);
  const deps: LlmGatewayDeps = {
    catalog: testCatalog,
    upstream,
    events,
    clock,
    ids: fakeIds(),
    trace: fakeTrace(options.traceId ?? null),
    log,
    version: 'test',
    budgets,
    prices: fakePrices(testCatalog),
  };
  return { deps, upstream, events, clock, log, budgets };
}
