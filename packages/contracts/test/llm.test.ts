import { describe, expect, it } from 'vitest';
import { ModelCatalog } from '../src/index.ts';

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
});
