import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOpenRouterPrices } from '@swag/adapter-openrouter';
import { createPostgresBudgetStore, createPostgresPriceStore } from '@swag/adapter-postgres';
import type { Logger, PriceStore } from '@swag/llm-gateway-core';
import type { CatalogHolder } from '../src/catalog.ts';
import { fakeClock } from '../../../packages/llm-gateway-core/test/fakes.ts';
import { startPriceRefresh } from '../src/prices.ts';
import { assembleCore, startLlmGatewayCore } from '../src/start.ts';
import { recordingLog } from './support.ts';
import {
  catalogWithOpenRouter,
  gatewayDeps,
  openRouterBody,
  startFakeOpenRouter,
} from './prices-support.ts';

// Спека 004, AC-004-40 и 4.9. Нужен Postgres: POSTGRES_TEST_URL, без него тесты пропускаются.
const url = process.env['POSTGRES_TEST_URL'];

describe.skipIf(!url)('цены из OpenRouter с Postgres (спека 004, AC-004-40)', () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url ?? '' });
    await admin.connect();
    await admin.query(`create schema ${schema}`);
  });

  afterAll(async () => {
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });

  // Старт оболочки в тестовой схеме: миграции, пул, сохранённые цены поверх models.json.
  const start = (log: Logger) =>
    startLlmGatewayCore(
      { databaseUrl: url ?? '', schema },
      gatewayDeps(catalogWithOpenRouter(), log),
    );

  const refresh = (
    fake: { url: string },
    holder: CatalogHolder,
    store: PriceStore,
    log: Logger,
    intervalMs: number,
  ) =>
    startPriceRefresh({
      profile: 'dev',
      intervalMs,
      holder,
      source: createOpenRouterPrices({ url: fake.url, timeoutMs: 1000, retry: { attempts: 1 } }),
      store,
      clock: fakeClock(),
      log,
    });

  it('AC-004-40: старт 1 — новая цена в model_prices с openRouterModel; старт 2 — до первого запроса цена из Postgres', async () => {
    const first = await startFakeOpenRouter(200, openRouterBody('0.000004'));
    const run1 = recordingLog();
    const shell1 = await start(run1.log);
    const timer1 = refresh(first, shell1.holder, shell1.priceStore, run1.log, 3_600_000);
    try {
      await vi.waitFor(
        () => expect(shell1.holder.book.prices('chat-small').inputPerMTokUsd).toBe('4'),
        { timeout: 3000 },
      );
    } finally {
      timer1.stop();
    }
    const rows = await shell1.pool.query(
      'select open_router_model, input_per_mtok_usd from model_prices order by open_router_model',
    );
    expect(rows.rows).toEqual([
      { open_router_model: 'vendor/small', input_per_mtok_usd: '4.0000' },
    ]);
    await shell1.pool.end();
    await first.close();

    const second = await startFakeOpenRouter(500);
    const run2 = recordingLog();
    const shell2 = await start(run2.log);
    try {
      expect(shell2.holder.book.prices('chat-small').inputPerMTokUsd).toBe('4');
      expect(second.requests()).toBe(0);
      const timer2 = refresh(second, shell2.holder, shell2.priceStore, run2.log, 200);
      try {
        await vi.waitFor(
          () =>
            expect(run2.entries.some((entry) => entry.msg === 'price_refresh_failed')).toBe(true),
          { timeout: 3000 },
        );
      } finally {
        timer2.stop();
      }
      expect(second.requests()).toBeGreaterThanOrEqual(1);
      expect(shell2.holder.book.prices('chat-small').inputPerMTokUsd).toBe('4');
    } finally {
      await shell2.pool.end();
      await second.close();
    }
  });

  it('AC-004-40: ошибка PriceStore.save — warn price_save_failed, цена прежняя, в следующем цикле save вызван снова', async () => {
    const fake = await startFakeOpenRouter(200, openRouterBody('0.000005'));
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    const real = createPostgresPriceStore(pool);
    let saveCalls = 0;
    const failing: PriceStore = {
      load: () => real.load(),
      save: async () => {
        saveCalls += 1;
        throw new Error('db down');
      },
    };
    const { log, entries } = recordingLog();
    const { holder } = await assembleCore(gatewayDeps(catalogWithOpenRouter(), log), {
      budgets: createPostgresBudgetStore(pool),
      priceStore: failing,
    });
    expect(holder.book.prices('chat-small').inputPerMTokUsd).toBe('4');
    const timer = refresh(fake, holder, failing, log, 200);
    try {
      await vi.waitFor(() => expect(saveCalls).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    } finally {
      timer.stop();
    }
    expect(
      entries.some((entry) => entry.level === 'warn' && entry.msg === 'price_save_failed'),
    ).toBe(true);
    expect(holder.book.prices('chat-small').inputPerMTokUsd).toBe('4');
    await pool.end();
    await fake.close();
  });
});
