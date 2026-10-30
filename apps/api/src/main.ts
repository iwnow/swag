import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { ALL_EVENTS, ALL_INBOXES } from '@swag/contracts';
import { ApiConfig, BaseConfig, loadConfig } from '@swag/config';
import { createOrchestratorHttpClient } from '@swag/adapter-orchestrator-http';
import { connectNatsBus } from '@swag/adapter-nats';
import { startTelemetry, tracedHttpServer } from '@swag/adapter-telemetry';
import { buildApp } from './app.ts';
import { startApiCore } from './start.ts';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

// Телеметрия поднимается первой: ошибка конфигурации тоже уходит логом LogRecord (REQ-016-5).
// Каждая переменная — отдельно: невалидная одна не обнуляет остальные.
const field = <
  K extends 'OTEL_EXPORTER_OTLP_ENDPOINT' | 'LOG_LEVEL' | 'TELEMETRY_FLUSH_TIMEOUT_MS',
>(
  key: K,
  fallback: BaseConfig[K],
): BaseConfig[K] => {
  const parsed = BaseConfig.shape[key].safeParse(process.env[key]);
  return parsed.success ? (parsed.data as BaseConfig[K]) : fallback;
};
const telemetry = startTelemetry({
  service: 'api',
  version,
  otlpEndpoint: field('OTEL_EXPORTER_OTLP_ENDPOINT', null),
  logLevel: field('LOG_LEVEL', 'info'),
  flushTimeoutMs: field('TELEMETRY_FLUSH_TIMEOUT_MS', 2000),
});
const log = telemetry.logger;

async function fail(msg: string, error: unknown): Promise<never> {
  log.error(msg, { err: error });
  await telemetry.shutdown();
  process.exit(1);
}

let config: ApiConfig;
try {
  config = loadConfig(ApiConfig);
} catch (error) {
  config = await fail('config invalid', error);
}

// Миграции до приёма запросов, рои прерванного перезапуска закрыты до подписок (спека 003, 4.5).
const { core, pool } = await startApiCore(
  { databaseUrl: config.DATABASE_URL },
  {
    version,
    orchestrator: createOrchestratorHttpClient({ baseUrl: config.ORCHESTRATOR_URL }),
    clock: { now: () => new Date().toISOString() },
    ids: { uuid: () => randomUUID() },
    log,
    trace: telemetry.trace,
    limits: {
      maxActiveSwarms: config.MAX_ACTIVE_SWARMS,
      maxBudgetMicroUsd: config.SWARM_MAX_BUDGET_MICRO_USD,
    },
  },
).catch((error: unknown) => fail('startup failed', error));

// Все события роя и все сообщения агентов из шины — в ядро (REQ-001-4), каждое — в спане consumer.
const bus = await connectNatsBus({
  url: config.NATS_URL,
  warn: (message) => log.warn('bus warning', { reason: message }),
}).catch((error: unknown) => fail('nats connect failed', error));
bus.subscribeJson(ALL_EVENTS, (raw) => core.ingestEvent(raw));
bus.subscribeJson(ALL_INBOXES, (raw) => core.ingestMessage(raw));

// Fastify пишет тем же логгером; каждый запрос, кроме /health, — серверный спан с родителем из traceparent.
const app = await buildApp(core, {
  loggerInstance: telemetry.logger.pino,
  serverFactory: tracedHttpServer(telemetry, { ignorePaths: ['/health'] }),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(
    signal,
    () =>
      void app
        .close()
        .then(() => bus.close())
        .then(() => pool.end())
        .then(() => telemetry.shutdown())
        .then(() => process.exit(0)),
  );
}

await app
  .listen({ host: '0.0.0.0', port: config.API_PORT })
  .catch((error: unknown) => fail('listen failed', error));
