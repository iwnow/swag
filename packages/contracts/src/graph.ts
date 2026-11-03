import { z } from 'zod';
import { NodeTypeRef } from './node.ts';
import { SecretName } from './node-invocation.ts';

// Id узла графа. 'user' занят источником задачи в BusMessage.
export const NodeId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,39}$/)
  .refine((id) => id !== 'user', 'node id "user" is reserved');
export type NodeId = z.infer<typeof NodeId>;

export const GRAPH_MAX_NODES = 16;
export const GRAPH_MAX_EDGES = 64;
export const GRAPH_MAX_AGENTS = 8; // как agents в SwarmCreateRequest и LlmSwarmRegistration

export const GraphNode = z.strictObject({
  id: NodeId,
  type: NodeTypeRef, // 'swag/llm-agent@1.0.0', 'example/echo@1.0.0'
  settings: z.record(z.string(), z.unknown()).default({}),
  credentials: z.record(z.string(), SecretName).default({}), // имя из credentials манифеста → секрет организации
});
export type GraphNode = z.infer<typeof GraphNode>;

export const EdgeKind = z.enum(['flow', 'link']);
export type EdgeKind = z.infer<typeof EdgeKind>;

// flow — выход from идёт входом в to. link — неориентированное: from и to пишут друг другу (Q-7).
export const GraphEdge = z.strictObject({ from: NodeId, to: NodeId, kind: EdgeKind });
export type GraphEdge = z.infer<typeof GraphEdge>;

export const ProcessGraph = z.strictObject({
  nodes: z.array(GraphNode).min(1).max(GRAPH_MAX_NODES),
  edges: z.array(GraphEdge).max(GRAPH_MAX_EDGES),
  entry: NodeId, // шаг, который получает задачу
  exit: NodeId, // шаг, чей выход — итог роя
});
export type ProcessGraph = z.infer<typeof ProcessGraph>;

export const GraphIssueCode = z.enum([
  'node_duplicate',
  'node_type_not_found',
  'node_kind_unsupported',
  'invalid_settings',
  'credentials_mismatch',
  'secret_not_found',
  'too_many_agents',
  'no_agents',
  'edge_unknown_node',
  'edge_self',
  'edge_duplicate',
  'link_requires_agents',
  'flow_not_at_team_entry',
  'flow_fan_in',
  'flow_cycle',
  'entry_unknown',
  'entry_has_input',
  'exit_unknown',
  'exit_not_step',
  'unreachable',
  'entry_input_invalid',
  'trigger_not_entry', // спека 033, 4.3
  'trigger_flow',
  'process_not_found', // спека 033, 4.4
  'process_cycle',
  'process_too_deep',
  'process_node_id_too_long',
  'process_invalid',
]);
export type GraphIssueCode = z.infer<typeof GraphIssueCode>;

export const GraphIssue = z.strictObject({
  code: GraphIssueCode,
  path: z.string(), // путь в графе через точку: 'nodes.2.settings.role', 'edges.5', 'entry'; корень — ''
  message: z.string(),
});
export type GraphIssue = z.infer<typeof GraphIssue>;

export const GraphCheckResult = z.strictObject({
  ok: z.boolean(), // true ⇔ issues пуст
  issues: z.array(GraphIssue),
});
export type GraphCheckResult = z.infer<typeof GraphCheckResult>;
