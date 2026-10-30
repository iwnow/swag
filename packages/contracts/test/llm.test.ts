import { describe, expect, it } from 'vitest';
import { CatalogModel, GatewayErrorCode, LlmCharge, ModelCatalog } from '../src/index.ts';

const model = (
  id: string,
  prices = { inputPerMTokUsd: '3.00', cachedInputPerMTokUsd: '0.30', outputPerMTokUsd: '15.00' },
) => ({
  id,
  prices,
});

describe('каталог моделей', () => {
  it('AC-002-8: каталоги с неверной ценой, повтором id и id с заглавной буквой — ошибка', () => {
    const prices = (inputPerMTokUsd: string) => ({
      inputPerMTokUsd,
      cachedInputPerMTokUsd: '0.30',
      outputPerMTokUsd: '15.00',
    });

    expect(ModelCatalog.safeParse({ models: [model('chat-small')] }).success).toBe(true);

    const badPrice = ['1.23456', '-1', '10000.0001'];
    for (const value of badPrice) {
      const catalog = { models: [model('chat-small', prices(value))] };
      expect(ModelCatalog.safeParse(catalog).success, value).toBe(false);
    }

    const duplicate = { models: [model('chat-small'), model('chat-small')] };
    expect(ModelCatalog.safeParse(duplicate).success).toBe(false);

    const upperCaseId = { models: [model('Chat_Small')] };
    expect(ModelCatalog.safeParse(upperCaseId).success).toBe(false);
  });

  it('CatalogModel: openRouterModel необязателен, пустая строка отклоняется, непустая проходит', () => {
    const base = model('chat-small');
    expect(CatalogModel.safeParse(base).success).toBe(true);
    expect(CatalogModel.safeParse({ ...base, openRouterModel: '' }).success).toBe(false);
    expect(CatalogModel.safeParse({ ...base, openRouterModel: 'openai/gpt-4o' }).success).toBe(
      true,
    );
  });
});

describe('коды ошибок и списание 004', () => {
  it('GatewayErrorCode: полный список кодов в порядке спеки 004, 4.1', () => {
    expect(GatewayErrorCode.options).toEqual([
      'unauthorized',
      'invalid_caller',
      'invalid_request',
      'model_not_found',
      'caller_not_registered',
      'model_not_allowed',
      'swarm_budget_exceeded',
      'agent_budget_exceeded',
      'upstream_bad_request',
      'rate_limited',
      'upstream_error',
      'upstream_timeout',
    ]);
  });

  it('коды 004 принимаются GatewayErrorCode', () => {
    for (const code of [
      'caller_not_registered',
      'model_not_allowed',
      'swarm_budget_exceeded',
      'agent_budget_exceeded',
    ]) {
      expect(GatewayErrorCode.safeParse(code).success, code).toBe(true);
    }
    expect(GatewayErrorCode.safeParse('budget_exceeded').success).toBe(false);
  });

  it('LlmCharge: сумма целая ≥ 0, основание из трёх значений', () => {
    expect(LlmCharge.safeParse({ microUsd: 0, basis: 'none' }).success).toBe(true);
    expect(LlmCharge.safeParse({ microUsd: 1200, basis: 'estimate' }).success).toBe(true);
    expect(LlmCharge.safeParse({ microUsd: -1, basis: 'usage' }).success).toBe(false);
    expect(LlmCharge.safeParse({ microUsd: 1.5, basis: 'usage' }).success).toBe(false);
    expect(LlmCharge.safeParse({ microUsd: 1, basis: 'other' }).success).toBe(false);
  });
});
