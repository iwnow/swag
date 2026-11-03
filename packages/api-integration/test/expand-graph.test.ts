import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type GraphEdge, NodeManifest, type ProcessGraph } from '@swag/contracts';
import { describe, expect, it } from 'vitest';
import { checkGraph, createNodeRegistry, expandGraph, PROCESS_NODE_TYPE } from '../src/index.ts';

// Спека 033, 4.4: тестовый реестр — swag/llm-agent, example/echo и swag/schedule из пакетов узлов.
const readPackageManifest = (pkg: string): unknown =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../${pkg}/swag-node.json`, import.meta.url)), 'utf8'),
  );

const registryResult = createNodeRegistry(
  [
    readPackageManifest('node-llm-agent'),
    readPackageManifest('node-example'),
    readPackageManifest('node-schedule'),
  ].map((manifest) => NodeManifest.parse(manifest)),
);
if (!registryResult.ok) throw new Error('test registry is invalid');
const registry = registryResult.registry;

const AGENT = 'swag/llm-agent@1.0.0';
const ECHO = 'example/echo@1.0.0';
const SCHEDULE = 'swag/schedule@1.0.0';
const ROOT = '018f3c2a-0000-7000-8000-000000000001';
const A = '018f3c2a-0000-7000-8000-00000000000a';
const B = '018f3c2a-0000-7000-8000-00000000000b';
const C = '018f3c2a-0000-7000-8000-00000000000c';
const MISSING = '018f3c2a-0000-7000-8000-0000000000ff';

const agent = (id: string) => ({
  id,
  type: AGENT,
  settings: { name: id, role: 'r' },
  credentials: {},
});
const echo = (id: string) => ({ id, type: ECHO, settings: {}, credentials: {} });
const trigger = (id: string) => ({
  id,
  type: SCHEDULE,
  settings: { everySec: 60 },
  credentials: {},
});
const processNode = (id: string, processId: string) => ({
  id,
  type: PROCESS_NODE_TYPE,
  settings: { processId },
  credentials: {},
});
const flow = (from: string, to: string): GraphEdge => ({ from, to, kind: 'flow' });
const chain = (ids: string[]): GraphEdge[] => ids.slice(1).map((to, i) => flow(ids[i]!, to));

const graph = (
  nodes: ProcessGraph['nodes'],
  edges: GraphEdge[],
  entry: string,
  exit: string,
): ProcessGraph => ({
  nodes,
  edges,
  entry,
  exit,
});

const expand = (g: ProcessGraph, children: Map<string, ProcessGraph>, rootId: string | null) =>
  expandGraph(g, children, rootId, registry);

describe('expandGraph (033, 4.4)', () => {
  it('AC-033-5: C = t (swag/schedule) → x → y — триггер и его flow убраны, узлы, рёбра, вход и выход, origin', () => {
    const parent = graph([echo('e'), processNode('p', C)], [flow('e', 'p')], 'e', 'p');
    const child = graph(
      [trigger('t'), echo('x'), echo('y')],
      [flow('t', 'x'), flow('x', 'y')],
      't',
      'y',
    );
    expect(expand(parent, new Map([[C, child]]), ROOT)).toEqual({
      ok: true,
      graph: {
        nodes: [echo('e'), echo('p-x'), echo('p-y')],
        edges: [flow('e', 'p-x'), flow('p-x', 'p-y')],
        entry: 'e',
        exit: 'p-y',
      },
      origin: {
        e: null,
        'p-x': { processId: C, nodeId: 'x' },
        'p-y': { processId: C, nodeId: 'y' },
      },
    });
  });

  it('AC-033-6: процесс, которого нет в организации — process_not_found по пути узла', () => {
    const parent = graph([echo('e'), processNode('p', MISSING)], [flow('e', 'p')], 'e', 'p');
    expect(expand(parent, new Map(), ROOT)).toEqual({
      ok: false,
      issues: [
        {
          code: 'process_not_found',
          path: 'nodes.1.settings.processId',
          message: expect.any(String),
        },
      ],
    });
  });

  it('AC-033-6: ссылка на сам корень — process_cycle по пути узла', () => {
    const root = graph([echo('e'), processNode('p', ROOT)], [flow('e', 'p')], 'e', 'p');
    expect(expand(root, new Map([[ROOT, root]]), ROOT)).toEqual({
      ok: false,
      issues: [
        { code: 'process_cycle', path: 'nodes.1.settings.processId', message: expect.any(String) },
      ],
    });
  });

  it('AC-033-6: цепочка глубины 4 (корень → A → B → C) — process_too_deep по пути узла', () => {
    const root = graph([processNode('p', A)], [], 'p', 'p');
    const a = graph([processNode('q', B)], [], 'q', 'q');
    const b = graph([processNode('r', C)], [], 'r', 'r');
    const c = graph([echo('x')], [], 'x', 'x');
    expect(
      expand(
        root,
        new Map([
          [A, a],
          [B, b],
          [C, c],
        ]),
        ROOT,
      ),
    ).toEqual({
      ok: false,
      issues: [
        {
          code: 'process_too_deep',
          path: 'nodes.0.settings.processId',
          message: expect.any(String),
        },
      ],
    });
  });

  it('AC-033-6: цепочка корень → A → B с обычным B разворачивается, origin — самый внутренний процесс', () => {
    const root = graph([processNode('p', A)], [], 'p', 'p');
    const a = graph([processNode('q', B)], [], 'q', 'q');
    const b = graph([echo('x')], [], 'x', 'x');
    expect(
      expand(
        root,
        new Map([
          [A, a],
          [B, b],
        ]),
        ROOT,
      ),
    ).toEqual({
      ok: true,
      graph: { nodes: [echo('p-q-x')], edges: [], entry: 'p-q-x', exit: 'p-q-x' },
      origin: { 'p-q-x': { processId: B, nodeId: 'x' } },
    });
  });

  it('AC-033-6: дочерний узел с id в 38 символов при процессе с id в 5 символах — process_node_id_too_long', () => {
    const root = graph([echo('e'), processNode('hello', C)], [flow('e', 'hello')], 'e', 'hello');
    const child = graph([echo('a'.repeat(38))], [], 'a'.repeat(38), 'a'.repeat(38));
    expect(expand(root, new Map([[C, child]]), ROOT)).toEqual({
      ok: false,
      issues: [
        { code: 'process_node_id_too_long', path: 'nodes.1.id', message: expect.any(String) },
      ],
    });
  });

  it('AC-033-6: дочерний процесс ссылается на отсутствующий — process_invalid с пересказом замечания', () => {
    const root = graph([echo('e'), processNode('p', A)], [flow('e', 'p')], 'e', 'p');
    const a = graph([processNode('q', MISSING)], [], 'q', 'q');
    expect(expand(root, new Map([[A, a]]), ROOT)).toEqual({
      ok: false,
      issues: [
        {
          code: 'process_invalid',
          path: 'nodes.1.settings.processId',
          message: 'process_not_found at nodes.0.settings.processId',
        },
      ],
    });
  });

  it('AC-033-6: дочерний граф с триггером без flow — process_invalid, не исключение', () => {
    const root = graph([echo('e'), processNode('p', C)], [flow('e', 'p')], 'e', 'p');
    const child = graph([trigger('t'), echo('x')], [], 't', 'x');
    expect(expand(root, new Map([[C, child]]), ROOT)).toEqual({
      ok: false,
      issues: [
        {
          code: 'process_invalid',
          path: 'nodes.1.settings.processId',
          message: 'trigger_flow at nodes.0',
        },
      ],
    });
  });

  it('AC-033-6: дочерний граф с триггером с невалидными настройками — process_invalid, не исключение', () => {
    const root = graph([echo('e'), processNode('p', C)], [flow('e', 'p')], 'e', 'p');
    const badTrigger = { id: 't', type: SCHEDULE, settings: { everySec: 10 }, credentials: {} };
    const child = graph([badTrigger, echo('x')], [flow('t', 'x')], 't', 'x');
    expect(expand(root, new Map([[C, child]]), ROOT)).toEqual({
      ok: false,
      issues: [
        {
          code: 'process_invalid',
          path: 'nodes.1.settings.processId',
          message: 'invalid_settings at nodes.0.settings',
        },
      ],
    });
  });

  it('AC-033-5: два процесса-узла на один дочерний процесс — узлы p1-x и p2-x без конфликта', () => {
    const root = graph(
      [echo('e'), processNode('p1', C), processNode('p2', C)],
      [flow('e', 'p1'), flow('p1', 'p2')],
      'e',
      'p2',
    );
    const child = graph([trigger('t'), echo('x')], [flow('t', 'x')], 't', 'x');
    expect(expand(root, new Map([[C, child]]), ROOT)).toEqual({
      ok: true,
      graph: {
        nodes: [echo('e'), echo('p1-x'), echo('p2-x')],
        edges: [flow('e', 'p1-x'), flow('p1-x', 'p2-x')],
        entry: 'e',
        exit: 'p2-x',
      },
      origin: {
        e: null,
        'p1-x': { processId: C, nodeId: 'x' },
        'p2-x': { processId: C, nodeId: 'x' },
      },
    });
  });

  it('AC-033-5: e → p → f — входящие и исходящие flow перенаправлены на вход и выход процесса', () => {
    const root = graph(
      [echo('e'), processNode('p', C), echo('f')],
      [flow('e', 'p'), flow('p', 'f')],
      'e',
      'f',
    );
    const child = graph(
      [trigger('t'), echo('x'), echo('y')],
      [flow('t', 'x'), flow('x', 'y')],
      't',
      'y',
    );
    expect(expand(root, new Map([[C, child]]), ROOT)).toEqual({
      ok: true,
      graph: {
        nodes: [echo('e'), echo('p-x'), echo('p-y'), echo('f')],
        edges: [flow('e', 'p-x'), flow('p-y', 'f'), flow('p-x', 'p-y')],
        entry: 'e',
        exit: 'f',
      },
      origin: {
        e: null,
        'p-x': { processId: C, nodeId: 'x' },
        'p-y': { processId: C, nodeId: 'y' },
        f: null,
      },
    });
  });

  it('AC-033-5: p одновременно entry и exit — вход и выход графа берутся из границ процесса', () => {
    const root = graph([processNode('p', C)], [], 'p', 'p');
    const child = graph(
      [trigger('t'), echo('x'), echo('y')],
      [flow('t', 'x'), flow('x', 'y')],
      't',
      'y',
    );
    expect(expand(root, new Map([[C, child]]), ROOT)).toEqual({
      ok: true,
      graph: {
        nodes: [echo('p-x'), echo('p-y')],
        edges: [flow('p-x', 'p-y')],
        entry: 'p-x',
        exit: 'p-y',
      },
      origin: {
        'p-x': { processId: C, nodeId: 'x' },
        'p-y': { processId: C, nodeId: 'y' },
      },
    });
  });

  it('AC-033-6: цикл A → B → A при rootId = A — process_cycle по пути узла корня', () => {
    const a = graph([processNode('q', B)], [], 'q', 'q');
    const b = graph([processNode('x', A)], [], 'x', 'x');
    expect(
      expand(
        a,
        new Map([
          [A, a],
          [B, b],
        ]),
        A,
      ),
    ).toEqual({
      ok: false,
      issues: [
        { code: 'process_cycle', path: 'nodes.0.settings.processId', message: expect.any(String) },
      ],
    });
  });

  it('AC-033-6: цикл A → B → A при rootId = null — process_cycle по пути узла корня', () => {
    const a = graph([processNode('q', B)], [], 'q', 'q');
    const b = graph([processNode('x', A)], [], 'x', 'x');
    expect(
      expand(
        a,
        new Map([
          [A, a],
          [B, b],
        ]),
        null,
      ),
    ).toEqual({
      ok: false,
      issues: [
        { code: 'process_cycle', path: 'nodes.0.settings.processId', message: expect.any(String) },
      ],
    });
  });

  it('AC-033-5: link с процессом-узлом ведёт во вход процесса и остаётся link', () => {
    const root = graph(
      [agent('a'), processNode('p', C)],
      [{ from: 'a', to: 'p', kind: 'link' }],
      'a',
      'p',
    );
    const child = graph([trigger('t'), echo('x')], [flow('t', 'x')], 't', 'x');
    expect(expand(root, new Map([[C, child]]), ROOT)).toEqual({
      ok: true,
      graph: {
        nodes: [agent('a'), echo('p-x')],
        edges: [{ from: 'a', to: 'p-x', kind: 'link' }],
        entry: 'a',
        exit: 'p-x',
      },
      origin: { a: null, 'p-x': { processId: C, nodeId: 'x' } },
    });
  });
});

// NFR-033-2: корень → A → B, три уровня, 16 узлов после разворачивания.
function threeLevels(): { root: ProcessGraph; children: Map<string, ProcessGraph> } {
  const b = graph(['b1', 'b2', 'b3', 'b4'].map(echo), chain(['b1', 'b2', 'b3', 'b4']), 'b1', 'b4');
  const a = graph(
    [agent('a1'), ...['s1', 's2', 's3', 's4', 's5'].map(echo), processNode('q1', B)],
    chain(['a1', 's1', 's2', 's3', 's4', 's5', 'q1']),
    'a1',
    'q1',
  );
  const root = graph(
    [agent('a0'), ...['r1', 'r2', 'r3', 'r4', 'r5'].map(echo), processNode('p1', A)],
    chain(['a0', 'r1', 'r2', 'r3', 'r4', 'r5', 'p1']),
    'a0',
    'p1',
  );
  return {
    root,
    children: new Map([
      [A, a],
      [B, b],
    ]),
  };
}

describe('NFR-033-2', () => {
  it('NFR-033-2: expandGraph и checkGraph на трёх уровнях и 16 узлах — p95 меньше 10 мс, 1000 прогонов', () => {
    const { root, children } = threeLevels();
    const run = () => {
      const expanded = expand(root, children, ROOT);
      if (!expanded.ok) throw new Error('expandGraph failed');
      return checkGraph(expanded.graph, { registry, secretNames: new Set() });
    };
    expect(run()).toEqual({ ok: true, issues: [] });
    for (let i = 0; i < 50; i += 1) run();
    const timings: number[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const started = performance.now();
      run();
      timings.push(performance.now() - started);
    }
    timings.sort((a, b) => a - b);
    const at = (q: number) =>
      timings[Math.min(timings.length - 1, Math.ceil(q * timings.length) - 1)]!;
    const p50 = at(0.5).toFixed(3);
    const p95 = at(0.95).toFixed(3);
    process.stdout.write(
      `NFR-033-2 expandGraph+checkGraph: уровней=3 узлов=16 прогонов=1000 p50=${p50} мс p95=${p95} мс\n`,
    );
    expect(at(0.95)).toBeLessThan(10);
  });
});
