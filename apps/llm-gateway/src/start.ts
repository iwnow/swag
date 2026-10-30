import {
  createPostgresBudgetStore,
  createPostgresPriceStore,
  runMigrations,
} from '@swag/adapter-postgres';
import {
  applyStoredPrices,
  createLlmGatewayCore,
  type BudgetStore,
  type CheckUpstreamResult,
  type LlmGatewayCore,
  type LlmGatewayDeps,
  type Logger,
  type PriceStore,
} from '@swag/llm-gateway-core';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { createCatalogHolder, type CatalogHolder } from './catalog.ts';

// Спека 002, REQ-002-13: повтор сверки каталога с апстримом раз в секунду.
const RETRY_MS = 1000;

// Спека 002, 4.9: секреты адаптера — мастер-ключ и значения всех переменных `*_API_KEY`; пустые не нужны.
export function upstreamSecrets(
  env: Record<string, string | undefined>,
  masterKey: string,
): string[] {
  const apiKeys = Object.entries(env).flatMap(([name, value]) =>
    name.endsWith('_API_KEY') && value ? [value] : [],
  );
  return [masterKey, ...apiKeys];
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Спека 002, REQ-002-13: сверка повторяется до истечения timeoutMs; возвращается последний результат.
export async function waitForUpstream(
  core: Pick<LlmGatewayCore, 'checkUpstream'>,
  options: { timeoutMs: number; retryMs?: number },
): Promise<CheckUpstreamResult> {
  const retryMs = options.retryMs ?? RETRY_MS;
  const deadline = performance.now() + options.timeoutMs;
  let lastMissing: CheckUpstreamResult | undefined;
  for (;;) {
    // Каждая попытка ограничена остатком срока старта: висящий апстрим не продлевает старт.
    const left = deadline - performance.now();
    const result = await core.checkUpstream(AbortSignal.timeout(Math.ceil(Math.max(left, 1))));
    if (result.ok) return result;
    if ('missing' in result) lastMissing = result;
    const rest = deadline - performance.now();
    // Попытка, оборванная дедлайном, не отменяет ответа апстрима «нет моделей», полученного раньше.
    if (rest <= 0) return lastMissing ?? result;
    await delay(Math.min(retryMs, rest));
  }
}

// Спека 004, 4.9: каталог — models.json с сохранёнными ценами поверх; потом ядро и освобождение резервов.
// Ошибка чтения сохранённых цен — исключение, как при миграциях: старт не продолжается.
export async function assembleCore(
  deps: Omit<LlmGatewayDeps, 'budgets' | 'prices'>,
  stores: { budgets: BudgetStore; priceStore: PriceStore },
): Promise<{ core: LlmGatewayCore; holder: CatalogHolder }> {
  const catalog = applyStoredPrices(deps.catalog, await stores.priceStore.load());
  const holder = createCatalogHolder(catalog);
  const core = createLlmGatewayCore({
    ...deps,
    catalog,
    budgets: stores.budgets,
    prices: holder.book,
  });
  await core.releaseHolds();
  return { core, holder };
}

// Спека 004, 4.4 и 4.11, REQ-004-14: миграции → пул → BudgetStore → ядро → освобождение резервов от прошлого процесса.
// Вызывается до listen: запросы не принимаются, пока висящие резервы не освобождены. `schema` — только для тестов.
export async function startLlmGatewayCore(
  options: { databaseUrl: string; schema?: string },
  deps: Omit<LlmGatewayDeps, 'budgets' | 'prices'>,
): Promise<{ core: LlmGatewayCore; pool: pg.Pool; holder: CatalogHolder; priceStore: PriceStore }> {
  const { databaseUrl, schema } = options;
  try {
    await runMigrations(databaseUrl, { schema: schema ?? 'public' });
  } catch (error) {
    deps.log.error('migrations failed', { err: error });
    throw error;
  }
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: schema === undefined ? undefined : `-c search_path=${schema}`,
  });
  const priceStore = createPostgresPriceStore(pool);
  try {
    const { core, holder } = await assembleCore(deps, {
      budgets: createPostgresBudgetStore(pool),
      priceStore,
    });
    return { core, pool, holder, priceStore };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

export interface GatewayStart {
  core: LlmGatewayCore;
  app: FastifyInstance;
  host: string;
  port: number;
  startupTimeoutMs: number;
  log: Logger;
  // Выход процесса внедряется: в тестах не вызываем process.exit.
  exit: (code: number) => void | Promise<void>;
}

// Спека 002, REQ-002-13 и 4.2: порт слушается только после успешной сверки. Иначе — error в лог и выход с кодом 1.
export async function startGateway(options: GatewayStart): Promise<boolean> {
  const result = await waitForUpstream(options.core, { timeoutMs: options.startupTimeoutMs });
  if (!result.ok) {
    if ('missing' in result) {
      options.log.error('upstream_models_mismatch', { missing: result.missing });
    } else {
      options.log.error('upstream_unavailable', { reason: result.failure.kind });
    }
    await options.exit(1);
    return false;
  }
  await options.app.listen({ host: options.host, port: options.port });
  return true;
}
