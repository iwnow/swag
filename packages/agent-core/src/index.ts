import {
  BusMessage,
  inboxSubject,
  type AgentId,
  type BusMessage as BusMessageType,
  type ModelId,
  type PlatformEventInput,
  type ServiceInfo,
} from '@swag/contracts';
import { runAgentLoop, type AgentLoopResult, type ChatMessage, type ChatModel } from './loop.ts';
import {
  ENTRY_REMINDER,
  inboxMessage,
  swarmTools,
  systemPrompt,
  type AgentPeer,
  type PromptAgent,
} from './prompt.ts';

export * from './loop.ts';
export * from './prompt.ts';

// Спека 022, 4.4 — агент роя поверх агентного цикла. Порты объявляет ядро.

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

export interface AgentBus {
  subscribe(subject: string, handler: (raw: unknown) => Promise<void>): Promise<void>; // адаптер ждёт промис и сериализует сообщения (REQ-022-14)
  publishEvent(event: PlatformEventInput): Promise<void>;
  publishMessage(message: BusMessageType): Promise<void>;
}

export interface AgentConfigCore {
  swarmId: string;
  agentId: AgentId;
  agentName: string;
  agentRole: string;
  model: ModelId;
  peers: AgentPeer[]; // другие агенты роя, в порядке id
  entryAgentId: AgentId;
  maxSteps: number; // на всю жизнь агента
  maxTokens: number;
}

export interface AgentCoreDeps {
  version: string;
  bus: AgentBus;
  clock: Clock;
  ids: IdGenerator;
  log: Logger;
  trace: TraceContext;
  model: ChatModel;
  config: AgentConfigCore;
}

// Итог хода для публикации: `empty_result` — локальный, цикл о нём не знает (4.4, шаг 5).
type TurnOutcome = AgentLoopResult | { kind: 'empty_result' };

export interface AgentCore {
  info(): ServiceInfo;
  start(): Promise<void>; // подписка на inbox, затем agent.started
}

export function createAgentCore(deps: AgentCoreDeps): AgentCore {
  const { bus, clock, ids, log, trace, model, config } = deps;
  const ctx = { swarmId: config.swarmId, agentId: config.agentId };
  const isEntry = config.agentId === config.entryAgentId;
  const agent: PromptAgent = {
    agentId: config.agentId,
    agentName: config.agentName,
    agentRole: config.agentRole,
    peers: config.peers,
    entryAgentId: config.entryAgentId,
  };
  // Одна история на всё время жизни агента (REQ-022-5).
  const history: ChatMessage[] = [];
  let stepsDone = 0;
  // done или failed: модель больше не вызывается (REQ-022-8).
  let finished = false;
  // Участники, которым отправлено сообщение и от которых ответа ещё не пришло (4.4, шаг 5).
  const awaiting = new Set<AgentId>();

  const envelope = () => ({
    id: ids.uuid(),
    swarmId: config.swarmId,
    ts: clock.now(),
    source: 'agent' as const,
    agentId: config.agentId,
    traceId: trace.currentTraceId(),
  });

  const send = (to: AgentId, text: string) => {
    awaiting.add(to);
    return bus.publishMessage({
      id: ids.uuid(),
      swarmId: config.swarmId,
      from: config.agentId,
      to,
      text,
      ts: clock.now(),
    });
  };

  async function publishOutcome(messageId: string, loop: TurnOutcome): Promise<void> {
    switch (loop.kind) {
      case 'text':
      case 'yielded':
        await bus.publishEvent({ ...envelope(), type: 'agent.idle', data: { messageId } });
        return;
      case 'empty_result':
        finished = true;
        await bus.publishEvent({
          ...envelope(),
          type: 'agent.failed',
          data: { reason: 'empty_result' },
        });
        return;
      case 'stopped':
        finished = true;
        await bus.publishEvent({
          ...envelope(),
          type: 'agent.result',
          data: { text: loop.result },
        });
        return;
      case 'max_steps':
        finished = true;
        await bus.publishEvent({
          ...envelope(),
          type: 'agent.failed',
          data: { reason: 'max_steps' },
        });
        return;
      case 'model_error':
        finished = true;
        await bus.publishEvent({
          ...envelope(),
          type: 'agent.failed',
          data: { reason: `model_error:${loop.error.code}` },
        });
        return;
    }
  }

  async function turn(message: BusMessageType): Promise<void> {
    await bus.publishEvent({
      ...envelope(),
      type: 'agent.working',
      data: { messageId: message.id },
    });
    const stepsAtStart = stepsDone;
    const runLoop = (input: ChatMessage) =>
      runAgentLoop(
        {
          model,
          onStep: (step) =>
            bus.publishEvent({
              ...envelope(),
              type: 'agent.step',
              data: {
                messageId: message.id,
                stepIndex: stepsDone + step.stepIndex,
                text: step.text,
                toolCalls: step.toolCalls,
              },
            }),
        },
        {
          model: config.model,
          systemPrompt: systemPrompt(agent),
          history,
          input,
          tools: swarmTools(agent, send),
          limits: { maxSteps: config.maxSteps - stepsDone, maxTokens: config.maxTokens },
        },
      );
    const first = await runLoop(
      inboxMessage({ from: message.from, text: message.text }, config.peers),
    );
    history.push(...first.messages);
    stepsDone += first.steps;
    let outcome: TurnOutcome = first;
    // Шаг 5 алгоритма 4.4: напоминание агенту-входу — один раз за ход, без ожидаемых ответов.
    if (first.kind === 'text' && isEntry && awaiting.size === 0) {
      const reminded = await runLoop({ role: 'user', content: ENTRY_REMINDER });
      history.push(...reminded.messages);
      stepsDone += reminded.steps;
      outcome = afterReminder(reminded);
    }
    await publishOutcome(message.id, outcome);
    log.debug('turn finished', {
      ...ctx,
      messageId: message.id,
      kind: outcome.kind,
      steps: stepsDone - stepsAtStart,
    });
  }

  // Итог повторного текста агента-входа (4.4, шаг 5, D-82, D-85).
  function afterReminder(loop: AgentLoopResult): TurnOutcome {
    if (loop.kind !== 'text' || awaiting.size > 0) return loop;
    if (loop.text === null || loop.text.trim() === '') return { kind: 'empty_result' };
    return { messages: loop.messages, steps: loop.steps, kind: 'stopped', result: loop.text };
  }

  async function handle(raw: unknown): Promise<void> {
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
    if (finished) {
      log.warn('message dropped', { ...ctx, reason: 'agent_finished' });
      return;
    }
    if (message.from !== 'user') awaiting.delete(message.from);
    await turn(message);
  }

  return {
    info: () => ({ service: 'agent', version: deps.version }),

    async start() {
      await bus.subscribe(inboxSubject(config.swarmId, config.agentId), handle);
      await bus.publishEvent({ ...envelope(), type: 'agent.started', data: {} });
      log.info('agent started', ctx);
    },
  };
}
