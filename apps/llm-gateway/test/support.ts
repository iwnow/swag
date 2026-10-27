import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLiteLlmUpstream } from '@swag/adapter-litellm';
import { createLlmGatewayCore, type Logger, type LlmGatewayCore } from '@swag/llm-gateway-core';
import { readCatalog } from '../src/catalog.ts';

// Значения из 4.9 спеки: мастер-ключ LiteLLM — явно фейковый.
export const MASTER_KEY = 'sk-swag-local-not-secret';
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
export function makeCore(upstreamUrl: string, log: Logger): LlmGatewayCore {
  return createLlmGatewayCore({
    catalog: readCatalog(catalogPath),
    upstream: createLiteLlmUpstream({
      baseUrl: upstreamUrl,
      masterKey: MASTER_KEY,
      idleTimeoutMs: 5_000,
      secrets: [MASTER_KEY],
    }),
    events: { publishEvent: async () => undefined },
    clock: { now: () => new Date(), monotonicMs: () => performance.now() },
    ids: { uuid: () => randomUUID() },
    trace: { currentTraceId: () => null },
    log,
    version: 'test',
  });
}
