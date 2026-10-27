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

describe('formatLlmCall', () => {
  it('AC-002-24: строки ровно как в таблице 4.11', () => {
    expect(formatLlmCall(base)).toBe('chat-small · 1000 (кэш 200) → 500 ток. · $0.009960');
    expect(formatLlmCall({ ...base, status: 'aborted' })).toBe(
      'chat-small · 1000 (кэш 200) → 500 ток. · $0.009960 · прерван',
    );
    expect(formatLlmCall({ ...base, usage: null, costMicroUsd: null })).toBe(
      'chat-small · без usage',
    );
    expect(formatLlmCall({ ...base, status: 'aborted', usage: null, costMicroUsd: null })).toBe(
      'chat-small · прерван · без usage',
    );
    expect(
      formatLlmCall({
        ...base,
        status: 'error',
        usage: null,
        costMicroUsd: null,
        errorCode: 'upstream_timeout',
      }),
    ).toBe('chat-small · ошибка upstream_timeout');
  });
});
