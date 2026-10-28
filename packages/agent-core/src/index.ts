import {
  BusMessage,
  inboxSubject,
  type AgentId,
  type BusMessage as BusMessageType,
  type PlatformEventInput,
  type ServiceInfo,
} from '@swag/contracts';

export * from './loop.ts';

// Спека 001, 4.7.2 — «эстафета» без LLM. Порты объявляет ядро.

export interface Clock {
  now(): string;
}
export interface IdGenerator {
  uuid(): string;
}
// Спека 016, 4.3. Контекст лога — только id, числа и перечисления (REQ-016-10); err адаптер превращает в LogError.
export type LogContext = {
  swarmId?: string;
  agentId?: string;
  err?: unknown;
  [key: string]: unknown;
};
export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
}

/** Текущий контекст трассировки. Ядро кладёт значение в конверт события, не разбирая его. */
export interface TraceContext {
  currentTraceId(): string | null; // null — вне трейса
}
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
}

export interface AgentBus {
  subscribe(subject: string, handler: (raw: unknown) => void): Promise<void>;
  publishEvent(event: PlatformEventInput): Promise<void>;
  publishMessage(message: BusMessageType): Promise<void>;
}

export interface AgentConfigCore {
  swarmId: string;
  agentId: AgentId;
  agentName: string;
  agentRole: string;
  agentNext: AgentId | null; // null — последний в цепочке
  stepDelayMs: number;
}

export interface AgentCoreDeps {
  version: string;
  bus: AgentBus;
  clock: Clock;
  ids: IdGenerator;
  timers: Timers;
  log: Logger;
  trace: TraceContext;
  config: AgentConfigCore;
}

export interface AgentCore {
  info(): ServiceInfo;
  start(): Promise<void>; // подписка на inbox, затем agent.started
}

export function createAgentCore(deps: AgentCoreDeps): AgentCore {
  const { bus, clock, ids, timers, log, trace, config } = deps;
  const ctx = { swarmId: config.swarmId, agentId: config.agentId };
  // Сообщения обрабатываются по одному, в порядке поступления (4.7.2, п. 3).
  let queue: Promise<void> = Promise.resolve();

  const envelope = () => ({
    id: ids.uuid(),
    swarmId: config.swarmId,
    ts: clock.now(),
    source: 'agent' as const,
    agentId: config.agentId,
    traceId: trace.currentTraceId(),
  });

  const pause = (ms: number) => new Promise<void>((resolve) => timers.setTimeout(resolve, ms));

  async function relay(raw: unknown): Promise<void> {
    const parsed = BusMessage.safeParse(raw);
    if (!parsed.success) {
      log.warn('message dropped', { ...ctx, reason: 'invalid_schema' });
      return;
    }
    const message = parsed.data;
    if (message.to !== config.agentId) {
      log.warn('message dropped', { ...ctx, reason: 'wrong_recipient', to: message.to });
      return;
    }

    await bus.publishEvent({
      ...envelope(),
      type: 'agent.working',
      data: { messageId: message.id },
    });
    await pause(config.stepDelayMs);

    const out = `${message.text}\n${config.agentName} (${config.agentRole}): ok`;
    if (config.agentNext !== null) {
      await bus.publishMessage({
        id: ids.uuid(),
        swarmId: config.swarmId,
        from: config.agentId,
        to: config.agentNext,
        text: out,
        ts: clock.now(),
      });
    } else {
      await bus.publishEvent({ ...envelope(), type: 'agent.result', data: { text: out } });
    }
    log.debug('message handled', { ...ctx, messageId: message.id, from: message.from });
  }

  return {
    info: () => ({ service: 'agent', version: deps.version }),

    async start() {
      await bus.subscribe(inboxSubject(config.swarmId, config.agentId), (raw) => {
        queue = queue
          .then(() => relay(raw))
          .catch((error: unknown) => {
            log.error('message failed', { ...ctx, err: error });
          });
      });
      await bus.publishEvent({ ...envelope(), type: 'agent.started', data: {} });
      log.info('agent started', ctx);
    },
  };
}
