import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { PlatformEventInput } from '@swag/contracts';
import { createLiteLlmUpstream } from '@swag/adapter-litellm';
import {
  type BudgetStore,
  createLlmGatewayCore,
  type EventPublisher,
  type Logger,
  type LlmGatewayCore,
  type PriceBook,
  type TraceContext,
} from '@swag/llm-gateway-core';
import { buildApp } from '../src/app.ts';
import { createCatalogHolder, readCatalog } from '../src/catalog.ts';
import { startFakeProvider, type FakeProvider } from '../../../infra/llm/fake-provider/server.ts';
import {
  type FakeBudgets,
  fakeBudgets,
} from '../../../packages/llm-gateway-core/test/fake-budgets.ts';

// Значения из 4.9 спеки: мастер-ключ LiteLLM и токен шлюза — явно фейковые.
export const MASTER_KEY = 'sk-swag-local-not-secret';
export const GATEWAY_TOKEN = 'llm-gateway-test-token-not-secret-0123456789';
export const gatewayOptions = { token: GATEWAY_TOKEN, bodyLimitBytes: 8_388_608 };
export const catalogPath = fileURLToPath(new URL('./fixtures/catalog.json', import.meta.url));

export const SWARM_ID = randomUUID();
export const authorized = { authorization: `Bearer ${GATEWAY_TOKEN}` };
export const caller = { ...authorized, 'x-swag-swarm-id': SWARM_ID, 'x-swag-agent-id': 'agent-1' };

// Спека 004, 4.4: рой SWARM_ID зарегистрирован в фейке хранилища; тесты 002 на /v1/* вызывают его без регистрации через API.
export const TEST_REGISTRATION = {
  swarmId: SWARM_ID,
  budgetMicroUsd: 1_000_000_000,
  expiresAt: null,
  agents: [{ agentId: 'agent-1', model: 'chat-small', budgetMicroUsd: null }],
};

export function registeredBudgets(): FakeBudgets {
  const budgets = fakeBudgets();
  budgets.seed(TEST_REGISTRATION);
  return budgets;
}

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
// traceId — трейс стаба, если trace не передан; trace — порт телеметрии (T-24); idleTimeoutMs — 5 с по умолчанию.
// secrets — по умолчанию только мастер-ключ; тест телеметрии передаёт и ключ фейка (4.9).
// masterKey — ключ, который уходит апстриму в Authorization; по умолчанию MASTER_KEY (тест AC-002-17 берёт и ключ фейка).
export function makeCore(
  upstreamUrl: string,
  log: Logger,
  events: EventPublisher = { publishEvent: async () => undefined },
  options: {
    idleTimeoutMs?: number;
    traceId?: string;
    trace?: TraceContext;
    secrets?: string[];
    masterKey?: string;
    budgets?: BudgetStore;
    prices?: PriceBook;
  } = {},
): LlmGatewayCore {
  const catalog = readCatalog(catalogPath);
  return createLlmGatewayCore({
    catalog,
    upstream: createLiteLlmUpstream({
      baseUrl: upstreamUrl,
      masterKey: options.masterKey ?? MASTER_KEY,
      idleTimeoutMs: options.idleTimeoutMs ?? 5_000,
      secrets: options.secrets ?? [MASTER_KEY],
    }),
    events,
    clock: { now: () => new Date(), monotonicMs: () => performance.now() },
    ids: { uuid: () => randomUUID() },
    trace: options.trace ?? { currentTraceId: () => options.traceId ?? null },
    log,
    version: 'test',
    budgets: options.budgets ?? registeredBudgets(),
    prices: options.prices ?? createCatalogHolder(catalog).book,
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

export interface GatewayOptions {
  bodyLimitBytes?: number;
  idleTimeoutMs?: number;
  traceId?: string;
}

export interface OpenGateway {
  app: FastifyInstance;
  fake: FakeProvider;
  events: PlatformEventInput[];
  logs: LogEntry[];
  budgets: FakeBudgets;
}

const closers: (() => Promise<void>)[] = [];

// Каждый тестовый файл вызывает closeAll в afterEach: закрывает фейки и приложения, открытые тестами.
export async function closeAll(): Promise<void> {
  for (const close of closers.splice(0)) await close();
}

// Шлюз над фейком. События читаются подпиской на шину в памяти, как у api (REQ-002-7). Порт не слушается — см. listenUrl.
export async function openGateway(options: GatewayOptions = {}): Promise<OpenGateway> {
  const fake = await startFakeProvider({ port: 0 });
  closers.push(() => fake.close());
  const bus = createMemoryBus();
  const events: PlatformEventInput[] = [];
  bus.subscribe(`swarm.${SWARM_ID}.events`, (event) => void events.push(event));
  const { log, entries } = recordingLog();
  const budgets = registeredBudgets();
  const core = makeCore(
    fake.url,
    log,
    { publishEvent: async (event) => bus.publish(`swarm.${event.swarmId}.events`, event) },
    {
      ...(options.idleTimeoutMs && { idleTimeoutMs: options.idleTimeoutMs }),
      ...(options.traceId && { traceId: options.traceId }),
      budgets,
    },
  );
  const app = await buildApp(core, {
    ...gatewayOptions,
    ...(options.bodyLimitBytes && { bodyLimitBytes: options.bodyLimitBytes }),
  });
  closers.push(() => app.close());
  return { app, fake, events, logs: entries, budgets };
}

// Слушает 127.0.0.1 на свободном порту и возвращает базовый URL без пути.
export async function listenUrl(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}
