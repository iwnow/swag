import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenRouterPrices } from '@swag/adapter-openrouter';
import { fakeClock } from '../../../packages/llm-gateway-core/test/fakes.ts';
import { startPriceRefresh } from '../src/prices.ts';
import { assembleCore } from '../src/start.ts';
import { recordingLog, registeredBudgets } from './support.ts';
import {
  catalogWithOpenRouter,
  gatewayDeps,
  memoryPriceStore,
  openRouterBody,
  startFakeOpenRouter,
  type FakeOpenRouter,
} from './prices-support.ts';

// Спека 004, 4.9 и 4.11: оболочка цен без Postgres — хранилище в памяти, OpenRouter — фейк на 127.0.0.1.
const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

const source = (fake: FakeOpenRouter) =>
  createOpenRouterPrices({ url: fake.url, timeoutMs: 1000, retry: { attempts: 1 } });

describe('оболочка: обновление цен каталога (спека 004, 4.9)', () => {
  it('AC-004-29: до ответа OpenRouter — models.json; смена цены — price_updated; после 500 — последняя успешная', async () => {
    const fake = await startFakeOpenRouter(200, openRouterBody('0.000003'));
    closers.push(() => fake.close());
    const { log, entries } = recordingLog();
    const { store, saves } = memoryPriceStore();
    const { holder } = await assembleCore(gatewayDeps(catalogWithOpenRouter(), log), {
      budgets: registeredBudgets(),
      priceStore: store,
    });
    expect(holder.book.prices('chat-small').inputPerMTokUsd).toBe('3.00');
    expect(fake.requests()).toBe(0);

    const refresh = startPriceRefresh({
      profile: 'dev',
      intervalMs: 200,
      holder,
      source: source(fake),
      store,
      clock: fakeClock(),
      log,
    });
    closers.push(() => refresh.stop());

    await vi.waitFor(() => expect(fake.requests()).toBeGreaterThanOrEqual(1), { timeout: 3000 });
    expect(entries.some((entry) => entry.msg === 'price_updated')).toBe(false);

    fake.reply(200, openRouterBody('0.000004'));
    await vi.waitFor(() => expect(holder.book.prices('chat-small').inputPerMTokUsd).toBe('4'), {
      timeout: 3000,
    });
    const updated = entries.find((entry) => entry.msg === 'price_updated');
    expect(updated).toMatchObject({
      level: 'info',
      ctx: {
        model: 'chat-small',
        from: { inputPerMTokUsd: '3.00', cachedInputPerMTokUsd: '0.30', outputPerMTokUsd: '15.00' },
        to: { inputPerMTokUsd: '4', cachedInputPerMTokUsd: '0.3', outputPerMTokUsd: '15' },
      },
    });
    expect(saves.at(-1)).toEqual([
      {
        openRouterModel: 'vendor/small',
        prices: { inputPerMTokUsd: '4', cachedInputPerMTokUsd: '0.3', outputPerMTokUsd: '15' },
        updatedAt: expect.any(Date),
      },
    ]);

    fake.reply(500);
    await vi.waitFor(
      () => expect(entries.some((entry) => entry.msg === 'price_refresh_failed')).toBe(true),
      { timeout: 3000 },
    );
    expect(entries.find((entry) => entry.msg === 'price_refresh_failed')?.level).toBe('warn');
    expect(holder.book.prices('chat-small').inputPerMTokUsd).toBe('4');
  });

  it('профиль test и LLM_PRICES_REFRESH_MS 0 — ни одного запроса к OpenRouter', async () => {
    const fake = await startFakeOpenRouter();
    closers.push(() => fake.close());
    const { log } = recordingLog();
    const { store } = memoryPriceStore();
    const { holder } = await assembleCore(gatewayDeps(catalogWithOpenRouter(), log), {
      budgets: registeredBudgets(),
      priceStore: store,
    });
    const options = { holder, source: source(fake), store, clock: fakeClock(), log };
    const onTest = startPriceRefresh({ ...options, profile: 'test', intervalMs: 200 });
    const onZero = startPriceRefresh({ ...options, profile: 'dev', intervalMs: 0 });
    closers.push(
      () => onTest.stop(),
      () => onZero.stop(),
    );

    // Отрицательная проверка по времени: за 500 мс при интервале 200 мс запрос ушёл бы несколько раз.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(fake.requests()).toBe(0);
  });

  it('ошибка save: price_save_failed, цена в памяти прежняя, следующий цикл вызывает save снова', async () => {
    const fake = await startFakeOpenRouter(200, openRouterBody('0.000004'));
    closers.push(() => fake.close());
    const { log, entries } = recordingLog();
    const { store, saves, setFailSave } = memoryPriceStore();
    setFailSave(true);
    const { holder } = await assembleCore(gatewayDeps(catalogWithOpenRouter(), log), {
      budgets: registeredBudgets(),
      priceStore: store,
    });
    const refresh = startPriceRefresh({
      profile: 'dev',
      intervalMs: 200,
      holder,
      source: source(fake),
      store,
      clock: fakeClock(),
      log,
    });
    closers.push(() => refresh.stop());

    await vi.waitFor(() => expect(saves.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    expect(
      entries.some((entry) => entry.level === 'warn' && entry.msg === 'price_save_failed'),
    ).toBe(true);
    expect(entries.some((entry) => entry.msg === 'price_updated')).toBe(false);
    expect(holder.book.prices('chat-small').inputPerMTokUsd).toBe('3.00');
  });

  it('ошибка чтения сохранённых цен на старте — assembleCore бросает, каталог не собран', async () => {
    const { log } = recordingLog();
    const priceStore = {
      load: async () => {
        throw new Error('db down');
      },
      save: async () => undefined,
    };
    await expect(
      assembleCore(gatewayDeps(catalogWithOpenRouter(), log), {
        budgets: registeredBudgets(),
        priceStore,
      }),
    ).rejects.toThrow('db down');
  });
});
