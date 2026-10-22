import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createOrchestratorCore, type OrchestratorBus } from '@swag/orchestrator-core';
import { ALL_EVENTS, eventsSubject, inboxSubject } from '@swag/contracts';
import { OrchestratorConfig, ConfigError, loadConfig } from '@swag/config';
import { connectNatsBus } from '@swag/adapter-nats';
import { createDockerSandboxProvider } from '@swag/adapter-docker';
import { buildApp } from './app.ts';

function readConfig(): OrchestratorConfig {
  try {
    return loadConfig(OrchestratorConfig);
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
// Временно до T-6 (спека 016): логгер и TraceContext придут из adapter-telemetry.
const line = (level: string) => (msg: string, context?: Record<string, unknown>) =>
  console.warn(JSON.stringify({ level, msg, ...context }));
const log = { debug: line('debug'), info: line('info'), warn: line('warn'), error: line('error') };

const bus = await connectNatsBus({ url: config.NATS_URL, warn: (message) => log.warn(message) });
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
  trace: { currentTraceId: () => null },
  agent: { template: config.AGENT_TEMPLATE, stepDelayMs: config.AGENT_STEP_DELAY_MS },
  timeouts: { agentStartMs: config.AGENT_START_TIMEOUT_MS, swarmMs: config.SWARM_TIMEOUT_MS },
});

// Песочницы прошлого запуска не должны висеть (REQ-001-10).
const orphans = await core.cleanupOrphans();
if (orphans > 0) log.warn('удалены песочницы прошлого запуска', { count: orphans });

// Ответы агентов и их события (agent.started, agent.result) — в ядро.
bus.subscribeJson(ALL_EVENTS, (raw) => void core.handleEvent(raw));

const app = buildApp(core, { logger: true });

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

await app.listen({ host: '0.0.0.0', port: config.ORCHESTRATOR_PORT });
