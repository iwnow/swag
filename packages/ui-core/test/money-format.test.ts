import { describe, expect, it } from 'vitest';
import type { PlatformEvent, SwarmStatus } from '@swag/contracts';
import type { SwarmView } from '@swag/api-integration';
import { formatSwarmMoney, formatUsd, spentLastMinute, usdToMicro } from '../src/index.ts';

const SWARM = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';
const NOW = Date.parse('2026-10-30T12:00:00.000Z');

const view = (over: Partial<SwarmView>): SwarmView => ({
  id: SWARM,
  task: 'задача',
  status: 'running' as SwarmStatus,
  createdAt: '2026-10-30T11:00:00.000Z',
  spentMicroUsd: 0,
  agents: [],
  edges: [],
  result: null,
  failure: null,
  lastSeq: 1,
  ...over,
});

const llmCall = (ts: number, costMicroUsd: number): PlatformEvent =>
  ({
    id: '0b6f6d2e-6a4c-4c3e-9f5e-333333333333',
    swarmId: SWARM,
    ts: new Date(ts).toISOString(),
    source: 'llm-gateway',
    agentId: null,
    traceId: null,
    type: 'llm.call',
    data: {
      callId: '0b6f6d2e-6a4c-4c3e-9f5e-222222222222',
      model: 'chat-small',
      stream: false,
      status: 'ok',
      usage: { promptTokens: 1, cachedPromptTokens: 0, completionTokens: 1 },
      costMicroUsd,
      providerCostMicroUsd: null,
      latencyMs: 1,
    },
  }) as PlatformEvent;

describe('formatUsd', () => {
  it.each<[string, number, string]>([
    ['AC-004-27: 0 → $0.0000', 0, '$0.0000'],
    ['AC-004-27: 1 микродоллар — округление вверх', 1, '$0.0001'],
    ['AC-004-27: 100 микродолларов — ровно 4 знака', 100, '$0.0001'],
    ['AC-004-27: 101 микродоллар — округление вверх', 101, '$0.0002'],
    ['AC-004-27: 12345 → $0.0124', 12345, '$0.0124'],
    ['AC-004-27: 2100 → $0.0021', 2100, '$0.0021'],
    ['AC-004-27: 500000 → $0.5000', 500000, '$0.5000'],
    ['AC-004-27: 487600 → $0.4876', 487600, '$0.4876'],
    ['AC-004-27: 1000000 → $1.0000', 1000000, '$1.0000'],
  ])('%s', (_name, micro, expected) => {
    expect(formatUsd(micro)).toBe(expected);
  });
});

describe('usdToMicro', () => {
  it.each<[string, string, number]>([
    ['AC-004-27: 0.50 → 500000', '0.50', 500000],
    ['AC-004-27: 0.01 → 10000', '0.01', 10000],
    ['AC-004-27: 1 → 1000000', '1', 1000000],
    ['AC-004-27: 0.29 → 290000', '0.29', 290000],
    ['AC-004-27: 1.005 → 1005000', '1.005', 1005000],
    ['AC-004-27: 9007199254 → 9007199254000000', '9007199254', 9007199254000000],
  ])('%s', (_name, usd, expected) => {
    expect(usdToMicro(usd)).toBe(expected);
  });

  it.each<[string, string]>([
    ['AC-004-27: пустая строка → NaN', ''],
    ['AC-004-27: пробелы → NaN', '  '],
    ['AC-004-27: шестнадцатеричная запись → NaN', '0x10'],
    ['AC-004-27: экспонента → NaN', '1e3'],
    ['AC-004-27: отрицательное → NaN', '-1'],
    ['AC-004-27: нечисло → NaN (отсекает SwarmCreateRequest)', 'abc'],
  ])('%s', (_name, usd) => {
    expect(usdToMicro(usd)).toBeNaN();
  });
});

describe('spentLastMinute', () => {
  it('AC-004-27: окно (nowMs − 60000, nowMs]: граница снизу не входит, nowMs входит', () => {
    const events = [
      llmCall(NOW - 60001, 1000),
      llmCall(NOW - 60000, 2000),
      llmCall(NOW - 59999, 4000),
      llmCall(NOW, 8000),
      llmCall(NOW + 1, 16000),
    ];
    expect(spentLastMinute(events, NOW)).toBe(12000);
  });

  it('AC-004-27: charge приоритетнее costMicroUsd, без charge — costMicroUsd', () => {
    const withCharge = {
      ...llmCall(NOW, 9960),
      data: { ...llmCall(NOW, 9960).data, charge: { microUsd: 5000, basis: 'usage' } },
    } as PlatformEvent;
    expect(spentLastMinute([withCharge], NOW)).toBe(5000);
    expect(spentLastMinute([llmCall(NOW, 9960)], NOW)).toBe(9960);
  });

  it('AC-004-27: события не llm.call не учитываются', () => {
    const other = { ...llmCall(NOW, 9960), type: 'agent.step' } as unknown as PlatformEvent;
    expect(spentLastMinute([other], NOW)).toBe(0);
  });
});

describe('formatSwarmMoney', () => {
  it.each<[string, Partial<SwarmView>, number, string]>([
    [
      'AC-004-27: бюджет 500000, потрачено 12345, за минуту 2100',
      { budgetMicroUsd: 500000, spentMicroUsd: 12345 },
      2100,
      '$0.0124 из $0.5000 · остаток $0.4876 · $0.0021 за минуту',
    ],
    [
      'AC-004-27: бюджета нет (рой до 004), потрачено 0',
      { spentMicroUsd: 0 },
      0,
      '$0.0000 · бюджет — · $0.0000 за минуту',
    ],
    [
      'AC-004-27: потрачено больше бюджета (hold_exceeded) — остаток $0.0000',
      { budgetMicroUsd: 500000, spentMicroUsd: 600000 },
      0,
      '$0.6000 из $0.5000 · остаток $0.0000 · $0.0000 за минуту',
    ],
  ])('%s', (_name, over, minute, expected) => {
    expect(formatSwarmMoney(view(over), minute)).toBe(expected);
  });
});
