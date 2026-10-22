import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createOrchestratorCore, type OrchestratorBus } from '@swag/orchestrator-core';
import { ALL_EVENTS, eventsSubject, inboxSubject } from '@swag/contracts';
import { BaseConfig, OrchestratorConfig, loadConfig } from '@swag/config';
import { connectNatsBus } from '@swag/adapter-nats';
import { createDockerSandboxProvider } from '@swag/adapter-docker';
import { startTelemetry, tracedHttpServer } from '@swag/adapter-telemetry';
import { buildApp } from './app.ts';

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
  service: 'orchestrator',
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

let config: OrchestratorConfig;
try {
  config = loadConfig(OrchestratorConfig);
} catch (error) {
  config = await fail('config invalid', error);
}

const bus = await connectNatsBus({
  url: config.NATS_URL,
  warn: (message) => log.warn('bus warning', { reason: message }),
}).catch((error: unknown) => fail('nats connect failed', error));
const sandboxes = createDockerSandboxProvider({
  network: config.DOCKER_AGENT_NETWORK,
  natsUrl: config.DOCKER_AGENT_NATS_URL,
  otlpEndpoint: config.DOCKER_AGENT_OTLP_ENDPOINT,
});
const ports: OrchestratorBus = {
  publishEvent: async (event) => bus.publishJson(eventsSubject(event.swarmId), event),
  publishMessage: async (message) =>
    bus.publishJson(inboxSubject(message.swarmId, message.to), message),
};

const core = createOrchestratorCore({
  version,
  sandboxes,
  bus: ports,
  clock: { now: () => new Date().toISOString() },
  timers: {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  },
  ids: { uuid: () => randomUUID() },
  log,
  trace: telemetry.trace,
  agent: { template: config.AGENT_TEMPLATE, stepDelayMs: config.AGENT_STEP_DELAY_MS },
  timeouts: { agentStartMs: config.AGENT_START_TIMEOUT_MS, swarmMs: config.SWARM_TIMEOUT_MS },
});

// Песочницы прошлого запуска не должны висеть (REQ-001-10).
const orphans = await telemetry
  .inSpan('cleanup orphans', { parent: null }, () => core.cleanupOrphans())
  .catch((error: unknown) => fail('orphan cleanup failed', error));
if (orphans > 0) log.warn('orphan sandboxes removed', { count: orphans });

// Ответы агентов и их события (agent.started, agent.result) — в ядро, каждое — в спане consumer.
bus.subscribeJson(ALL_EVENTS, (raw) => {
  core
    .handleEvent(raw)
    .catch((error: unknown) => log.error('event handling failed', { err: error }));
});

// Fastify пишет тем же логгером; каждый запрос, кроме /health, — серверный спан с родителем из traceparent.
const app = buildApp(core, {
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
        .then(() => telemetry.shutdown())
        .then(() => process.exit(0)),
  );
}

await app
  .listen({ host: '0.0.0.0', port: config.ORCHESTRATOR_PORT })
  .catch((error: unknown) => fail('listen failed', error));
