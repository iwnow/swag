import { z } from 'zod';
import { BudgetMicroUsd, MaxTokens, MicroUsd, ModelId, PlatformModel } from './llm.ts';

// Спека 001, 4.1. Лимиты длин полей — предложение, утверждено в Q-3.
export const AgentId = z.string().regex(/^agent-[1-9][0-9]?$/); // agent-1 … agent-99, назначает api по порядку
export type AgentId = z.infer<typeof AgentId>;

export const SwarmId = z.uuid();
export type SwarmId = z.infer<typeof SwarmId>;

export const AgentDraft = z.strictObject({
  name: z.string().trim().min(1).max(40),
  role: z.string().trim().min(1).max(500), // роль агента: текст обязанностей, не путать с ролью пользователя
  model: PlatformModel.default('chat-small'),
  budgetMicroUsd: BudgetMicroUsd.nullable().default(null), // null — только бюджет роя (004, 4.1)
  maxTokens: MaxTokens.nullable().default(null), // null — значение роя (031, 4.4)
});
export type AgentDraft = z.infer<typeof AgentDraft>;

export const SwarmCreateRequest = z.strictObject({
  task: z.string().trim().min(1).max(4000),
  budgetMicroUsd: BudgetMicroUsd, // обязателен (004, Q-5)
  maxTokens: MaxTokens.nullable().default(null), // null — AGENT_MAX_TOKENS оркестратора (031, 4.4)
  agents: z.array(AgentDraft).min(1).max(8),
});
export type SwarmCreateRequest = z.infer<typeof SwarmCreateRequest>;

export const AgentSpec = AgentDraft.extend({ id: AgentId });
export type AgentSpec = z.infer<typeof AgentSpec>;

export const ENTRY_AGENT_ID = 'agent-1'; // агент-вход: получает задачу от user и только он завершает рой (022, Q-3)

export const SwarmStatus = z.enum(['starting', 'running', 'completed', 'stopped', 'failed']);
export type SwarmStatus = z.infer<typeof SwarmStatus>;

export const AgentStatus = z.enum(['starting', 'idle', 'working', 'done', 'stopped', 'failed']);
export type AgentStatus = z.infer<typeof AgentStatus>;

// api → orchestrator. Строгая схема: лишнее поле (например, image) — ошибка (4.6.1).
export const SwarmLaunch = z.strictObject({
  swarmId: SwarmId,
  task: z.string(),
  budgetMicroUsd: BudgetMicroUsd,
  maxTokens: MaxTokens.nullable(),
  agents: z.array(AgentSpec).min(1),
});
export type SwarmLaunch = z.infer<typeof SwarmLaunch>;

// 4.5.1
export const SwarmSummary = z.object({
  id: SwarmId,
  task: z.string(),
  status: SwarmStatus,
  agentCount: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type SwarmSummary = z.infer<typeof SwarmSummary>;

// Спека 002, 4.1: вызывающий LLM Gateway. Живёт в swarm.ts, а не в llm.ts: llm.ts не должен импортировать swarm.ts (цикл с PlatformModel).
export const LlmCaller = z.strictObject({ swarmId: SwarmId, agentId: AgentId });
export type LlmCaller = z.infer<typeof LlmCaller>;

// Спека 004, 4.1: регистрация роя в gateway, тело POST /internal/swarms. В swarm.ts, а не в llm.ts: llm.ts не импортирует swarm.ts (цикл, см. LlmCaller).
export const LlmSwarmRegistration = z.strictObject({
  swarmId: SwarmId,
  budgetMicroUsd: BudgetMicroUsd,
  expiresAt: z.iso.datetime().nullable(), // null — регистрация не истекает сама (SWARM_TIMEOUT_MS = 0)
  agents: z
    .array(
      z.strictObject({
        agentId: AgentId,
        model: ModelId,
        budgetMicroUsd: BudgetMicroUsd.nullable(),
      }),
    )
    .min(1)
    .max(8),
});
export type LlmSwarmRegistration = z.infer<typeof LlmSwarmRegistration>;

// Спека 004, 4.1: ответ закрытия роя в gateway. Лежит рядом с LlmSwarmRegistration по той же причине.
export const LlmSwarmClosed = z.strictObject({
  spentMicroUsd: MicroUsd,
  heldMicroUsd: MicroUsd, // резервы, не списанные к концу ожидания (013, 4.7); 0 — сумма окончательная
});
export type LlmSwarmClosed = z.infer<typeof LlmSwarmClosed>;
