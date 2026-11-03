import { z } from 'zod';
import { OrgId } from './auth.ts';
import { ProcessGraph, NodeId } from './graph.ts';
import { BudgetMicroUsd, MaxTokens } from './llm.ts';
import { NodeTypeRef } from './node.ts';
import { SecretName } from './node-invocation.ts';
import { SwarmStatus } from './swarm.ts';

// Спека 033, 4.1. Процесс, задание и запуск процесса.
export const ProcessId = z.uuid();
export type ProcessId = z.infer<typeof ProcessId>;

export const PROCESS_POLL_MIN_SEC = 60;
export const PROCESS_MAX_CONCURRENT = 4;

// Определение процесса: тело POST и PUT /processes. Бюджет и maxTokens — на один запуск.
export const ProcessDraft = z.strictObject({
  name: z.string().trim().min(1).max(100),
  graph: ProcessGraph,
  budgetMicroUsd: BudgetMicroUsd,
  maxTokens: MaxTokens.nullable().default(null),
  pollIntervalSec: z.number().int().min(PROCESS_POLL_MIN_SEC).max(86_400).default(300), // swag/schedule не использует
  maxConcurrent: z.number().int().min(1).max(PROCESS_MAX_CONCURRENT).default(1),
});
export type ProcessDraft = z.infer<typeof ProcessDraft>;

// --- задание: api → планировщик ---

export const JobTrigger = z.strictObject({
  nodeId: NodeId,
  type: NodeTypeRef,
  settings: z.record(z.string(), z.unknown()), // после validateSettings
  credentials: z.record(z.string(), SecretName),
});
export type JobTrigger = z.infer<typeof JobTrigger>;

// Тело PUT /jobs/:processId.
export const JobSpec = z.strictObject({
  orgId: OrgId,
  createdBy: z.uuid(),
  trigger: JobTrigger.nullable(), // null — процесс без триггера: только ручной запуск
  pollIntervalSec: z.number().int().min(PROCESS_POLL_MIN_SEC).max(86_400),
  maxConcurrent: z.number().int().min(1).max(PROCESS_MAX_CONCURRENT),
});
export type JobSpec = z.infer<typeof JobSpec>;

export const JobDisabledReason = z.enum(['user', 'poll_failed', 'author_blocked']);
export type JobDisabledReason = z.infer<typeof JobDisabledReason>;

export const JobDisableRequest = z.strictObject({ reason: z.enum(['user', 'author_blocked']) });
export type JobDisableRequest = z.infer<typeof JobDisableRequest>;

export const JobError = z.strictObject({
  code: z.string().max(64), // NodeInvocationErrorCode, orchestrator_unavailable, schedule_exhausted
  message: z.string().max(1000),
  at: z.iso.datetime(),
});
export type JobError = z.infer<typeof JobError>;

export const JobState = z.strictObject({
  processId: ProcessId,
  enabled: z.boolean(),
  disabledReason: JobDisabledReason.nullable(), // null у включённого и у нового
  nextRunAt: z.iso.datetime().nullable(), // null у выключенного
  lastPollAt: z.iso.datetime().nullable(),
  lastError: JobError.nullable(),
  consecutiveFailures: z.number().int().min(0),
  queued: z.number().int().min(0), // запусков в queued и launching
  running: z.number().int().min(0), // запусков в running
});
export type JobState = z.infer<typeof JobState>;

export const JobStatesRequest = z.strictObject({ processIds: z.array(ProcessId).max(200) });
export type JobStatesRequest = z.infer<typeof JobStatesRequest>;
export const JobStateList = z.strictObject({ items: z.array(JobState) }); // только найденные задания
export type JobStateList = z.infer<typeof JobStateList>;

// --- запуск процесса ---

export const RunStatus = z.enum([
  'queued',
  'launching',
  'running',
  'completed',
  'failed',
  'stopped',
  'rejected',
  'cancelled',
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const RunRejectReason = z.enum(['insufficient_balance', 'invalid_graph']);
export type RunRejectReason = z.infer<typeof RunRejectReason>;

export const RunSource = z.enum(['trigger', 'manual']);
export type RunSource = z.infer<typeof RunSource>;

// Тело POST /processes/:id/runs (публичное) и POST /jobs/:processId/runs (планировщик, source всегда manual).
export const RunRequest = z.strictObject({ event: z.unknown() });
export type RunRequest = z.infer<typeof RunRequest>;

export const ProcessRunView = z.strictObject({
  id: z.uuid(), // = swarmId исполнения
  processId: ProcessId,
  status: RunStatus,
  reason: RunRejectReason.nullable(), // только у rejected
  source: RunSource,
  createdAt: z.iso.datetime(),
  launchedAt: z.iso.datetime().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type ProcessRunView = z.infer<typeof ProcessRunView>;

export const ProcessRunList = z.strictObject({ items: z.array(ProcessRunView) }); // createdAt по убыванию, не больше 50
export type ProcessRunList = z.infer<typeof ProcessRunList>;

// --- внутренний API api для планировщика ---

export const RunLaunchRequest = z.strictObject({
  runId: z.uuid(),
  processId: ProcessId,
  event: z.unknown(),
});
export type RunLaunchRequest = z.infer<typeof RunLaunchRequest>;

export const RunLaunchResult = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('launched') }), // в том числе исполнение с этим id уже есть
  z.strictObject({ outcome: z.literal('rejected'), reason: RunRejectReason }),
  z.strictObject({ outcome: z.literal('busy') }), // too_many_active_swarms
  z.strictObject({ outcome: z.literal('process_not_found') }),
]);
export type RunLaunchResult = z.infer<typeof RunLaunchResult>;

export const RunStatusRequest = z.strictObject({ runIds: z.array(z.uuid()).max(200) });
export type RunStatusRequest = z.infer<typeof RunStatusRequest>;
export const RunStatusList = z.strictObject({
  items: z.array(z.strictObject({ runId: z.uuid(), status: SwarmStatus.nullable() })), // null — исполнения нет
});
export type RunStatusList = z.infer<typeof RunStatusList>;

// --- публичное представление процесса в api ---

export const ProcessView = z.strictObject({
  id: ProcessId,
  orgId: OrgId,
  createdBy: z.uuid(),
  definition: ProcessDraft, // после разбора: с умолчаниями
  trigger: z.strictObject({ nodeId: NodeId, type: NodeTypeRef }).nullable(),
  job: JobState.omit({ processId: true }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProcessView = z.infer<typeof ProcessView>;

export const ProcessSummary = z.strictObject({
  id: ProcessId,
  orgId: OrgId,
  createdBy: z.uuid(),
  name: z.string(),
  trigger: ProcessView.shape.trigger,
  job: ProcessView.shape.job,
  updatedAt: z.iso.datetime(),
});
export type ProcessSummary = z.infer<typeof ProcessSummary>;
export const ProcessList = z.strictObject({ items: z.array(ProcessSummary) }); // updatedAt по убыванию
export type ProcessList = z.infer<typeof ProcessList>;
