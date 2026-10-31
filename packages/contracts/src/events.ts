import { z } from 'zod';
import { AgentId, AgentSpec, SwarmId } from './swarm.ts';
import { BudgetMicroUsd, LlmCallData, MaxTokens, MicroUsd } from './llm.ts';
import { OrgId, UserId } from './auth.ts';

// Спека 016, 4.1. W3C trace-id: 32 hex в нижнем регистре, не нули.
export const TraceId = z
  .string()
  .regex(/^[0-9a-f]{32}$/)
  .refine((v) => v !== '0'.repeat(32));
export type TraceId = z.infer<typeof TraceId>;

// Спека 001, 4.3. Конверт одинаковый для всех событий; type и data — дискриминированное объединение.
const Envelope = {
  id: z.uuid(), // назначает публикующий
  swarmId: SwarmId,
  ts: z.iso.datetime(), // время публикующего
  source: z.enum(['api', 'orchestrator', 'agent', 'llm-gateway']),
  agentId: AgentId.nullable(), // null — событие роя
  traceId: TraceId.nullable(), // спека 016: null — событие построено вне трейса
};

export const PlatformEventInput = z.discriminatedUnion('type', [
  z.strictObject({
    ...Envelope,
    type: z.literal('swarm.created'),
    // До спеки 004 бюджетов в событии нет (004, 4.1).
    data: z.strictObject({
      task: z.string(),
      budgetMicroUsd: BudgetMicroUsd.optional(),
      maxTokens: MaxTokens.nullable().optional(), // до спеки 031 поля нет (031, 4.1)
      orgId: OrgId.nullable().optional(), // организация автора; null — рой до 024 (024, 4.3)
      createdBy: UserId.nullable().optional(), // автор (024, 4.3)
      agents: z.array(AgentSpec.partial({ budgetMicroUsd: true, maxTokens: true })),
    }),
  }),
  z.strictObject({ ...Envelope, type: z.literal('swarm.started'), data: z.strictObject({}) }),
  z.strictObject({
    ...Envelope,
    type: z.literal('swarm.completed'),
    data: z.strictObject({ result: z.string(), spentMicroUsd: MicroUsd.optional() }), // 013, 4.1
  }),
  z.strictObject({
    ...Envelope,
    type: z.literal('swarm.stopped'),
    data: z.strictObject({ reason: z.literal('user'), spentMicroUsd: MicroUsd.optional() }), // 013, 4.1
  }),
  z.strictObject({
    ...Envelope,
    type: z.literal('swarm.failed'),
    data: z.strictObject({
      reason: z.enum([
        'agent_start_timeout',
        'swarm_timeout',
        'orchestrator_unavailable',
        'sandbox_error',
        'agent_failed',
        'api_restarted',
        'budget_exceeded',
        'gateway_unavailable',
      ]),
      detail: z.string().optional(),
      spentMicroUsd: MicroUsd.optional(), // 013, 4.1
    }),
  }),
  z.strictObject({
    ...Envelope,
    type: z.literal('agent.launched'),
    data: z.strictObject({ sandboxId: z.string() }),
  }),
  z.strictObject({ ...Envelope, type: z.literal('agent.started'), data: z.strictObject({}) }),
  z.strictObject({
    ...Envelope,
    type: z.literal('agent.working'),
    data: z.strictObject({ messageId: z.uuid() }),
  }),
  // Спека 022, 4.1: шаг агента — один ответ модели; idle — конец хода без finish.
  z.strictObject({
    ...Envelope,
    type: z.literal('agent.step'),
    data: z.strictObject({
      messageId: z.uuid(), // входящее сообщение, на которое идёт ход
      stepIndex: z.number().int().min(1), // сквозной номер шага агента за всю жизнь, = номер вызова модели
      text: z.string().nullable(), // content ответа модели; null — пусто
      toolCalls: z.array(z.strictObject({ id: z.string(), name: z.string() })), // в порядке ответа
    }),
  }),
  z.strictObject({
    ...Envelope,
    type: z.literal('agent.idle'),
    data: z.strictObject({ messageId: z.uuid() }),
  }),
  z.strictObject({
    ...Envelope,
    type: z.literal('agent.result'),
    data: z.strictObject({ text: z.string() }),
  }),
  z.strictObject({ ...Envelope, type: z.literal('agent.stopped'), data: z.strictObject({}) }),
  z.strictObject({
    ...Envelope,
    type: z.literal('agent.failed'),
    data: z.strictObject({ reason: z.string() }),
  }),
  z.strictObject({
    ...Envelope,
    type: z.literal('bus.message'),
    data: z.strictObject({
      messageId: z.uuid(),
      from: z.union([AgentId, z.literal('user')]),
      to: AgentId,
      text: z.string(),
    }),
  }),
  // Спека 002, 4.1: вызов модели через llm-gateway.
  z.strictObject({ ...Envelope, type: z.literal('llm.call'), data: LlmCallData }),
]);
export type PlatformEventInput = z.infer<typeof PlatformEventInput>;

// Хранится и отдаётся api: + сквозной номер внутри роя.
export type PlatformEvent = PlatformEventInput & { seq: number }; // seq ≥ 1, без пропусков
