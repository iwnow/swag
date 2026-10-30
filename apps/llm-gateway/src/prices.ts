import type { ModelCatalog } from '@swag/contracts';
import {
  applyOpenRouterPrices,
  type Clock,
  type Logger,
  type PriceChange,
  type PriceStore,
  type StoredPrice,
} from '@swag/llm-gateway-core';
import type { CatalogHolder } from './catalog.ts';

// Спека 004, 4.9: обновление цен каталога из OpenRouter. Оболочка: запрос, сохранение, подмена каталога в памяти.
export interface PriceSource {
  fetchModels(signal: AbortSignal): Promise<unknown>;
}

export interface PriceRefreshDeps {
  holder: CatalogHolder;
  source: PriceSource;
  store: PriceStore;
  clock: Clock;
  log: Logger;
}

// Сохранённые цены изменённых моделей: ключ — openRouterModel (4.5).
function storedPrices(
  catalog: ModelCatalog,
  changed: PriceChange[],
  updatedAt: Date,
): StoredPrice[] {
  return changed.flatMap(({ model, to }) => {
    const openRouterModel = catalog.models.find((entry) => entry.id === model)?.openRouterModel;
    return openRouterModel === undefined ? [] : [{ openRouterModel, prices: to, updatedAt }];
  });
}

// Один цикл. Не бросает: сбой цикла — лог, каталог прежний. Сначала save, потом подмена: при сбое save в памяти старые цены.
export async function refreshPrices(deps: PriceRefreshDeps, signal: AbortSignal): Promise<void> {
  const { holder, source, store, clock, log } = deps;
  let response: unknown;
  try {
    response = await source.fetchModels(signal);
  } catch (err) {
    if (!signal.aborted) log.warn('price_refresh_failed', { err });
    return;
  }
  const next = applyOpenRouterPrices(holder.current(), response);
  for (const skip of next.skipped) {
    log.warn('price_update_skipped', { model: skip.model, reason: skip.reason });
  }
  if (next.changed.length === 0) return;
  try {
    await store.save(storedPrices(next.catalog, next.changed, clock.now()));
  } catch (err) {
    log.warn('price_save_failed', { err });
    return;
  }
  holder.replace(next.catalog);
  for (const change of next.changed) {
    log.info('price_updated', { model: change.model, from: change.from, to: change.to });
  }
}

export interface PriceRefreshOptions extends PriceRefreshDeps {
  profile: 'test' | 'dev' | 'prod';
  intervalMs: number; // LLM_PRICES_REFRESH_MS
}

// Спека 004, 4.9: первый цикл сразу после сверки с апстримом (не задерживает приём запросов), затем каждые intervalMs.
// Профиль test и интервал 0 — запросов нет. stop отменяет запрос в полёте и снимает таймер.
export function startPriceRefresh(options: PriceRefreshOptions): { stop(): void } {
  if (options.profile === 'test' || options.intervalMs === 0) return { stop() {} };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cycle = async (): Promise<void> => {
    await refreshPrices(options, controller.signal);
    if (!controller.signal.aborted) timer = setTimeout(() => void cycle(), options.intervalMs);
  };
  void cycle();
  return {
    stop() {
      controller.abort();
      clearTimeout(timer);
    },
  };
}
