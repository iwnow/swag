import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createArgon2Hasher, createNodeOpaqueTokens } from '@swag/adapter-crypto';
import { createMemoryRateLimiter } from '@swag/adapter-memory';
import { createSmtpMailer } from '@swag/adapter-smtp';
import { startTelemetry, tracedHttpServer } from '@swag/adapter-telemetry';
import { BaseConfig, IdentityConfig, loadConfig } from '@swag/config';
import { buildApp } from './app.ts';
import { jwtKeys, startOrExit } from './start.ts';

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
  service: 'identity',
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

let config: IdentityConfig;
try {
  config = loadConfig(IdentityConfig);
} catch (error) {
  config = await fail('config invalid', error);
}

let keys: ReturnType<typeof jwtKeys>;
try {
  keys = jwtKeys({
    privateKeyBase64: config.IDENTITY_JWT_PRIVATE_KEY,
    kid: config.IDENTITY_JWT_KID,
  });
} catch (error) {
  keys = await fail('jwt key invalid', error);
}

const supervisor =
  config.IDENTITY_SUPERVISOR_EMAIL !== undefined &&
  config.IDENTITY_SUPERVISOR_PASSWORD !== undefined
    ? { email: config.IDENTITY_SUPERVISOR_EMAIL, password: config.IDENTITY_SUPERVISOR_PASSWORD }
    : null;

// Миграции и супервизор до приёма запросов (REQ-012-15, REQ-012-23); занятый email — старт падает.
const { core, pool } = await startOrExit(
  { databaseUrl: config.DATABASE_URL },
  {
    version,
    ...keys,
    hasher: createArgon2Hasher(),
    opaque: createNodeOpaqueTokens(),
    mailer: createSmtpMailer({
      url: config.SMTP_URL,
      from: config.MAIL_FROM,
      timeoutMs: config.SMTP_TIMEOUT_MS,
    }),
    limiter: createMemoryRateLimiter({ now: () => Date.now() }),
    clock: { now: () => Date.now() },
    ids: { uuid: () => randomUUID() },
    log,
    settings: {
      confirmUrl: config.IDENTITY_CONFIRM_URL,
      accessTtlS: config.IDENTITY_ACCESS_TTL_S,
      refreshTtlS: config.IDENTITY_REFRESH_TTL_S,
      confirmTtlS: config.IDENTITY_CONFIRM_TTL_S,
      inviteUrl: config.IDENTITY_INVITE_URL,
      inviteTtlS: config.IDENTITY_INVITE_TTL_S,
      supervisor,
    },
  },
  (code) => telemetry.shutdown().then(() => process.exit(code)),
);

// Fastify пишет тем же логгером; каждый запрос, кроме /health, — серверный спан с родителем из traceparent.
const app = await buildApp(
  core,
  {
    cookieSecure: config.IDENTITY_COOKIE_SECURE,
    refreshTtlS: config.IDENTITY_REFRESH_TTL_S,
    bodyLimit: config.IDENTITY_BODY_LIMIT_BYTES,
    internalToken: config.IDENTITY_INTERNAL_TOKEN,
  },
  {
    loggerInstance: telemetry.logger.pino,
    serverFactory: tracedHttpServer(telemetry, { ignorePaths: ['/health'] }),
  },
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(
    signal,
    () =>
      void app
        .close()
        .then(() => pool.end())
        .then(() => telemetry.shutdown())
        .then(() => process.exit(0)),
  );
}

await app
  .listen({ host: '0.0.0.0', port: config.IDENTITY_PORT })
  .catch((error: unknown) => fail('listen failed', error));
