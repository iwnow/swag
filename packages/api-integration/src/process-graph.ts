import {
  type AgentDraft,
  ENTRY_AGENT_ID,
  GRAPH_MAX_AGENTS,
  type GraphCheckResult,
  type GraphEdge,
  type GraphIssue,
  type GraphIssueCode,
  type GraphNode,
  type JobTrigger,
  NodeId,
  type NodeManifest,
  type ProcessGraph,
} from '@swag/contracts';
import type { NodeRegistry } from './node-registry.ts';

// Спека 009, 4.3. Форма роя → граф: агенты формы — узлы llm-agent, все пары связаны link.
export const LLM_AGENT_TYPE = 'swag/llm-agent@1.0.0';
// Спека 033, 4.5: встроенный триггер-расписание; общая для api-core и scheduler-core.
export const SCHEDULE_TRIGGER_TYPE = 'swag/schedule@1.0.0';

export function formGraph(agents: readonly AgentDraft[]): ProcessGraph {
  const ids = agents.map((_, i) => `agent-${i + 1}`);
  const edges: GraphEdge[] = [];
  ids.forEach((from, i) => {
    for (const to of ids.slice(i + 1)) edges.push({ from, to, kind: 'link' });
  });
  return {
    nodes: agents.map((draft, i) => ({
      id: ids[i]!,
      type: LLM_AGENT_TYPE,
      settings: { ...draft },
      credentials: {},
    })),
    edges,
    entry: ENTRY_AGENT_ID,
    exit: ENTRY_AGENT_ID,
  };
}

// Спека 009, 4.4. Проверка графа до резерва бюджета и запуска; ту же проверку без запуска даёт POST /graph-checks.
export interface GraphCheckDeps {
  registry: NodeRegistry; // 021, 4.2; 026, 4.2
  secretNames: ReadonlySet<string>; // имена секретов организации (026, 4.6)
  triggers?: boolean; // true — граф процесса (033, 4.3); без опции узел trigger — node_kind_unsupported
}

type Kind = 'llm-agent' | 'program' | 'trigger';
interface Participant {
  index: number;
  kind: Kind;
  manifest: NodeManifest;
}

function participantKind(kind: NodeManifest['kind'], triggers: boolean): Kind | null {
  if (kind === 'llm-agent' || kind === 'program') return kind;
  return triggers && kind === 'trigger' ? kind : null;
}

export function checkGraph(graph: ProcessGraph, deps: GraphCheckDeps): GraphCheckResult {
  const issues: GraphIssue[] = [];
  const report = (code: GraphIssueCode, path: string, message: string): void => {
    issues.push({ code, path, message });
  };
  const nodeIds = new Set(graph.nodes.map((node) => node.id));

  // Проход 1: узлы. В проходах 2–5 участвуют только узлы без замечаний этого прохода.
  const participants = new Map<NodeId, Participant>();
  const seen = new Set<NodeId>();
  graph.nodes.forEach((node, i) => {
    if (seen.has(node.id)) {
      report('node_duplicate', `nodes.${i}.id`, `node id "${node.id}" is already used`);
      return;
    }
    seen.add(node.id);
    const manifest = deps.registry.get(node.type);
    if (!manifest) {
      report(
        'node_type_not_found',
        `nodes.${i}.type`,
        `node type ${node.type} is not in the registry`,
      );
      return;
    }
    const kind = participantKind(manifest.kind, deps.triggers === true);
    if (kind === null) {
      report(
        'node_kind_unsupported',
        `nodes.${i}.type`,
        `kind ${manifest.kind} is not supported in a process graph yet`,
      );
      return;
    }
    participants.set(node.id, { index: i, kind, manifest });
  });

  // Проход 2: настройки, credentials, секреты, число агентов.
  graph.nodes.forEach((node, i) => {
    const participant = participants.get(node.id);
    if (!participant || participant.index !== i) return;
    const settings = deps.registry.validateSettings(node.type, node.settings);
    if (!settings.ok && settings.error.code === 'invalid_settings') {
      for (const issue of settings.error.issues) {
        report(
          'invalid_settings',
          issue.path ? `nodes.${i}.settings.${issue.path}` : `nodes.${i}.settings`,
          issue.message,
        );
      }
    }
    const declared = participant.manifest.credentials.map((credential) => credential.name).sort();
    const given = Object.keys(node.credentials).sort();
    if (declared.join(',') !== given.join(',')) {
      report(
        'credentials_mismatch',
        `nodes.${i}.credentials`,
        `credentials must be exactly: ${declared.join(', ') || 'none'}`,
      );
    }
    for (const [name, secret] of Object.entries(node.credentials)) {
      if (!deps.secretNames.has(secret)) {
        report(
          'secret_not_found',
          `nodes.${i}.credentials.${name}`,
          `secret ${secret} is not set for the organization`,
        );
      }
    }
  });
  const agentCount = [...participants.values()].filter((p) => p.kind === 'llm-agent').length;
  if (agentCount > GRAPH_MAX_AGENTS) {
    report('too_many_agents', 'nodes', `a graph has at most ${GRAPH_MAX_AGENTS} agents`);
  }
  if (agentCount === 0) report('no_agents', 'nodes', 'a graph needs at least one agent');

  // Проход 3: рёбра. Ребро с замечанием или с концом вне участников в проходах 4–5 не участвует.
  const kindOf = (id: NodeId): Kind | undefined => participants.get(id)?.kind;
  const excludedEdges = new Set<number>();
  const pairs = new Set<string>();
  graph.edges.forEach((edge, j) => {
    const path = `edges.${j}`;
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      report('edge_unknown_node', path, 'edge end is not a node of the graph');
      excludedEdges.add(j);
      return;
    }
    if (!participants.has(edge.from) || !participants.has(edge.to)) excludedEdges.add(j);
    if (edge.from === edge.to) {
      report('edge_self', path, 'edge starts and ends at the same node');
      excludedEdges.add(j);
    }
    const pair =
      edge.kind === 'link' ? [edge.from, edge.to].sort().join('|') : `${edge.from}>${edge.to}`;
    const key = `${edge.kind}:${pair}`;
    if (pairs.has(key)) {
      report('edge_duplicate', path, `${edge.kind} edge between these nodes already exists`);
      excludedEdges.add(j);
    }
    pairs.add(key);
    if (
      edge.kind === 'link' &&
      (kindOf(edge.from) !== 'llm-agent' || kindOf(edge.to) !== 'llm-agent')
    ) {
      report('link_requires_agents', path, 'link connects only agents');
      excludedEdges.add(j);
    }
  });
  const usable = graph.edges.flatMap((edge, j) => (excludedEdges.has(j) ? [] : [{ edge, j }]));
  const flows = usable.filter(({ edge }) => edge.kind === 'flow');

  // Шаг узла: программа — сама себе, агент — агент-вход своей команды (4.1).
  const agentIds = [...participants].filter(([, p]) => p.kind === 'llm-agent').map(([id]) => id);
  const teamEntryOf = teamEntries(
    agentIds,
    usable.map(({ edge }) => edge),
    graph.entry,
  );
  const stepOf = (id: NodeId): NodeId => teamEntryOf.get(id) ?? id;

  // Проход 4: потоки.
  for (const { edge, j } of flows) {
    if (stepOf(edge.from) !== edge.from || stepOf(edge.to) !== edge.to) {
      report(
        'flow_not_at_team_entry',
        `edges.${j}`,
        'flow must start and end at a step (program or team entry agent)',
      );
    }
  }
  // Триггер (033, 4.3): шаг-источник без входа. Не вход — trigger_not_entry, вход — ровно одно исходящее flow.
  for (const [id, participant] of participants) {
    if (participant.kind !== 'trigger') continue;
    if (id !== graph.entry) {
      report('trigger_not_entry', `nodes.${participant.index}`, `trigger ${id} must be the entry`);
      continue;
    }
    const outgoing = graph.edges.filter((edge) => edge.kind === 'flow' && edge.from === id).length;
    if (outgoing !== 1) {
      report(
        'trigger_flow',
        `nodes.${participant.index}`,
        `entry trigger must have exactly one outgoing flow, has ${outgoing}`,
      );
    }
  }
  const inboundCount = new Map<NodeId, number>();
  for (const { edge, j } of flows) {
    if (kindOf(edge.to) === 'trigger') {
      report('trigger_flow', `edges.${j}`, 'trigger has no input: flow must not end at a trigger');
      continue;
    }
    if (stepOf(edge.to) !== edge.to) continue;
    if (edge.to === graph.entry) {
      report('entry_has_input', `edges.${j}`, 'entry step must not have incoming flow');
      continue;
    }
    const count = (inboundCount.get(edge.to) ?? 0) + 1;
    inboundCount.set(edge.to, count);
    if (count > 1)
      report('flow_fan_in', `edges.${j}`, `step ${edge.to} already has an incoming flow`);
  }
  // Петля шага на себя (flow между агентами одной команды) — не цикл между шагами.
  const stepEdges = flows.flatMap(({ edge, j }) => {
    const from = stepOf(edge.from);
    const to = stepOf(edge.to);
    return from === to ? [] : [{ from, to, j }];
  });
  const stepLinks = adjacency(stepEdges);
  const inCycle = new Set<NodeId>();
  for (const { from } of stepEdges) {
    if (inCycle.has(from) || !reachableFrom(from, stepLinks, false).has(from)) continue;
    const forward = reachableFrom(from, stepLinks, true);
    const component = [...forward].filter((id) => reachableFrom(id, stepLinks, true).has(from));
    component.forEach((id) => inCycle.add(id));
    const inside = stepEdges.filter((e) => component.includes(e.from) && component.includes(e.to));
    const first = Math.min(...inside.map((e) => e.j));
    report('flow_cycle', `edges.${first}`, 'flow edges form a cycle');
  }

  // Проход 5: вход, выход, достижимость.
  if (!nodeIds.has(graph.entry))
    report('entry_unknown', 'entry', `entry ${graph.entry} is not a node`);
  if (!nodeIds.has(graph.exit)) {
    report('exit_unknown', 'exit', `exit ${graph.exit} is not a node`);
  } else if (
    kindOf(graph.exit) === 'trigger' ||
    (kindOf(graph.exit) === 'llm-agent' && stepOf(graph.exit) !== graph.exit)
  ) {
    report('exit_not_step', 'exit', 'exit must be a program or the entry agent of its team');
  }
  if (participants.has(graph.entry)) {
    const reached = reachableFrom(stepOf(graph.entry), stepLinks, true);
    for (const [id, participant] of participants) {
      // Триггер вне цепочки исполнения: его отсутствие в достижимости — trigger_not_entry.
      if (stepOf(id) !== id || reached.has(id) || participant.kind === 'trigger') continue;
      report(
        'unreachable',
        `nodes.${participant.index}`,
        `step ${id} is not reachable from the entry`,
      );
    }
  }

  return { ok: issues.length === 0, issues };
}

// Спека 033, 4.3. Граф исполнения: триггер и его flow убраны, entry — цель flow триггера. Вход — граф без замечаний checkGraph.
export function launchGraph(
  graph: ProcessGraph,
  registry: NodeRegistry,
): { graph: ProcessGraph; trigger: JobTrigger | null } {
  const triggerNode = graph.nodes.find((node) => registry.get(node.type)?.kind === 'trigger');
  if (!triggerNode) return { graph, trigger: null };
  const flow = graph.edges.find((edge) => edge.kind === 'flow' && edge.from === triggerNode.id);
  const settings = registry.validateSettings(triggerNode.type, triggerNode.settings);
  if (!flow || !settings.ok) throw new Error('launchGraph: graph has checkGraph issues');
  return {
    graph: {
      nodes: graph.nodes.filter((node) => node !== triggerNode),
      edges: graph.edges.filter(
        (edge) => edge.from !== triggerNode.id && edge.to !== triggerNode.id,
      ),
      entry: flow.to,
      exit: graph.exit,
    },
    trigger: {
      nodeId: triggerNode.id,
      type: triggerNode.type,
      settings: settings.settings,
      credentials: triggerNode.credentials,
    },
  };
}

// Спека 033, 4.4. Процесс-узел разворачивается в узлы родителя; узлы корня — глубина 1.
export const PROCESS_NODE_TYPE = 'swag/process@1.0.0';
export const PROCESS_NEST_MAX_DEPTH = 3; // корень + два уровня вложенности

export interface NodeOrigin {
  processId: string;
  nodeId: NodeId;
} // процесс и id узла в его графе

export type ExpandResult =
  | { ok: true; graph: ProcessGraph; origin: Record<NodeId, NodeOrigin | null> } // null — узел корневого графа
  | { ok: false; issues: GraphIssue[] };

// Цикл, глубина и длина id относятся к цепочке целиком: не оборачиваются в process_invalid.
const CHAIN_ISSUE_CODES: readonly GraphIssueCode[] = [
  'process_cycle',
  'process_too_deep',
  'process_node_id_too_long',
];

// rootId — id процесса корневого графа (null у POST /swarms); children — графы процессов организации по id.
// registry нужен, чтобы узнать вид trigger у дочернего графа (033, D-184): триггер и его flow убираются через launchGraph.
export function expandGraph(
  graph: ProcessGraph,
  children: ReadonlyMap<string, ProcessGraph>,
  rootId: string | null,
  registry: NodeRegistry,
): ExpandResult {
  return expandLevel(graph, children, registry, null, rootId === null ? [] : [rootId], '', 1);
}

// owner — процесс этого графа (null у корня), chain — процессы от корня до него, prefix — `<p>-` по цепочке, level — глубина графа.
function expandLevel(
  graph: ProcessGraph,
  children: ReadonlyMap<string, ProcessGraph>,
  registry: NodeRegistry,
  owner: string | null,
  chain: readonly string[],
  prefix: string,
  level: number,
): ExpandResult {
  const issues: GraphIssue[] = [];
  const nodes: GraphNode[] = [];
  const origin: Record<NodeId, NodeOrigin | null> = {};
  const innerEdges: GraphEdge[] = [];
  const bounds = new Map<NodeId, { entry: NodeId; exit: NodeId }>();

  graph.nodes.forEach((node, i) => {
    if (node.type !== PROCESS_NODE_TYPE) {
      const id = prefix + node.id;
      if (!NodeId.safeParse(id).success) {
        issues.push({
          code: 'process_node_id_too_long',
          path: `nodes.${i}.id`,
          message: `node id "${id}" is not a valid node id`,
        });
        return;
      }
      nodes.push({ ...node, id });
      origin[id] = owner === null ? null : { processId: owner, nodeId: node.id };
      return;
    }

    const childId = String(node.settings.processId);
    const path = `nodes.${i}.settings.processId`;
    const child = children.get(childId);
    if (!child) {
      issues.push({ code: 'process_not_found', path, message: `process ${childId} is not found` });
      return;
    }
    if (chain.includes(childId)) {
      issues.push({ code: 'process_cycle', path, message: `process ${childId} includes itself` });
      return;
    }
    if (level > PROCESS_NEST_MAX_DEPTH - 1) {
      issues.push({
        code: 'process_too_deep',
        path,
        message: `process nesting is deeper than ${PROCESS_NEST_MAX_DEPTH}`,
      });
      return;
    }

    const expanded = expandLevel(
      launchGraph(child, registry).graph,
      children,
      registry,
      childId,
      [...chain, childId],
      `${prefix}${node.id}-`,
      level + 1,
    );
    if (!expanded.ok) {
      const first = expanded.issues[0]!;
      issues.push(
        CHAIN_ISSUE_CODES.includes(first.code)
          ? first
          : { code: 'process_invalid', path, message: `${first.code} at ${first.path}` },
      );
      return;
    }
    bounds.set(node.id, { entry: expanded.graph.entry, exit: expanded.graph.exit });
    nodes.push(...expanded.graph.nodes);
    innerEdges.push(...expanded.graph.edges);
    Object.assign(origin, expanded.origin);
  });

  if (issues.length > 0) return { ok: false, issues };

  const entryOf = (id: NodeId): NodeId => bounds.get(id)?.entry ?? prefix + id;
  const exitOf = (id: NodeId): NodeId => bounds.get(id)?.exit ?? prefix + id;
  return {
    ok: true,
    graph: {
      nodes,
      edges: [
        ...graph.edges.map((edge) => ({
          from: exitOf(edge.from),
          to: entryOf(edge.to),
          kind: edge.kind,
        })),
        ...innerEdges,
      ],
      entry: entryOf(graph.entry),
      exit: exitOf(graph.exit),
    },
    origin,
  };
}

function adjacency(edges: readonly { from: NodeId; to: NodeId }[]): Map<NodeId, NodeId[]> {
  const result = new Map<NodeId, NodeId[]>();
  for (const { from, to } of edges) result.set(from, [...(result.get(from) ?? []), to]);
  return result;
}

// Узлы, достижимые из start по ребрам adj. withStart — включать ли сам start.
function reachableFrom(start: NodeId, adj: Map<NodeId, NodeId[]>, withStart: boolean): Set<NodeId> {
  const seen = new Set<NodeId>(withStart ? [start] : []);
  const stack = [...(adj.get(start) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(adj.get(id) ?? []));
  }
  return seen;
}

// Спека 009, 4.1: команда — компонента агентов по link; агент-вход — graph.entry, иначе цель первого входящего flow команды, иначе первый агент.
function teamEntries(
  agentIds: readonly NodeId[],
  edges: readonly GraphEdge[],
  entry: NodeId,
): Map<NodeId, NodeId> {
  const links = adjacency(linkEdges(edges));
  const result = new Map<NodeId, NodeId>();
  for (const id of agentIds) {
    if (result.has(id)) continue;
    const reached = reachableFrom(id, links, true);
    const members = agentIds.filter((agent) => reached.has(agent));
    const inbound = edges.find((edge) => edge.kind === 'flow' && members.includes(edge.to));
    const teamEntry = members.includes(entry) ? entry : (inbound?.to ?? members[0]!);
    for (const member of members) result.set(member, teamEntry);
  }
  return result;
}

function linkEdges(edges: readonly GraphEdge[]): { from: NodeId; to: NodeId }[] {
  return edges
    .filter((edge) => edge.kind === 'link')
    .flatMap((edge) => [
      { from: edge.from, to: edge.to },
      { from: edge.to, to: edge.from },
    ]);
}

// Спека 009, 4.6. План исполнения: шаги, команды, соседи по link, цели потоков.
export interface TeamPlan {
  entry: NodeId; // агент-вход
  members: NodeId[]; // все агенты команды, в порядке узлов графа, вход — среди них
}

export type Step = { kind: 'program'; id: NodeId } | { kind: 'team'; id: NodeId; team: TeamPlan }; // id команды — id её агента-входа

export interface GraphPlan {
  steps: Step[]; // программы, затем команды в порядке первого агента
  stepOf(nodeId: NodeId): Step; // шаг узла: программа или команда, где узел — участник
  next(stepId: NodeId): NodeId[]; // цели исходящих flow шага, в порядке рёбер
  peers(agentId: NodeId): NodeId[]; // соседи по link, в порядке узлов графа
  entry: NodeId; // id шага-входа
  exit: NodeId; // id шага-выхода
}

// Вход — граф без замечаний checkGraph (агенты из SwarmLaunch.agents, программы из programs).
export function graphPlan(input: {
  agents: readonly { id: NodeId }[];
  programs: readonly { id: NodeId }[];
  edges: readonly GraphEdge[];
  entry: NodeId;
  exit: NodeId;
}): GraphPlan {
  const agentIds = input.agents.map((agent) => agent.id);
  const teamEntryOf = teamEntries(agentIds, input.edges, input.entry);
  const teamMembers = new Map<NodeId, NodeId[]>();
  for (const id of agentIds) {
    const entry = teamEntryOf.get(id)!;
    teamMembers.set(entry, [...(teamMembers.get(entry) ?? []), id]);
  }
  const steps: Step[] = [
    ...input.programs.map((program): Step => ({ kind: 'program', id: program.id })),
    ...[...teamMembers].map(([id, members]): Step => ({
      kind: 'team',
      id,
      team: { entry: id, members },
    })),
  ];
  const byNode = new Map<NodeId, Step>();
  for (const step of steps) {
    if (step.kind === 'program') byNode.set(step.id, step);
    else for (const member of step.team.members) byNode.set(member, step);
  }
  const stepOf = (nodeId: NodeId): Step => {
    const step = byNode.get(nodeId);
    if (!step) throw new Error(`node ${nodeId} is not in the plan`);
    return step;
  };
  const links = adjacency(linkEdges(input.edges));
  return {
    steps,
    stepOf,
    next: (stepId) =>
      input.edges
        .filter((edge) => edge.kind === 'flow' && stepOf(edge.from).id === stepId)
        .map((edge) => edge.to),
    peers: (agentId) =>
      agentIds.filter((other) => other !== agentId && (links.get(agentId) ?? []).includes(other)),
    entry: stepOf(input.entry).id,
    exit: stepOf(input.exit).id,
  };
}

// Спека 009, 4.6. Значение потока как текст: поле text объекта, строка как есть, прочее — JSON.
export function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (
    typeof value === 'object' &&
    value !== null &&
    'text' in value &&
    typeof value.text === 'string'
  ) {
    return value.text;
  }
  return JSON.stringify(value) ?? 'null';
}
