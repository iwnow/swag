import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type AgentDraft,
  type GraphEdge,
  type GraphIssue,
  NodeManifest,
  type ProcessGraph,
} from '@swag/contracts';
import { describe, expect, it } from 'vitest';
import { checkGraph, createNodeRegistry, formGraph } from '../src/index.ts';

// Спека 009, 4.4: тестовый реестр — манифесты swag/llm-agent и example/echo из пакетов узлов,
// плюс тестовые trigger и program (program с credential apiKey).
const readPackageManifest = (pkg: string): unknown =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../${pkg}/swag-node.json`, import.meta.url)), 'utf8'),
  );

const EMPTY_SETTINGS = { type: 'object', properties: {}, additionalProperties: false };
const TEXT_IO = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

const TRIGGER = {
  type: 'test/trigger',
  version: '1.0.0',
  kind: 'trigger',
  title: 'Триггер',
  description: 'Тестовый триггер.',
  settings: EMPTY_SETTINGS,
  credentials: [],
  inputs: null,
  outputs: TEXT_IO,
  operations: [],
  egress: [],
};

const PROGRAM = {
  type: 'test/program',
  version: '1.0.0',
  kind: 'program',
  title: 'Программа',
  description: 'Тестовая программа с credential apiKey.',
  settings: EMPTY_SETTINGS,
  credentials: [{ name: 'apiKey', title: 'Ключ', kind: 'api-key' }],
  inputs: TEXT_IO,
  outputs: TEXT_IO,
  operations: [],
  egress: [],
};

const registryResult = createNodeRegistry(
  [
    readPackageManifest('node-llm-agent'),
    readPackageManifest('node-example'),
    TRIGGER,
    PROGRAM,
  ].map((manifest) => NodeManifest.parse(manifest)),
);
if (!registryResult.ok) throw new Error('test registry is invalid');
const registry = registryResult.registry;

const AGENT = 'swag/llm-agent@1.0.0';
const ECHO = 'example/echo@1.0.0';
const PROG = 'test/program@1.0.0';
const TRIG = 'test/trigger@1.0.0';
const SECRETS = new Set(['missing-key']);

const agent = (id: string) => ({
  id,
  type: AGENT,
  settings: { name: id, role: 'r' },
  credentials: {},
});
const program = (id: string, credentials: Record<string, string> = { apiKey: 'missing-key' }) => ({
  id,
  type: PROG,
  settings: {},
  credentials,
});
const echo = (id: string) => ({ id, type: ECHO, settings: {}, credentials: {} });

function graph(overrides: Partial<ProcessGraph>): ProcessGraph {
  return {
    nodes: [agent('a')],
    edges: [],
    entry: 'a',
    exit: 'a',
    ...overrides,
  } as ProcessGraph;
}

const check = (g: ProcessGraph, secretNames: ReadonlySet<string> = SECRETS) =>
  checkGraph(g, { registry, secretNames });
const codes = (issues: GraphIssue[]) => issues.map((issue) => issue.code);
const find = (issues: GraphIssue[], code: string) => issues.filter((issue) => issue.code === code);

const DRAFT: AgentDraft = {
  name: 'Автор',
  role: 'пишет',
  model: 'chat-small',
  budgetMicroUsd: null,
  maxTokens: null,
};

describe('formGraph', () => {
  it('AC-009-1: форма из 3 агентов — узлы agent-1…3, link (1,2), (1,3), (2,3), вход и выход agent-1', () => {
    const second = { ...DRAFT, name: 'Второй' };
    const third = { ...DRAFT, name: 'Третий' };
    const g = formGraph([DRAFT, second, third]);
    expect(g.nodes).toEqual([
      { id: 'agent-1', type: AGENT, settings: DRAFT, credentials: {} },
      { id: 'agent-2', type: AGENT, settings: second, credentials: {} },
      { id: 'agent-3', type: AGENT, settings: third, credentials: {} },
    ]);
    expect(g.edges).toEqual([
      { from: 'agent-1', to: 'agent-2', kind: 'link' },
      { from: 'agent-1', to: 'agent-3', kind: 'link' },
      { from: 'agent-2', to: 'agent-3', kind: 'link' },
    ]);
    expect(g.entry).toBe('agent-1');
    expect(g.exit).toBe('agent-1');
  });

  it('форма из 3 агентов проходит checkGraph без замечаний', () => {
    expect(check(formGraph([DRAFT, DRAFT, DRAFT]))).toEqual({ ok: true, issues: [] });
  });
});

describe('checkGraph', () => {
  it('AC-009-2: граф agent-1 — agent-2 по link с входом и выходом agent-1 проходит без замечаний', () => {
    const g = graph({
      nodes: [agent('agent-1'), agent('agent-2')],
      edges: [{ from: 'agent-1', to: 'agent-2', kind: 'link' }],
      entry: 'agent-1',
      exit: 'agent-1',
    });
    expect(check(g)).toEqual({ ok: true, issues: [] });
  });

  it('AC-009-3: дубль id, неизвестный тип и вид trigger дают все три замечания сразу', () => {
    const g = graph({
      nodes: [
        agent('a'),
        agent('a'),
        { id: 'u', type: 'test/unknown@1.0.0', settings: {}, credentials: {} },
        { id: 't', type: TRIG, settings: {}, credentials: {} },
      ],
    });
    const result = check(g);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      { code: 'node_duplicate', path: 'nodes.1.id', message: expect.any(String) },
      { code: 'node_type_not_found', path: 'nodes.2.type', message: expect.any(String) },
      { code: 'node_kind_unsupported', path: 'nodes.3.type', message: expect.any(String) },
    ]);
    expect(result.issues[2]?.message).toBe('kind trigger is not supported in a process graph yet');
  });

  it('AC-009-4: пустой role — invalid_settings по пути nodes.0.settings.role, лишний credential — credentials_mismatch', () => {
    const g = graph({
      nodes: [
        { id: 'a', type: AGENT, settings: { name: 'a', role: '' }, credentials: {} },
        program('p', { apiKey: 'missing-key' }),
      ],
      edges: [{ from: 'a', to: 'p', kind: 'flow' }],
      entry: 'a',
      exit: 'p',
    });
    expect(check(g).issues).toContainEqual({
      code: 'invalid_settings',
      path: 'nodes.0.settings.role',
      message: expect.any(String),
    });

    const extra = graph({ nodes: [agent('a'), program('p', { x: 'missing-key' })] });
    expect(find(check(extra).issues, 'credentials_mismatch')).toEqual([
      { code: 'credentials_mismatch', path: 'nodes.1.credentials', message: expect.any(String) },
    ]);
  });

  it('AC-009-5: credential вне секретов организации — secret_not_found, с секретом — без замечаний', () => {
    const g = graph({
      nodes: [agent('a'), program('p', { apiKey: 'missing-key' })],
      edges: [{ from: 'a', to: 'p', kind: 'flow' }],
      entry: 'a',
      exit: 'p',
    });
    expect(check(g, new Set())).toEqual({
      ok: false,
      issues: [
        {
          code: 'secret_not_found',
          path: 'nodes.1.credentials.apiKey',
          message: expect.any(String),
        },
      ],
    });
    expect(check(g, new Set(['missing-key']))).toEqual({ ok: true, issues: [] });
  });

  it('AC-009-6: неизвестный конец, петля, дубль link в обратном порядке и link агент–программа', () => {
    const g = graph({
      nodes: [agent('a'), agent('b'), program('p')],
      edges: [
        { from: 'a', to: 'zz', kind: 'link' },
        { from: 'a', to: 'a', kind: 'link' },
        { from: 'a', to: 'b', kind: 'link' },
        { from: 'b', to: 'a', kind: 'link' },
        { from: 'a', to: 'p', kind: 'link' },
      ],
    });
    const { issues } = check(g);
    expect(issues).toContainEqual({
      code: 'edge_unknown_node',
      path: 'edges.0',
      message: expect.any(String),
    });
    expect(issues).toContainEqual({
      code: 'edge_self',
      path: 'edges.1',
      message: expect.any(String),
    });
    expect(issues).toContainEqual({
      code: 'edge_duplicate',
      path: 'edges.3',
      message: expect.any(String),
    });
    expect(issues).toContainEqual({
      code: 'link_requires_agents',
      path: 'edges.4',
      message: expect.any(String),
    });
  });

  it('AC-009-7: flow в агента, который не вход команды, — flow_not_at_team_entry', () => {
    const g = graph({
      nodes: [agent('a'), agent('b'), program('p')],
      edges: [
        { from: 'a', to: 'b', kind: 'link' },
        { from: 'p', to: 'b', kind: 'flow' },
      ],
    });
    expect(check(g).issues).toContainEqual({
      code: 'flow_not_at_team_entry',
      path: 'edges.1',
      message: expect.any(String),
    });
  });

  it('AC-009-8: второй flow в программу — flow_fan_in, flow в шаг-вход — entry_has_input', () => {
    const g = graph({
      nodes: [agent('a'), program('p'), program('q')],
      edges: [
        { from: 'a', to: 'p', kind: 'flow' },
        { from: 'q', to: 'p', kind: 'flow' },
        { from: 'q', to: 'a', kind: 'flow' },
      ],
      exit: 'p',
    });
    const { issues } = check(g);
    expect(issues).toContainEqual({
      code: 'flow_fan_in',
      path: 'edges.1',
      message: expect.any(String),
    });
    expect(issues).toContainEqual({
      code: 'entry_has_input',
      path: 'edges.2',
      message: expect.any(String),
    });
    expect(find(issues, 'flow_fan_in')).toHaveLength(1);
  });

  it('AC-009-9: цикл flow — одно flow_cycle, цикл link из трёх агентов замечаний не даёт', () => {
    const g = graph({
      nodes: [agent('a'), agent('b'), agent('c'), program('p1'), program('p2')],
      edges: [
        { from: 'p1', to: 'p2', kind: 'flow' },
        { from: 'p2', to: 'p1', kind: 'flow' },
        { from: 'a', to: 'b', kind: 'link' },
        { from: 'b', to: 'c', kind: 'link' },
        { from: 'c', to: 'a', kind: 'link' },
      ],
    });
    const { issues } = check(g);
    expect(find(issues, 'flow_cycle')).toEqual([
      { code: 'flow_cycle', path: 'edges.0', message: expect.any(String) },
    ]);
    expect(find(issues, 'link_requires_agents')).toEqual([]);
    expect(find(issues, 'edge_duplicate')).toEqual([]);
  });

  it('AC-009-10: программа без входа — unreachable; exit не агент-вход — exit_not_step; неизвестные entry и exit — entry_unknown, exit_unknown', () => {
    const unreachable = graph({ nodes: [agent('a'), program('p')] });
    expect(check(unreachable).issues).toEqual([
      { code: 'unreachable', path: 'nodes.1', message: expect.any(String) },
    ]);

    const notStep = graph({
      nodes: [agent('a'), agent('b')],
      edges: [{ from: 'a', to: 'b', kind: 'link' }],
      exit: 'b',
    });
    expect(check(notStep).issues).toEqual([
      { code: 'exit_not_step', path: 'exit', message: expect.any(String) },
    ]);

    expect(check(graph({ entry: 'zz' })).issues).toEqual([
      { code: 'entry_unknown', path: 'entry', message: expect.any(String) },
    ]);
    expect(check(graph({ exit: 'yy' })).issues).toEqual([
      { code: 'exit_unknown', path: 'exit', message: expect.any(String) },
    ]);
  });

  it('AC-009-11: 9 агентов — too_many_agents; граф только из программ — no_agents', () => {
    const nine = Array.from({ length: 9 }, (_, i) => agent(`agent-${i + 1}`));
    const many = graph({ nodes: nine, entry: 'agent-1', exit: 'agent-1' });
    expect(check(many).issues).toContainEqual({
      code: 'too_many_agents',
      path: 'nodes',
      message: expect.any(String),
    });

    const noAgents = graph({ nodes: [program('p')], entry: 'p', exit: 'p' });
    expect(check(noAgents).issues).toEqual([
      { code: 'no_agents', path: 'nodes', message: expect.any(String) },
    ]);
  });

  it('REQ-009-4: замечания разных проходов в одном результате, порядок по проходам', () => {
    const g = graph({
      nodes: [agent('a'), echo('e')],
      edges: [
        { from: 'a', to: 'nope', kind: 'flow' },
        { from: 'e', to: 'a', kind: 'link' },
      ],
      entry: 'zz',
      exit: 'yy',
    });
    expect(codes(check(g).issues)).toEqual([
      'edge_unknown_node',
      'link_requires_agents',
      'entry_unknown',
      'exit_unknown',
    ]);
  });
});

// NFR-009-1: граф из 16 узлов и 64 рёбер. Валидных 64 рёбер не бывает (link между 8 агентами — 28, flow — не больше 8),
// поэтому 28 рёбер — повторы link в обратном порядке: проход 3 находит каждый, и все проходы выполняются.
function maxGraph(): ProcessGraph {
  const agents = Array.from({ length: 8 }, (_, i) => agent(`a${i + 1}`));
  const programs = Array.from({ length: 8 }, (_, i) => program(`p${i + 1}`));
  const links: GraphEdge[] = [];
  agents.forEach((from, i) => {
    for (const to of agents.slice(i + 1)) links.push({ from: from.id, to: to.id, kind: 'link' });
  });
  const flows: GraphEdge[] = programs
    .slice(1)
    .map((to, i) => ({ from: programs[i]!.id, to: to.id, kind: 'flow' }));
  flows.push({ from: 'p8', to: 'a1', kind: 'flow' });
  const reversed: GraphEdge[] = links.map((edge) => ({
    from: edge.to,
    to: edge.from,
    kind: 'link',
  }));
  return {
    nodes: [...agents, ...programs],
    edges: [...links, ...flows, ...reversed],
    entry: 'p1',
    exit: 'a1',
  };
}

describe('NFR-009-1', () => {
  it('NFR-009-1: checkGraph на 16 узлах и 64 рёбрах — p95 меньше 5 мс, 1000 прогонов', () => {
    const g = maxGraph();
    expect(g.nodes).toHaveLength(16);
    expect(g.edges).toHaveLength(64);
    for (let i = 0; i < 50; i += 1) check(g);
    const timings: number[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const started = performance.now();
      check(g);
      timings.push(performance.now() - started);
    }
    timings.sort((a, b) => a - b);
    const at = (q: number) =>
      timings[Math.min(timings.length - 1, Math.ceil(q * timings.length) - 1)]!;
    const p50 = at(0.5).toFixed(3);
    const p95 = at(0.95).toFixed(3);
    process.stdout.write(
      `NFR-009-1 checkGraph: узлов=16 рёбер=64 прогонов=1000 p50=${p50} мс p95=${p95} мс\n`,
    );
    expect(at(0.95)).toBeLessThan(5);
  });
});
