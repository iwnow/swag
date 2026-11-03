import { z } from 'zod';
import { BudgetMicroUsd, MaxTokens, MicroUsd, ModelId, PlatformModel } from './llm.ts';
import { OrgId } from './auth.ts';
import {
  GRAPH_MAX_AGENTS,
  GRAPH_MAX_EDGES,
  GRAPH_MAX_NODES,
  GraphEdge,
  NodeId,
  ProcessGraph,
} from './graph.ts';
import { NodeTypeRef } from './node.ts';
import { SecretName } from './node-invocation.ts';

// Спека 001, 4.1. Лимиты длин полей — предложение, утверждено в Q-3.
// Спека 009, 4.2: id агента — id узла графа; форма по-прежнему даёт agent-1 … agent-8.
export const AgentId = NodeId;
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

// Спека 009, 4.2: тело POST /swarms в виде графа. Граф проверяет api (4.4).
export const SwarmGraphRequest = z.strictObject({
  task: z.string().trim().min(1).max(4000),
  budgetMicroUsd: BudgetMicroUsd,
  maxTokens: MaxTokens.nullable().default(null),
  graph: ProcessGraph,
});
export type SwarmGraphRequest = z.infer<typeof SwarmGraphRequest>;

// Тело POST /swarms. Форма отличается от графа полем agents, граф — полем graph (обе схемы strict).
export const SwarmRequest = z.union([SwarmCreateRequest, SwarmGraphRequest]);
export type SwarmRequest = z.infer<typeof SwarmRequest>;

export const AgentSpec = AgentDraft.extend({ id: AgentId });
export type AgentSpec = z.infer<typeof AgentSpec>;

export const ENTRY_AGENT_ID = 'agent-1'; // агент-вход: получает задачу от user и только он завершает рой (022, Q-3)

export const SwarmStatus = z.enum(['starting', 'running', 'completed', 'stopped', 'failed']);
export type SwarmStatus = z.infer<typeof SwarmStatus>;

export const AgentStatus = z.enum(['starting', 'idle', 'working', 'done', 'stopped', 'failed']);
export type AgentStatus = z.infer<typeof AgentStatus>;

// Спека 009, 4.5: программа графа в SwarmLaunch — настройки и credentials после проверки api.
export const LaunchProgram = z.strictObject({
  id: NodeId,
  type: NodeTypeRef,
  settings: z.record(z.string(), z.unknown()), // после validateSettings: с умолчаниями
  credentials: z.record(z.string(), SecretName),
  stateKey: z.string().min(1).max(200).optional(), // нет — оркестратор берёт swarm:<swarmId>:<id> (как в 009; 033, REQ-033-18)
});
export type LaunchProgram = z.infer<typeof LaunchProgram>;

// Спека 033, 4.2: вход шага-входа от триггера запуска (REQ-033-15). null — задача пользователя, как в 009.
export const LaunchTrigger = z.strictObject({ nodeId: NodeId, event: z.unknown() });
export type LaunchTrigger = z.infer<typeof LaunchTrigger>;

// api → orchestrator. Строгая схема (4.6.1 спеки 001 остаётся).
export const SwarmLaunch = z.strictObject({
  swarmId: SwarmId,
  orgId: OrgId,
  task: z.string(),
  budgetMicroUsd: BudgetMicroUsd,
  maxTokens: MaxTokens.nullable(),
  agents: z.array(AgentSpec).min(1).max(GRAPH_MAX_AGENTS), // агенты графа: { ...настройки после validateSettings, id }
  programs: z.array(LaunchProgram).max(GRAPH_MAX_NODES),
  edges: z.array(GraphEdge).max(GRAPH_MAX_EDGES),
  entry: NodeId,
  exit: NodeId,
  trigger: LaunchTrigger.nullable().default(null), // спека 033, 4.2
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
