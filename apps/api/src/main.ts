import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createApiCore } from '@swag/api-core';
import { ALL_EVENTS, ALL_INBOXES } from '@swag/contracts';
import { ApiConfig, ConfigError, loadConfig } from '@swag/config';
import { createMemorySwarmStore } from '@swag/adapter-memory';
import { createOrchestratorHttpClient } from '@swag/adapter-orchestrator-http';
import { connectNatsBus } from '@swag/adapter-nats';
import { buildApp } from './app.ts';

function readConfig(): ApiConfig {
  try {
    return loadConfig(ApiConfig);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = readConfig();
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };
const log = {
  warn: (message: string, context?: Record<string, unknown>) =>
    console.warn(JSON.stringify({ level: 'warn', message, ...context })),
};

const core = createApiCore({
  version,
  store: createMemorySwarmStore(),
  orchestrator: createOrchestratorHttpClient({ baseUrl: config.ORCHESTRATOR_URL }),
  clock: { now: () => new Date().toISOString() },
  ids: { uuid: () => randomUUID() },
  log,
  limits: { maxActiveSwarms: config.MAX_ACTIVE_SWARMS },
});

// Все события роя и все сообщения агентов из шины — в ядро (REQ-001-4).
const bus = await connectNatsBus({ url: config.NATS_URL, warn: (message) => log.warn(message) });
bus.subscribeJson(ALL_EVENTS, (raw) => core.ingestEvent(raw));
bus.subscribeJson(ALL_INBOXES, (raw) => core.ingestMessage(raw));

const app = await buildApp(core, { logger: true });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(
    signal,
    () =>
      void app
        .close()
        .then(() => bus.close())
        .then(() => process.exit(0)),
  );
}

await app.listen({ host: '0.0.0.0', port: config.API_PORT });
