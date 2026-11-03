import { describe, expect, it } from 'vitest';
import {
  AgentId,
  GRAPH_MAX_EDGES,
  GRAPH_MAX_NODES,
  GraphIssueCode,
  NodeId,
  PlatformEventInput,
  ProcessGraph,
  SwarmLaunch,
  SwarmRequest,
} from '../src/index.ts';

const llm = (id: string) => ({
  id,
  type: 'swag/llm-agent@1.0.0',
  settings: {},
  credentials: {},
});
const graph = (overrides: Record<string, unknown> = {}) => ({
  nodes: [llm('writer'), llm('critic')],
  edges: [{ from: 'writer', to: 'critic', kind: 'link' }],
  entry: 'writer',
  exit: 'critic',
  ...overrides,
});
const form = {
  task: 'Задача',
  budgetMicroUsd: 500000,
  agents: [{ name: 'Агент 1', role: 'роль' }],
};
const SWARM = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';
const ORG = '0b6f6d2e-6a4c-4c3e-9f5e-222222222222';
const base = {
  id: '0b6f6d2e-6a4c-4c3e-9f5e-333333333333',
  swarmId: SWARM,
  ts: '2026-11-03T10:00:00.000Z',
  agentId: null,
  traceId: null,
};

describe('NodeId', () => {
  it('NodeId отклоняет user', () => {
    expect(NodeId.safeParse('user').success).toBe(false);
  });

  it('NodeId принимает id в формате [a-z][a-z0-9-]{0,39}', () => {
    expect(NodeId.safeParse('writer').success).toBe(true);
    expect(NodeId.safeParse('agent-1').success).toBe(true);
    expect(NodeId.safeParse('a'.repeat(40)).success).toBe(true);
  });

  it('NodeId отклоняет заглавные буквы, цифру в начале и длину 41', () => {
    expect(NodeId.safeParse('Writer').success).toBe(false);
    expect(NodeId.safeParse('1writer').success).toBe(false);
    expect(NodeId.safeParse('a'.repeat(41)).success).toBe(false);
  });

  it('AgentId совпадает с NodeId: id графа допустим как id агента', () => {
    expect(AgentId.safeParse('writer').success).toBe(true);
    expect(AgentId.safeParse('user').success).toBe(false);
  });
});

describe('ProcessGraph', () => {
  it('принимает граф из двух агентов со связью', () => {
    expect(ProcessGraph.safeParse(graph()).success).toBe(true);
  });

  it('отклоняет граф больше GRAPH_MAX_NODES узлов', () => {
    const nodes = Array.from({ length: GRAPH_MAX_NODES + 1 }, (_, i) => llm(`n${i}`));
    expect(ProcessGraph.safeParse(graph({ nodes })).success).toBe(false);
  });

  it('отклоняет граф больше GRAPH_MAX_EDGES рёбер', () => {
    const edges = Array.from({ length: GRAPH_MAX_EDGES + 1 }, () => ({
      from: 'writer',
      to: 'critic',
      kind: 'link',
    }));
    expect(ProcessGraph.safeParse(graph({ edges })).success).toBe(false);
  });

  it('отклоняет неизвестный вид ребра и лишнее поле', () => {
    expect(
      ProcessGraph.safeParse(graph({ edges: [{ from: 'writer', to: 'critic', kind: 'both' }] }))
        .success,
    ).toBe(false);
    expect(ProcessGraph.safeParse({ ...graph(), extra: 1 }).success).toBe(false);
  });

  it('GraphIssueCode отклоняет код вне списка 4.1', () => {
    expect(GraphIssueCode.safeParse('flow_fan_in').success).toBe(true);
    expect(GraphIssueCode.safeParse('some_other_code').success).toBe(false);
  });
});

describe('SwarmRequest', () => {
  it('различает форму: принимает SwarmCreateRequest', () => {
    expect(SwarmRequest.safeParse(form).success).toBe(true);
  });

  it('различает граф: принимает SwarmGraphRequest с maxTokens по умолчанию null', () => {
    const parsed = SwarmRequest.safeParse({
      task: 'Задача',
      budgetMicroUsd: 500000,
      graph: graph(),
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'graph' in parsed.data && parsed.data.maxTokens).toBe(null);
  });

  it('отклоняет смесь формы и графа: поле agents вместе с graph', () => {
    expect(SwarmRequest.safeParse({ ...form, graph: graph() }).success).toBe(false);
  });

  it('отклоняет запрос без agents и без graph', () => {
    expect(SwarmRequest.safeParse({ task: 'Задача', budgetMicroUsd: 500000 }).success).toBe(false);
  });
});

describe('SwarmLaunch', () => {
  const launch = {
    swarmId: SWARM,
    orgId: ORG,
    task: 'Задача',
    budgetMicroUsd: 500000,
    maxTokens: null,
    agents: [
      {
        id: 'writer',
        name: 'Writer',
        role: 'роль',
        model: 'chat-small',
        budgetMicroUsd: null,
        maxTokens: null,
      },
    ],
    programs: [{ id: 'echo', type: 'example/echo@1.0.0', settings: {}, credentials: {} }],
    edges: [{ from: 'echo', to: 'writer', kind: 'flow' }],
    entry: 'echo',
    exit: 'writer',
  };

  it('принимает запуск с программами, рёбрами и orgId', () => {
    expect(SwarmLaunch.safeParse(launch).success).toBe(true);
  });

  it('отклоняет запуск без orgId и с лишним полем', () => {
    const { orgId: _orgId, ...noOrg } = launch;
    expect(SwarmLaunch.safeParse(noOrg).success).toBe(false);
    expect(SwarmLaunch.safeParse({ ...launch, image: 'x' }).success).toBe(false);
  });
});

describe('события графа', () => {
  it('swarm.created принимает граф роя в поле graph', () => {
    const event = {
      ...base,
      source: 'api',
      type: 'swarm.created',
      data: {
        task: 'Задача',
        agents: [{ id: 'writer', name: 'Writer', role: 'роль', model: 'chat-small' }],
        graph: graph(),
      },
    };
    expect(PlatformEventInput.safeParse(event).success).toBe(true);
  });

  it('swarm.created без graph остаётся валидным (старые события)', () => {
    const event = {
      ...base,
      source: 'api',
      type: 'swarm.created',
      data: {
        task: 'Задача',
        agents: [{ id: 'agent-1', name: 'A', role: 'р', model: 'chat-small' }],
      },
    };
    expect(PlatformEventInput.safeParse(event).success).toBe(true);
  });

  it('node.started, node.completed и node.failed принимают nodeId и отклоняют user', () => {
    const started = {
      ...base,
      source: 'orchestrator',
      type: 'node.started',
      data: { nodeId: 'echo', type: 'example/echo@1.0.0' },
    };
    const completed = {
      ...base,
      source: 'orchestrator',
      type: 'node.completed',
      data: { nodeId: 'echo', durationMs: 12 },
    };
    const failed = {
      ...base,
      source: 'orchestrator',
      type: 'node.failed',
      data: { nodeId: 'echo', code: 'timeout', message: 'таймаут', durationMs: 300 },
    };
    expect(PlatformEventInput.safeParse(started).success).toBe(true);
    expect(PlatformEventInput.safeParse(completed).success).toBe(true);
    expect(PlatformEventInput.safeParse(failed).success).toBe(true);
    expect(
      PlatformEventInput.safeParse({
        ...started,
        data: { nodeId: 'user', type: 'example/echo@1.0.0' },
      }).success,
    ).toBe(false);
  });

  it('node.failed отклоняет код ошибки вне NodeInvocationErrorCode', () => {
    const failed = {
      ...base,
      source: 'orchestrator',
      type: 'node.failed',
      data: { nodeId: 'echo', code: 'boom', message: 'x', durationMs: 1 },
    };
    expect(PlatformEventInput.safeParse(failed).success).toBe(false);
  });

  it('swarm.failed принимает причину node_failed', () => {
    const failed = {
      ...base,
      source: 'orchestrator',
      type: 'swarm.failed',
      data: { reason: 'node_failed', detail: 'echo: timeout' },
    };
    expect(PlatformEventInput.safeParse(failed).success).toBe(true);
  });
});
