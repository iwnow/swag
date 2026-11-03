import { describe, expect, it } from 'vitest';
import {
  PlatformEventInput,
  ProcessDraft,
  ROLE_PERMISSIONS,
  RunLaunchResult,
  SwarmLaunch,
  LaunchProgram,
  type Role,
} from '../src/index.ts';

const ORG = '0b6f6d2e-6a4c-4c3e-9f5e-222222222222';
const SWARM = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';
const PROCESS = '0b6f6d2e-6a4c-4c3e-9f5e-444444444444';

const graph = {
  nodes: [{ id: 'writer', type: 'swag/llm-agent@1.0.0', settings: {}, credentials: {} }],
  edges: [],
  entry: 'writer',
  exit: 'writer',
};

const draft = { name: 'Процесс', graph, budgetMicroUsd: 500000 };

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

describe('процесс, задание и запуск', () => {
  it('AC-033-1: ProcessDraft без необязательных полей даёт maxTokens null, pollIntervalSec 300, maxConcurrent 1', () => {
    const parsed = ProcessDraft.parse(draft);
    expect(parsed.maxTokens).toBeNull();
    expect(parsed.pollIntervalSec).toBe(300);
    expect(parsed.maxConcurrent).toBe(1);
  });

  it('AC-033-1: ProcessDraft отклоняет pollIntervalSec 59 и maxConcurrent 5', () => {
    expect(ProcessDraft.safeParse({ ...draft, pollIntervalSec: 59 }).success).toBe(false);
    expect(ProcessDraft.safeParse({ ...draft, maxConcurrent: 5 }).success).toBe(false);
    expect(
      ProcessDraft.safeParse({ ...draft, pollIntervalSec: 60, maxConcurrent: 4 }).success,
    ).toBe(true);
  });

  it('AC-033-1: права process.read и process.manage — у user и admin оба, у supervisor только process.read', () => {
    const expected: Record<Role, string[]> = {
      user: ['process.read', 'process.manage'],
      admin: ['process.read', 'process.manage'],
      supervisor: ['process.read'],
    };
    for (const role of ['user', 'admin', 'supervisor'] as const) {
      const granted = ROLE_PERMISSIONS[role].filter((p) => p.startsWith('process.'));
      expect(granted, role).toEqual(expected[role]);
    }
  });

  it('AC-033-1: SwarmLaunch без trigger разбирается с trigger null', () => {
    const parsed = SwarmLaunch.parse(launch);
    expect(parsed.trigger).toBeNull();
  });

  it('AC-033-1: SwarmLaunch принимает trigger с nodeId и event', () => {
    const parsed = SwarmLaunch.parse({
      ...launch,
      trigger: { nodeId: 'schedule', event: { scheduledAt: '2026-11-03T10:00:00.000Z' } },
    });
    expect(parsed.trigger?.nodeId).toBe('schedule');
  });

  it('AC-033-1: LaunchProgram без stateKey валиден, stateKey длиной 201 — нет', () => {
    const program = { id: 'echo', type: 'example/echo@1.0.0', settings: {}, credentials: {} };
    expect(LaunchProgram.safeParse(program).success).toBe(true);
    expect(LaunchProgram.safeParse({ ...program, stateKey: 'k'.repeat(200) }).success).toBe(true);
    expect(LaunchProgram.safeParse({ ...program, stateKey: 'k'.repeat(201) }).success).toBe(false);
  });

  it('AC-033-1: RunLaunchResult разбирает все четыре outcome', () => {
    const results = [
      { outcome: 'launched' },
      { outcome: 'rejected', reason: 'insufficient_balance' },
      { outcome: 'busy' },
      { outcome: 'process_not_found' },
    ];
    for (const result of results) {
      expect(RunLaunchResult.safeParse(result).success, result.outcome).toBe(true);
    }
    expect(RunLaunchResult.safeParse({ outcome: 'rejected', reason: 'queue_full' }).success).toBe(
      false,
    );
  });

  it('AC-033-1: swarm.created принимает processId процесса и null, без поля тоже', () => {
    const created = (extra: object) => ({
      id: '0b6f6d2e-6a4c-4c3e-9f5e-333333333333',
      swarmId: SWARM,
      ts: '2026-11-03T10:00:00.000Z',
      agentId: null,
      traceId: null,
      source: 'api',
      type: 'swarm.created',
      data: { task: 'Задача', agents: [], ...extra },
    });
    expect(PlatformEventInput.safeParse(created({ processId: PROCESS })).success).toBe(true);
    expect(PlatformEventInput.safeParse(created({ processId: null })).success).toBe(true);
    expect(PlatformEventInput.safeParse(created({})).success).toBe(true);
  });
});
