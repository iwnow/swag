import { z } from 'zod';

// Спека 001, 4.1. Лимиты длин полей — предложение, утверждено в Q-3.
export const AgentId = z.string().regex(/^agent-[1-9][0-9]?$/); // agent-1 … agent-99, назначает api по порядку
export type AgentId = z.infer<typeof AgentId>;

export const SwarmId = z.uuid();
export type SwarmId = z.infer<typeof SwarmId>;

export const AgentDraft = z.strictObject({
  name: z.string().trim().min(1).max(40),
  role: z.string().trim().min(1).max(500), // роль агента: текст обязанностей, не путать с ролью пользователя
});
export type AgentDraft = z.infer<typeof AgentDraft>;

export const SwarmCreateRequest = z.strictObject({
  task: z.string().trim().min(1).max(4000),
  agents: z.array(AgentDraft).min(1).max(8),
});
export type SwarmCreateRequest = z.infer<typeof SwarmCreateRequest>;

export const AgentSpec = AgentDraft.extend({ id: AgentId });
export type AgentSpec = z.infer<typeof AgentSpec>;

export const SwarmStatus = z.enum(['starting', 'running', 'completed', 'stopped', 'failed']);
export type SwarmStatus = z.infer<typeof SwarmStatus>;

export const AgentStatus = z.enum(['starting', 'idle', 'working', 'done', 'stopped', 'failed']);
export type AgentStatus = z.infer<typeof AgentStatus>;

// api → orchestrator. Строгая схема: лишнее поле (например, image) — ошибка (4.6.1).
export const SwarmLaunch = z.strictObject({
  swarmId: SwarmId,
  task: z.string(),
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
