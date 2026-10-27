import { describe, expect, it } from 'vitest';
import type { LlmCallData } from '@swag/contracts';
import { formatLlmCall } from '../src/index.ts';

const base: LlmCallData = {
  callId: '0b6f6d2e-6a4c-4c3e-9f5e-222222222222',
  model: 'chat-small',
  stream: false,
  status: 'ok',
  usage: { promptTokens: 1000, cachedPromptTokens: 200, completionTokens: 500 },
  costMicroUsd: 9960,
  providerCostMicroUsd: null,
  latencyMs: 120,
};

const withUsage = 'chat-small · 1000 (кэш 200) → 500 ток.';

describe('formatLlmCall', () => {
  it.each<[string, LlmCallData, string]>([
    ['AC-002-24: usage есть, ok', base, `${withUsage} · $0.009960`],
    [
      'AC-002-24: usage есть, aborted',
      { ...base, status: 'aborted' },
      `${withUsage} · $0.009960 · прерван`,
    ],
    [
      'AC-002-24: usage есть, aborted с errorCode — код не показывается',
      { ...base, status: 'aborted', errorCode: 'upstream_error' },
      `${withUsage} · $0.009960 · прерван`,
    ],
    [
      'AC-002-24: usage null, ok',
      { ...base, usage: null, costMicroUsd: null },
      'chat-small · без usage',
    ],
    [
      'AC-002-24: usage null, aborted',
      { ...base, status: 'aborted', usage: null, costMicroUsd: null },
      'chat-small · прерван · без usage',
    ],
    [
      'AC-002-24: status error',
      { ...base, status: 'error', usage: null, costMicroUsd: null, errorCode: 'upstream_timeout' },
      'chat-small · ошибка upstream_timeout',
    ],
    ['AC-002-24: стоимость 0 → 6 знаков', { ...base, costMicroUsd: 0 }, `${withUsage} · $0.000000`],
    [
      'AC-002-24: стоимость 1 микродоллар → 6 знаков',
      { ...base, costMicroUsd: 1 },
      `${withUsage} · $0.000001`,
    ],
  ])('%s', (_name, data, expected) => {
    expect(formatLlmCall(data)).toBe(expected);
  });
});
