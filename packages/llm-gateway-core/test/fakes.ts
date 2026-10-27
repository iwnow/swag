import type { ModelCatalog, PlatformEventInput } from '@swag/contracts';
import type {
  ChatRequest,
  Clock,
  EventPublisher,
  Ids,
  LlmGatewayDeps,
  LlmUpstream,
  LogContext,
  Logger,
  TraceContext,
  UpstreamModels,
  UpstreamResponse,
  UpstreamStream,
  UpstreamStreamError,
} from '../src/index.ts';

// Спека 002, 4.4: фейковые порты ядра в памяти. Сценарии задаёт тест.

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
export async function* chunksThen(
  payloads: string[],
  error?: UpstreamStreamError,
): AsyncGenerator<string> {
  for (const payload of payloads) yield payload;
  if (error) throw error;
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

export function fakeDeps(
  options: { upstream?: UpstreamScript; traceId?: string | null; publishFails?: boolean } = {},
): {
  deps: LlmGatewayDeps;
  upstream: FakeUpstream;
  events: FakeEvents;
  clock: FakeClock;
  log: FakeLog;
} {
  const upstream = fakeUpstream(options.upstream);
  const events = fakeEvents({ fail: options.publishFails ?? false });
  const clock = fakeClock();
  const log = fakeLog();
  const deps: LlmGatewayDeps = {
    catalog: testCatalog,
    upstream,
    events,
    clock,
    ids: fakeIds(),
    trace: fakeTrace(options.traceId ?? null),
    log,
    version: 'test',
  };
  return { deps, upstream, events, clock, log };
}
