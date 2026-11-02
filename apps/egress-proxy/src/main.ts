import { createRequire } from 'node:module';
import { lookup } from 'node:dns/promises';
import { createEgressGrants } from '@swag/adapter-crypto';
import { startTelemetry, type Telemetry } from '@swag/adapter-telemetry';
import { BaseConfig, EgressProxyConfig, loadConfig } from '@swag/config';
import { createEgressProxyCore } from '@swag/egress-proxy-core';
import { startEgressProxy } from './server.ts';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

// Телеметрия поднимается первой; каждая переменная — отдельно, как в llm-gateway (спека 016).
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
  service: 'egress-proxy',
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

let config: EgressProxyConfig;
try {
  config = loadConfig(EgressProxyConfig);
} catch (error) {
  config = await fail('config invalid', error);
}

// isPublic в проде не передаётся: проверка адреса — isPublicAddress из ядра (D-162).
const core = createEgressProxyCore({
  grants: createEgressGrants(config.EGRESS_PROXY_KEY),
  resolver: {
    // Спека 026, 4.7: все адреса имени (A и AAAA); ошибка DNS — исключение, ядро отвечает 502.
    resolve: async (hostname) =>
      (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address),
  },
  clock: { now: () => new Date() },
  logger: log,
});

const server = await startEgressProxy({
  core,
  host: '0.0.0.0',
  port: config.EGRESS_PROXY_PORT,
  healthPort: config.EGRESS_PROXY_HEALTH_PORT,
}).catch((error: unknown) => fail('listen failed', error));
log.info('egress proxy listening', { port: server.port, healthPort: server.healthPort });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void server
      .close()
      .then(() => telemetry.shutdown())
      .then(() => process.exit(0));
  });
}
