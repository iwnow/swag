import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createLiteLlmUpstream } from '@swag/adapter-litellm';
import { connectNatsBus } from '@swag/adapter-nats';
import { startTelemetry, type Telemetry } from '@swag/adapter-telemetry';
import { BaseConfig, LlmGatewayConfig, loadConfig } from '@swag/config';
import { eventsSubject, type ModelCatalog } from '@swag/contracts';
import { createLlmGatewayCore } from '@swag/llm-gateway-core';
import { buildApp } from './app.ts';
import { readCatalog } from './catalog.ts';
import { startGateway, upstreamSecrets } from './start.ts';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

// Телеметрия поднимается первой: ошибка конфигурации тоже уходит логом LogRecord (как в apps/api).
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
const telemetry: Telemetry = startTelemetry({
  service: 'llm-gateway',
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

let config: LlmGatewayConfig;
try {
  config = loadConfig(LlmGatewayConfig);
} catch (error) {
  config = await fail('config invalid', error);
}

let catalog: ModelCatalog;
try {
  catalog = readCatalog(config.LLM_CATALOG_PATH);
} catch (error) {
  catalog = await fail('catalog invalid', error);
}

const bus = await connectNatsBus({
  url: config.NATS_URL,
  warn: (message) => log.warn('bus warning', { reason: message }),
}).catch((error: unknown) => fail('nats connect failed', error));

const core = createLlmGatewayCore({
  catalog,
  upstream: createLiteLlmUpstream({
    baseUrl: config.LITELLM_URL,
    masterKey: config.LITELLM_MASTER_KEY,
    idleTimeoutMs: config.LLM_GATEWAY_UPSTREAM_TIMEOUT_MS,
    secrets: upstreamSecrets(process.env, config.LITELLM_MASTER_KEY),
  }),
  events: {
    publishEvent: (event) => bus.publishJson(eventsSubject(event.swarmId), event),
  },
  clock: { now: () => new Date(), monotonicMs: () => performance.now() },
  ids: { uuid: () => randomUUID() },
  trace: telemetry.trace,
  log,
  version,
});

const app = await buildApp(core);

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

await startGateway({
  core,
  app,
  host: '0.0.0.0',
  port: config.LLM_GATEWAY_PORT,
  startupTimeoutMs: config.LLM_GATEWAY_STARTUP_TIMEOUT_MS,
  log,
  exit: async (code) => {
    await telemetry.shutdown();
    process.exit(code);
  },
}).catch((error: unknown) => fail('listen failed', error));
