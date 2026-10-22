import { randomUUID } from 'node:crypto';
import { createAgentCore, type AgentBus } from '@swag/agent-core';
import { AgentConfig, loadConfig } from '@swag/config';
import type { NatsBus, NatsBusOptions } from '@swag/adapter-nats';
import type { Telemetry, TelemetryOptions } from '@swag/adapter-telemetry';
import { eventsSubject, inboxSubject, type AgentId } from '@swag/contracts';
import { runAgent } from './run.ts';

// Спека 016, 4.7: телеметрия до NATS, старт в спане agent.start с родителем TRACEPARENT,
// ошибка старта — error-лог с err, сброс телеметрии, выход с кодом 1.

export interface AgentProcessDeps {
  env: Record<string, string | undefined>;
  version: string;
  startTelemetry(options: TelemetryOptions): Telemetry;
  connect(options: NatsBusOptions): Promise<NatsBus>;
  exit(code: number): void;
}

export interface AgentProcess {
  stop(): Promise<void>; // SIGTERM: закрыть NATS, сбросить телеметрию
}

const IdsEnv = AgentConfig.pick({ SWARM_ID: true, AGENT_ID: true });

// Каждая переменная телеметрии разбирается отдельно: невалидная одна не обнуляет остальные.
function envField<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  value: string | undefined,
  fallback: T,
): T {
  const parsed = schema.safeParse(value);
  return parsed.success ? (parsed.data as T) : fallback;
}

export async function startAgentProcess(deps: AgentProcessDeps): Promise<AgentProcess | null> {
  const shape = AgentConfig.shape;
  const traceparent = envField(shape.TRACEPARENT, deps.env['TRACEPARENT'], null);
  const telemetry = deps.startTelemetry({
    service: 'agent',
    version: deps.version,
    otlpEndpoint: envField(
      shape.OTEL_EXPORTER_OTLP_ENDPOINT,
      deps.env['OTEL_EXPORTER_OTLP_ENDPOINT'],
      null,
    ),
    logLevel: 'info', // уровень логов агента — info, оркестратор его не передаёт (4.11)
    flushTimeoutMs: envField(
      shape.TELEMETRY_FLUSH_TIMEOUT_MS,
      deps.env['TELEMETRY_FLUSH_TIMEOUT_MS'],
      2000,
    ),
  });
  const log = telemetry.logger;
  // id для логов ошибки старта — даже если остальная конфигурация невалидна.
  const ids = IdsEnv.safeParse(deps.env);
  const context = ids.success ? { swarmId: ids.data.SWARM_ID, agentId: ids.data.AGENT_ID } : {};
  const attributes: Record<string, string> = ids.success
    ? { 'swarm.id': ids.data.SWARM_ID, 'agent.id': ids.data.AGENT_ID }
    : {};

  const state: { nats: NatsBus | null } = { nats: null };
  try {
    await telemetry.inSpan('agent.start', { parent: traceparent, attributes }, async () => {
      try {
        const config = loadConfig(AgentConfig, deps.env);
        runAgent(deps.version, (line) => log.info(line));
        const connection = await deps.connect({
          url: config.NATS_URL,
          warn: (message) => log.warn('bus warning', { ...context, reason: message }),
        });
        state.nats = connection;
        const bus: AgentBus = {
          subscribe: async (subject, handler) => {
            connection.subscribeJson(subject, handler);
          },
          publishEvent: async (event) =>
            connection.publishJson(eventsSubject(event.swarmId), event),
          publishMessage: async (message) =>
            connection.publishJson(inboxSubject(message.swarmId, message.to), message),
        };
        const agent = createAgentCore({
          version: deps.version,
          bus,
          clock: { now: () => new Date().toISOString() },
          ids: { uuid: () => randomUUID() },
          timers: { setTimeout: (fn, ms) => setTimeout(fn, ms) },
          log,
          trace: telemetry.trace,
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
      } catch (error) {
        // Внутри спана: у записи traceId из TRACEPARENT.
        log.error('agent start failed', { ...context, err: error });
        throw error;
      }
    });
  } catch {
    await telemetry.shutdown(); // REQ-016-8: последний лог упавшего агента доходит до Loki
    deps.exit(1);
    return null;
  }

  return {
    async stop() {
      await state.nats?.close();
      await telemetry.shutdown();
    },
  };
}
