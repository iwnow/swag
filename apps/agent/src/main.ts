import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createAgentCore, type AgentBus } from '@swag/agent-core';
import { AgentConfig, ConfigError, loadConfig } from '@swag/config';
import { connectNatsBus } from '@swag/adapter-nats';
import { eventsSubject, inboxSubject, type AgentId } from '@swag/contracts';
import { runAgent } from './run.ts';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

function readConfig(): AgentConfig {
  try {
    return loadConfig(AgentConfig);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = readConfig();
runAgent(version, (line) => console.log(line));

const log = {
  warn: (message: string, context?: Record<string, unknown>) =>
    console.warn(JSON.stringify({ level: 'warn', message, ...context })),
};
const nats = await connectNatsBus({ url: config.NATS_URL, warn: (message) => log.warn(message) });
const bus: AgentBus = {
  subscribe: async (subject, handler) => {
    nats.subscribeJson(subject, handler);
  },
  publishEvent: async (event) => nats.publishJson(eventsSubject(event.swarmId), event),
  publishMessage: async (message) =>
    nats.publishJson(inboxSubject(message.swarmId, message.to), message),
};

const agent = createAgentCore({
  version,
  bus,
  clock: { now: () => new Date().toISOString() },
  ids: { uuid: () => randomUUID() },
  timers: { setTimeout: (fn, ms) => setTimeout(fn, ms) },
  log,
  config: {
    swarmId: config.SWARM_ID,
    agentId: config.AGENT_ID as AgentId,
    agentName: config.AGENT_NAME,
    agentRole: config.AGENT_ROLE,
    agentNext: config.AGENT_NEXT as AgentId | null,
    stepDelayMs: config.AGENT_STEP_DELAY_MS,
  },
});
await agent.start();

// REQ-001-17: по SIGTERM закрыть соединение с NATS и выйти с кодом 0.
process.once('SIGTERM', () => void nats.close().then(() => process.exit(0)));
