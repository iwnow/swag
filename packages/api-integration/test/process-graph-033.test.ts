import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type GraphIssue, NodeManifest, type ProcessGraph } from '@swag/contracts';
import { describe, expect, it } from 'vitest';
import { checkGraph, createNodeRegistry, launchGraph } from '../src/index.ts';

// Спека 033, 4.3: тестовый реестр — манифесты swag/llm-agent и swag/schedule из пакетов узлов.
const readPackageManifest = (pkg: string): unknown =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../${pkg}/swag-node.json`, import.meta.url)), 'utf8'),
  );

const registryResult = createNodeRegistry(
  [readPackageManifest('node-llm-agent'), readPackageManifest('node-schedule')].map((manifest) =>
    NodeManifest.parse(manifest),
  ),
);
if (!registryResult.ok) throw new Error('test registry is invalid');
const registry = registryResult.registry;

const AGENT = 'swag/llm-agent@1.0.0';
const SCHEDULE = 'swag/schedule@1.0.0';
const SECRETS: ReadonlySet<string> = new Set();

const agent = (id: string) => ({
  id,
  type: AGENT,
  settings: { name: id, role: 'r' },
  credentials: {},
});
const trigger = (id: string) => ({
  id,
  type: SCHEDULE,
  settings: { everySec: 60 },
  credentials: {},
});

function graph(overrides: Partial<ProcessGraph>): ProcessGraph {
  return { nodes: [], edges: [], entry: 'a', exit: 'a', ...overrides } as ProcessGraph;
}

// Граф AC-033-2: t (swag/schedule) → a (агент), entry t, exit a.
const SCHEDULED: ProcessGraph = graph({
  nodes: [trigger('t'), agent('a')],
  edges: [{ from: 't', to: 'a', kind: 'flow' }],
  entry: 't',
  exit: 'a',
});

const codes = (issues: GraphIssue[]) => issues.map((issue) => issue.code);
const check = (g: ProcessGraph, triggers = true) =>
  checkGraph(g, { registry, secretNames: SECRETS, triggers });

describe('checkGraph, триггер процесса (033, 4.3)', () => {
  it('AC-033-2: t (swag/schedule) → a с triggers: true проходит без замечаний', () => {
    expect(check(SCHEDULED)).toEqual({ ok: true, issues: [] });
  });

  it('AC-033-2: без опции triggers узел t — node_kind_unsupported', () => {
    const result = check(SCHEDULED, false);
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      code: 'node_kind_unsupported',
      path: 'nodes.0.type',
      message: 'kind trigger is not supported in a process graph yet',
    });
  });

  it('AC-033-3: триггер не entry — trigger_not_entry по пути nodes.<i>', () => {
    const result = check(
      graph({ nodes: [agent('a'), trigger('t')], edges: [], entry: 'a', exit: 'a' }),
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual({
      code: 'trigger_not_entry',
      path: 'nodes.1',
      message: expect.any(String),
    });
  });

  it('AC-033-3: триггер-вход с двумя исходящими flow — trigger_flow по пути nodes.0', () => {
    const result = check(
      graph({
        nodes: [trigger('t'), agent('a'), agent('b')],
        edges: [
          { from: 't', to: 'a', kind: 'flow' },
          { from: 't', to: 'b', kind: 'flow' },
        ],
        entry: 't',
        exit: 'a',
      }),
    );
    expect(result.issues).toContainEqual({
      code: 'trigger_flow',
      path: 'nodes.0',
      message: expect.any(String),
    });
  });

  it('AC-033-3: триггер-вход без flow — trigger_flow по пути nodes.0', () => {
    const result = check(
      graph({ nodes: [trigger('t'), agent('a')], edges: [], entry: 't', exit: 'a' }),
    );
    expect(result.issues).toContainEqual({
      code: 'trigger_flow',
      path: 'nodes.0',
      message: expect.any(String),
    });
  });

  it('AC-033-3: exit = t — exit_not_step по пути exit', () => {
    const result = check(
      graph({
        nodes: [trigger('t'), agent('a')],
        edges: [{ from: 't', to: 'a', kind: 'flow' }],
        entry: 't',
        exit: 't',
      }),
    );
    expect(result.issues).toContainEqual({
      code: 'exit_not_step',
      path: 'exit',
      message: expect.any(String),
    });
    expect(codes(result.issues)).not.toContain('unreachable');
  });

  it('AC-033-3: link с триггером — link_requires_agents', () => {
    const result = check(
      graph({
        nodes: [trigger('t'), agent('a')],
        edges: [{ from: 't', to: 'a', kind: 'link' }],
        entry: 't',
        exit: 'a',
      }),
    );
    expect(codes(result.issues)).toContain('link_requires_agents');
  });
});

describe('launchGraph (033, 4.3)', () => {
  it('AC-033-4: граф с триггером — один агент a, entry = exit = a, без рёбер; trigger с настройками после умолчаний', () => {
    const launched = launchGraph(SCHEDULED, registry);
    expect(launched.graph).toEqual({
      nodes: [agent('a')],
      edges: [],
      entry: 'a',
      exit: 'a',
    });
    expect(launched.trigger).toEqual({
      nodeId: 't',
      type: SCHEDULE,
      settings: { everySec: 60, cron: null, timezone: 'UTC' },
      credentials: {},
    });
  });

  it('AC-033-4: граф без триггера — как есть, trigger: null', () => {
    const plain = graph({ nodes: [agent('a')], edges: [], entry: 'a', exit: 'a' });
    expect(launchGraph(plain, registry)).toEqual({ graph: plain, trigger: null });
  });
});
