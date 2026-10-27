import { describe, expect, it } from 'vitest';
import { costMicroUsd, parseProviderCost, parseUsage } from '../src/index.ts';

describe('расчёт стоимости', () => {
  it('AC-002-7: costMicroUsd по таблице 4.3', () => {
    expect(
      costMicroUsd(
        { promptTokens: 1000, cachedPromptTokens: 200, completionTokens: 500 },
        { inputPerMTokUsd: '3.00', cachedInputPerMTokUsd: '0.30', outputPerMTokUsd: '15.00' },
      ),
    ).toBe(9960);
    expect(
      costMicroUsd(
        { promptTokens: 1, cachedPromptTokens: 0, completionTokens: 0 },
        { inputPerMTokUsd: '0.0001', cachedInputPerMTokUsd: '0', outputPerMTokUsd: '0' },
      ),
    ).toBe(1);
    expect(
      costMicroUsd(
        { promptTokens: 1000, cachedPromptTokens: 0, completionTokens: 1000 },
        { inputPerMTokUsd: '0', cachedInputPerMTokUsd: '0', outputPerMTokUsd: '0' },
      ),
    ).toBe(0);
    expect(
      costMicroUsd(
        { promptTokens: 100, cachedPromptTokens: 150, completionTokens: 0 },
        { inputPerMTokUsd: '1.00', cachedInputPerMTokUsd: '0.50', outputPerMTokUsd: '0' },
      ),
    ).toBe(50);
  });
});

describe('разбор usage', () => {
  it('parseUsage: поле prompt_tokens есть — LlmUsage с cached_tokens', () => {
    expect(
      parseUsage({
        prompt_tokens: 1000,
        completion_tokens: 500,
        prompt_tokens_details: { cached_tokens: 200 },
      }),
    ).toEqual({ promptTokens: 1000, cachedPromptTokens: 200, completionTokens: 500 });
  });

  it('parseUsage: поля нет — null', () => {
    expect(parseUsage({ completion_tokens: 500 })).toBeNull();
    expect(parseUsage(undefined)).toBeNull();
  });

  it('parseUsage: cached_tokens нет — cachedPromptTokens 0', () => {
    expect(parseUsage({ prompt_tokens: 1000, completion_tokens: 500 })).toEqual({
      promptTokens: 1000,
      cachedPromptTokens: 0,
      completionTokens: 500,
    });
  });

  it('parseUsage: prompt_tokens или completion_tokens нецелое или отрицательное — null', () => {
    expect(parseUsage({ prompt_tokens: 1.5, completion_tokens: 500 })).toBeNull();
    expect(parseUsage({ prompt_tokens: -1, completion_tokens: 500 })).toBeNull();
    expect(parseUsage({ prompt_tokens: 1000, completion_tokens: 2.5 })).toBeNull();
    expect(parseUsage({ prompt_tokens: 1000, completion_tokens: -1 })).toBeNull();
  });

  it('parseUsage: нечисловой cached_tokens — cachedPromptTokens 0', () => {
    expect(
      parseUsage({
        prompt_tokens: 1000,
        completion_tokens: 500,
        prompt_tokens_details: { cached_tokens: '200' },
      }),
    ).toEqual({ promptTokens: 1000, cachedPromptTokens: 0, completionTokens: 500 });
  });

  it('parseUsage: cached_tokens больше prompt_tokens — возвращается как есть, costMicroUsd считает по min', () => {
    expect(
      parseUsage({
        prompt_tokens: 100,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 150 },
      }),
    ).toEqual({ promptTokens: 100, cachedPromptTokens: 150, completionTokens: 0 });
    expect(
      costMicroUsd(
        { promptTokens: 100, cachedPromptTokens: 150, completionTokens: 0 },
        {
          inputPerMTokUsd: '1.00',
          cachedInputPerMTokUsd: '0.50',
          outputPerMTokUsd: '0',
        },
      ),
    ).toBe(50);
  });
});

describe('фактическая стоимость провайдера', () => {
  it('AC-002-29: parseProviderCost переводит usage.cost в micro-USD, иначе null', () => {
    expect(parseProviderCost({ cost: 0.0085 })).toBe(8500);
    expect(parseProviderCost({ cost: 0 })).toBe(0);
    expect(parseProviderCost({ cost: -1 })).toBeNull();
    expect(parseProviderCost({ cost: '0.1' })).toBeNull();
    expect(parseProviderCost({ cost: NaN })).toBeNull();
    expect(parseProviderCost({ prompt_tokens: 1 })).toBeNull();
    expect(parseProviderCost(undefined)).toBeNull();
  });
});
