import { describe, expect, it } from 'vitest';
import type { ModelCatalog, ModelPrices } from '@swag/contracts';
import { applyOpenRouterPrices, applyStoredPrices, type StoredPrice } from '../src/index.ts';

// Спека 004, 4.9 (сопоставление, перевод цен, пропуски) и 4.5 (model_prices). Чистые функции без апстрима и БД.

const INITIAL: ModelPrices = {
  inputPerMTokUsd: '1',
  cachedInputPerMTokUsd: '1',
  outputPerMTokUsd: '1',
};

const catalogOf = (...models: ModelCatalog['models']): ModelCatalog => ({ models });

const smallModel = (prices: ModelPrices = INITIAL): ModelCatalog['models'][number] => ({
  id: 'chat-small',
  prices,
  openRouterModel: 'vendor/small',
});

const responseOf = (id: string, pricing: Record<string, unknown>) => ({
  data: [{ id, pricing }],
});

describe('AC-004-28: applyOpenRouterPrices по таблице 4.9', () => {
  it.each([
    [
      'prompt 0.000003, completion 0.000015, input_cache_read 0.0000003',
      { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' },
      { to: { inputPerMTokUsd: '3', cachedInputPerMTokUsd: '0.3', outputPerMTokUsd: '15' } },
    ],
    [
      'prompt 0.00000027, completion 0.0000011, без input_cache_read — кэш равен prompt',
      { prompt: '0.00000027', completion: '0.0000011' },
      { to: { inputPerMTokUsd: '0.27', cachedInputPerMTokUsd: '0.27', outputPerMTokUsd: '1.1' } },
    ],
    [
      // В таблице задан только prompt; completion и cache взяты нулевыми, чтобы не появилось своих значений.
      'prompt 0.00000000001 — округление вверх до 4 знаков',
      { prompt: '0.00000000001', completion: '0' },
      { to: { inputPerMTokUsd: '0.0001', cachedInputPerMTokUsd: '0.0001', outputPerMTokUsd: '0' } },
    ],
    [
      'prompt 0, completion 0',
      { prompt: '0', completion: '0' },
      { to: { inputPerMTokUsd: '0', cachedInputPerMTokUsd: '0', outputPerMTokUsd: '0' } },
    ],
    [
      'request 0.01 — пропуск',
      { prompt: '0.000003', completion: '0.000015', request: '0.01' },
      { skipped: 'non-zero pricing.request' },
    ],
    [
      'prompt abc — пропуск',
      { prompt: 'abc', completion: '0.000015' },
      { skipped: 'invalid pricing.prompt' },
    ],
  ])('AC-004-28: %s', (_, pricing, expected) => {
    const result = applyOpenRouterPrices(
      catalogOf(smallModel()),
      responseOf('vendor/small', pricing),
    );
    if ('to' in expected) {
      expect(result.changed).toEqual([{ model: 'chat-small', from: INITIAL, to: expected.to }]);
      expect(result.skipped).toEqual([]);
      expect(result.catalog.models[0]?.prices).toEqual(expected.to);
    } else {
      expect(result.changed).toEqual([]);
      expect(result.skipped).toEqual([{ model: 'chat-small', reason: expected.skipped }]);
      expect(result.catalog.models[0]?.prices).toEqual(INITIAL);
    }
  });

  it('AC-004-28: request, image, web_search со значением 0 — не пропуск', () => {
    const result = applyOpenRouterPrices(
      catalogOf(smallModel()),
      responseOf('vendor/small', {
        prompt: '0.000003',
        completion: '0.000015',
        request: '0',
        image: '0.00',
      }),
    );
    expect(result.skipped).toEqual([]);
    expect(result.changed).toHaveLength(1);
  });

  it('AC-004-28: цены "3" и "3.00" равны — не changed', () => {
    const current = {
      inputPerMTokUsd: '3.00',
      cachedInputPerMTokUsd: '0.30',
      outputPerMTokUsd: '15.00',
    };
    const result = applyOpenRouterPrices(
      catalogOf(smallModel(current)),
      responseOf('vendor/small', {
        prompt: '0.000003',
        completion: '0.000015',
        input_cache_read: '0.0000003',
      }),
    );
    expect(result.changed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.catalog.models[0]?.prices).toBe(current);
  });

  it('AC-004-28: модель без openRouterModel не меняется и не попадает в skipped', () => {
    const plain = { id: 'chat-large', prices: INITIAL } as const;
    const result = applyOpenRouterPrices(
      catalogOf(smallModel(), plain),
      responseOf('vendor/small', { prompt: '0.000003', completion: '0.000015' }),
    );
    expect(result.changed.map((c) => c.model)).toEqual(['chat-small']);
    expect(result.skipped).toEqual([]);
    expect(result.catalog.models[1]).toBe(plain);
  });

  it('AC-004-28: модели нет в ответе — skipped', () => {
    const result = applyOpenRouterPrices(
      catalogOf(smallModel()),
      responseOf('vendor/other', { prompt: '0.000003', completion: '0.000015' }),
    );
    expect(result.changed).toEqual([]);
    expect(result.skipped).toEqual([{ model: 'chat-small', reason: 'not in OpenRouter response' }]);
  });

  it('AC-004-28: ответ без data[] — все модели с openRouterModel в skipped', () => {
    const result = applyOpenRouterPrices(catalogOf(smallModel()), { error: 'x' });
    expect(result.changed).toEqual([]);
    expect(result.skipped).toEqual([{ model: 'chat-small', reason: 'not in OpenRouter response' }]);
  });
});

describe('AC-004-40 (applyStoredPrices): цены из PriceStore поверх models.json', () => {
  const STORED: StoredPrice = {
    openRouterModel: 'vendor/small',
    prices: { inputPerMTokUsd: '5', cachedInputPerMTokUsd: '0.5', outputPerMTokUsd: '20' },
    updatedAt: new Date('2026-10-30T10:00:00Z'),
  };
  const PLAIN = { id: 'chat-large', prices: INITIAL } as const;

  it.each([
    [
      'модель с openRouterModel и сохранённой ценой берёт сохранённую',
      catalogOf(smallModel()),
      [STORED],
      { inputPerMTokUsd: '5', cachedInputPerMTokUsd: '0.5', outputPerMTokUsd: '20' },
    ],
    [
      'модель без openRouterModel не берёт цену, даже при совпадении ключа',
      catalogOf(PLAIN),
      [STORED],
      INITIAL,
    ],
    [
      'модель с openRouterModel без сохранённой цены — цены models.json',
      catalogOf(smallModel()),
      [{ ...STORED, openRouterModel: 'vendor/other' }],
      INITIAL,
    ],
  ])('AC-004-40 (applyStoredPrices): %s', (_, catalog, stored, expected) => {
    const result = applyStoredPrices(catalog, stored);
    expect(result.models[0]?.prices).toEqual(expected);
  });
});
