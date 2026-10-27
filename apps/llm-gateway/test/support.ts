import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { PlatformEventInput } from '@swag/contracts';
import { createLiteLlmUpstream } from '@swag/adapter-litellm';
import {
  createLlmGatewayCore,
  type EventPublisher,
  type Logger,
  type LlmGatewayCore,
} from '@swag/llm-gateway-core';
import { readCatalog } from '../src/catalog.ts';

// Значения из 4.9 спеки: мастер-ключ LiteLLM и токен шлюза — явно фейковые.
export const MASTER_KEY = 'sk-swag-local-not-secret';
export const GATEWAY_TOKEN = 'llm-gateway-test-token-not-secret-0123456789';
export const gatewayOptions = { token: GATEWAY_TOKEN, bodyLimitBytes: 8_388_608 };
export const catalogPath = fileURLToPath(new URL('./fixtures/catalog.json', import.meta.url));

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  ctx?: Record<string, unknown> | undefined;
}

// Логгер, который пишет записи в массив: тест проверяет их, а не вывод процесса.
export function recordingLog(): { log: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const write =
    (level: LogEntry['level']) => (msg: string, ctx?: Record<string, unknown> | undefined) =>
      void entries.push({ level, msg, ctx });
  return {
    entries,
    log: { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') },
  };
}

// Ядро шлюза над настоящим адаптером LiteLLM, направленным на фейк, и каталогом из фикстуры.
// events по умолчанию не пишет; тест передаёт свой, чтобы проверить отсутствие или наличие событий.
// traceId — трейс, который ядро берёт для события (в оболочке его задаёт T-24); idleTimeoutMs — 5 с по умолчанию.
export function makeCore(
  upstreamUrl: string,
  log: Logger,
  events: EventPublisher = { publishEvent: async () => undefined },
  options: { idleTimeoutMs?: number; traceId?: string } = {},
): LlmGatewayCore {
  return createLlmGatewayCore({
    catalog: readCatalog(catalogPath),
    upstream: createLiteLlmUpstream({
      baseUrl: upstreamUrl,
      masterKey: MASTER_KEY,
      idleTimeoutMs: options.idleTimeoutMs ?? 5_000,
      secrets: [MASTER_KEY],
    }),
    events,
    clock: { now: () => new Date(), monotonicMs: () => performance.now() },
    ids: { uuid: () => randomUUID() },
    trace: { currentTraceId: () => options.traceId ?? null },
    log,
    version: 'test',
  });
}

// простая шина в памяти: публикация синхронная, подписка по точному subject.
export function createMemoryBus() {
  const handlers = new Map<string, ((value: PlatformEventInput) => void)[]>();
  return {
    subscribe(subject: string, handler: (value: PlatformEventInput) => void): void {
      handlers.set(subject, [...(handlers.get(subject) ?? []), handler]);
    },
    publish(subject: string, value: PlatformEventInput): void {
      for (const handler of handlers.get(subject) ?? []) handler(value);
    },
  };
}
