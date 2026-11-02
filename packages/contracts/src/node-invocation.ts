import { z } from 'zod';
import { EgressHost, NodeErrorCode, NodeTypeName, NodeTypeRef, NodeTypeVersion } from './node.ts';

// Спека 026, 4.1. Вызов узла, секреты организации, грант выхода.
export const SecretName = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export type SecretName = z.infer<typeof SecretName>;

export const SecretValue = z.string().min(1).max(8192);
export type SecretValue = z.infer<typeof SecretValue>;

// Значение наружу не отдаётся; hint — последние 4 символа, только если в значении не меньше 16 символов.
export const SecretSummary = z.strictObject({
  name: SecretName,
  hint: z.string().length(4).nullable(),
  updatedAt: z.iso.datetime(),
});
export type SecretSummary = z.infer<typeof SecretSummary>;

export const SecretList = z.strictObject({ items: z.array(SecretSummary) }); // по name по возрастанию
export type SecretList = z.infer<typeof SecretList>;

export const SecretPutRequest = z.strictObject({ value: SecretValue });
export type SecretPutRequest = z.infer<typeof SecretPutRequest>;

export const NodeCall = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('execute'), input: z.unknown() }), // program
  z.strictObject({
    kind: z.literal('operation'),
    operation: z.string().min(1),
    input: z.unknown(),
  }), // connector
  z.strictObject({ kind: z.literal('poll'), cursor: z.string().max(4096).nullable() }), // trigger, channel
  z.strictObject({ kind: z.literal('send'), message: z.unknown() }), // channel
]);
export type NodeCall = z.infer<typeof NodeCall>;

export const NodeInvocation = z.strictObject({
  orgId: z.uuid(),
  type: NodeTypeRef,
  call: NodeCall,
  settings: z.record(z.string(), z.unknown()),
  credentials: z.record(z.string(), SecretName), // имя из credentials манифеста → имя секрета организации
  stateKey: z.string().min(1).max(200), // в 009 — id узла графа
  timeoutMs: z.number().int().min(1000).max(300_000).optional(), // по умолчанию NODE_INVOKE_TIMEOUT_MS
});
export type NodeInvocation = z.infer<typeof NodeInvocation>;

export const NodeInvocationErrorCode = z.enum([
  'node_type_not_found',
  'not_executable', // llm-agent, human
  'invalid_call',
  'unknown_operation',
  'invalid_settings',
  'invalid_input',
  'invalid_output',
  'secret_missing',
  'secret_not_declared',
  'egress_denied',
  'node_failed',
  'timeout',
  'sandbox_failed',
  'protocol_error',
]);
export type NodeInvocationErrorCode = z.infer<typeof NodeInvocationErrorCode>;

export const NodeInvocationResult = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), output: z.unknown(), durationMs: z.number().int().min(0) }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({ code: NodeInvocationErrorCode, message: z.string().max(1000) }),
    durationMs: z.number().int().min(0),
  }),
]);
export type NodeInvocationResult = z.infer<typeof NodeInvocationResult>;

export const EgressGrant = z.strictObject({
  invocationId: z.uuid(),
  egress: z.array(EgressHost).max(16),
  expiresAt: z.number().int(), // мс эпохи
});
export type EgressGrant = z.infer<typeof EgressGrant>;

// Спека 026, 4.8. Кадры протокола stdin/stdout: по одному JSON на строку. Лимиты длин — у оркестратора, не здесь.
const InvokeFrame = z.strictObject({
  t: z.literal('invoke'),
  invocationId: z.uuid(),
  package: z.string().min(1),
  definition: z.strictObject({ type: NodeTypeName, version: NodeTypeVersion }),
  call: NodeCall,
  settings: z.record(z.string(), z.unknown()),
  secrets: z.record(z.string(), z.string()),
  egressProxy: z.strictObject({ url: z.string().min(1), token: z.string().min(1) }),
  deadline: z.number().int(), // мс эпохи
});

const StateValueFrame = z.strictObject({
  t: z.literal('state'),
  id: z.number().int(),
  value: z.string().nullable(),
});

const StateErrorFrame = z.strictObject({
  t: z.literal('state'),
  id: z.number().int(),
  error: z.string(),
});

const AbortFrame = z.strictObject({ t: z.literal('abort') });

export const HostFrame = z.union([InvokeFrame, StateValueFrame, StateErrorFrame, AbortFrame]);
export type HostFrame = z.infer<typeof HostFrame>;

const LogFrame = z.strictObject({
  t: z.literal('log'),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  msg: z.string(),
  data: z.unknown().optional(),
});

const StateGetFrame = z.strictObject({
  t: z.literal('state.get'),
  id: z.number().int(),
  key: z.string(),
});

const StateSetFrame = z.strictObject({
  t: z.literal('state.set'),
  id: z.number().int(),
  key: z.string(),
  value: z.string().nullable(),
});

const ResultOkFrame = z.strictObject({
  t: z.literal('result'),
  ok: z.literal(true),
  output: z.unknown(),
});

const ResultFailFrame = z.strictObject({
  t: z.literal('result'),
  ok: z.literal(false),
  code: z.union([NodeErrorCode, z.literal('node_failed')]),
  message: z.string(),
});

export const SandboxFrame = z.union([
  LogFrame,
  StateGetFrame,
  StateSetFrame,
  ResultOkFrame,
  ResultFailFrame,
]);
export type SandboxFrame = z.infer<typeof SandboxFrame>;
