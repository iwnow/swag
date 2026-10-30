import { fileURLToPath } from 'node:url';
import type { SwarmStore } from '@swag/api-core';
import { applyEvent, type SwarmView } from '@swag/api-integration';
import {
  SwarmId,
  type ChargeBasis,
  type LlmCaller,
  type LlmSwarmRegistration,
  type ModelId,
  type PlatformEvent,
} from '@swag/contracts';
import type {
  BudgetStore,
  LedgerEntry,
  PriceStore,
  RegisteredAgent,
  ReserveResult,
  StoredPrice,
} from '@swag/llm-gateway-core';
import type { Pool, PoolClient } from 'pg';
import { runner } from 'node-pg-migrate';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/** Применяет миграции из `migrations/` пакета (спека 003, 4.4, REQ-003-5). Повторный вызов ничего не меняет. */
export async function runMigrations(
  databaseUrl: string,
  options: { schema?: string } = {},
): Promise<void> {
  const schema = options.schema ?? 'public';
  await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction: 'up',
    schema,
    migrationsSchema: schema,
    migrationsTable: 'pgmigrations',
    advisoryLockMode: 'wait', // параллельные запуски (api, тесты) ждут друг друга, а не падают
    log: () => undefined,
  });
}

// Спека 003, 4.4. Схема берётся из search_path подключения: имена схем в SQL не вшиваются.
export function createPostgresSwarmStore(pool: Pool): SwarmStore {
  return {
    async appendEvent(event: PlatformEvent): Promise<void> {
      // Гонка двух swarm.created одного роя: проигравший откатывается и повторяет запись один раз.
      if (!(await writeOnce(pool, event))) await writeOnce(pool, event);
    },

    async events(swarmId: string, afterSeq: number): Promise<PlatformEvent[]> {
      if (!SwarmId.safeParse(swarmId).success) return [];
      const result = await pool.query<{ event: PlatformEvent }>(
        'select event from swarm_events where swarm_id = $1 and seq > $2 order by seq',
        [swarmId, afterSeq],
      );
      return result.rows.map((row) => row.event);
    },

    async view(swarmId: string): Promise<SwarmView | null> {
      if (!SwarmId.safeParse(swarmId).success) return null;
      const result = await pool.query<{ view: SwarmView }>(
        'select view from swarms where id = $1',
        [swarmId],
      );
      return result.rows[0]?.view ?? null;
    },

    async views(): Promise<SwarmView[]> {
      const result = await pool.query<{ view: SwarmView }>('select view from swarms');
      return result.rows.map((row) => row.view);
    },
  };
}

// Возвращает false, если строку роя за это время создал параллельный swarm.created: транзакция откатана, запись нужно повторить.
async function writeOnce(pool: Pool, event: PlatformEvent): Promise<boolean> {
  return transact(pool, async (client) => {
    const written = await writeEvent(client, event);
    return { commit: written, value: written };
  });
}

// Блокировка проекции роя, проверка применимости, запись проекции и события.
async function writeEvent(client: PoolClient, event: PlatformEvent): Promise<boolean> {
  const current =
    (
      await client.query<{ view: SwarmView }>('select view from swarms where id = $1 for update', [
        event.swarmId,
      ])
    ).rows[0]?.view ?? null;
  const next = applyEvent(current, event);
  if (next === current) return true; // повтор seq — уже учтено, ничего не пишем

  if (event.type === 'swarm.created') {
    const inserted = await client.query(
      'insert into swarms (id, status, created_at, last_seq, view) values ($1, $2, $3, $4, $5) on conflict (id) do nothing returning id',
      [next.id, next.status, next.createdAt, next.lastSeq, JSON.stringify(next)],
    );
    if (inserted.rowCount === 0) return false;
  } else {
    await client.query('update swarms set status = $2, last_seq = $3, view = $4 where id = $1', [
      next.id,
      next.status,
      next.lastSeq,
      JSON.stringify(next),
    ]);
  }
  await client.query('insert into swarm_events (swarm_id, seq, event) values ($1, $2, $3)', [
    event.swarmId,
    event.seq,
    JSON.stringify(event),
  ]);
  return true;
}

// Одна транзакция. commit: false откатывает её (отказ по бюджету — ничего не записано).
async function transact<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<{ commit: boolean; value: T }>,
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('begin');
    const { commit, value } = await work(client);
    await client.query(commit ? 'commit' : 'rollback');
    return value;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    client.release(broken);
  }
}

// Спека 004, 4.5. Условные update'ы блокируют строки роя, поэтому параллельные резервы идут по очереди без select for update.
export function createPostgresBudgetStore(pool: Pool): BudgetStore {
  return {
    async register(reg: LlmSwarmRegistration, now: Date): Promise<boolean> {
      return transact(pool, async (client) => {
        const inserted = await client.query(
          'insert into swarm_budgets (swarm_id, budget_micro_usd, created_at, expires_at) values ($1, $2, $3, $4) on conflict (swarm_id) do nothing returning swarm_id',
          [reg.swarmId, reg.budgetMicroUsd, now, reg.expiresAt],
        );
        if (inserted.rowCount === 0) return { commit: false, value: false };
        for (const agent of reg.agents) {
          await client.query(
            'insert into swarm_agents (swarm_id, agent_id, model, budget_micro_usd) values ($1, $2, $3, $4)',
            [reg.swarmId, agent.agentId, agent.model, agent.budgetMicroUsd],
          );
        }
        return { commit: true, value: true };
      });
    },

    async findAgent(swarmId: string, agentId: string): Promise<RegisteredAgent | null> {
      if (!SwarmId.safeParse(swarmId).success) return null;
      const result = await pool.query<{
        model: ModelId;
        expires_at: Date | null;
        closed_at: Date | null;
      }>(
        `select a.model, b.expires_at, b.closed_at
           from swarm_agents a join swarm_budgets b on b.swarm_id = a.swarm_id
          where a.swarm_id = $1 and a.agent_id = $2`,
        [swarmId, agentId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return { model: row.model, expiresAt: row.expires_at, closed: row.closed_at !== null };
    },

    async reserve(
      callId: string,
      caller: LlmCaller,
      amountMicroUsd: number,
      now: Date,
    ): Promise<ReserveResult> {
      return transact(pool, async (client): Promise<{ commit: boolean; value: ReserveResult }> => {
        const swarm = await client.query(
          `update swarm_budgets set held_micro_usd = held_micro_usd + $2
            where swarm_id = $1 and closed_at is null
              and spent_micro_usd + held_micro_usd + $2 <= budget_micro_usd
          returning 1`,
          [caller.swarmId, amountMicroUsd],
        );
        if (swarm.rowCount === 0) {
          return { commit: false, value: { ok: false, code: 'swarm_budget_exceeded' } };
        }
        const agent = await client.query(
          `update swarm_agents set held_micro_usd = held_micro_usd + $3
            where swarm_id = $1 and agent_id = $2
              and (budget_micro_usd is null or spent_micro_usd + held_micro_usd + $3 <= budget_micro_usd)
          returning 1`,
          [caller.swarmId, caller.agentId, amountMicroUsd],
        );
        if (agent.rowCount === 0) {
          return { commit: false, value: { ok: false, code: 'agent_budget_exceeded' } };
        }
        await client.query(
          'insert into budget_holds (call_id, swarm_id, agent_id, amount_micro_usd, created_at) values ($1, $2, $3, $4, $5)',
          [callId, caller.swarmId, caller.agentId, amountMicroUsd, now],
        );
        return { commit: true, value: { ok: true } };
      });
    },

    // Порядок шагов: запись ledger первой. Повтор того же callId даёт конфликт, и тогда spent не меняется (AC-004-14).
    async settle(entry: LedgerEntry): Promise<void> {
      await transact(pool, async (client) => {
        const ledger = await client.query(
          `insert into ledger_entries (call_id, ts, kind, swarm_id, agent_id, model, amount_micro_usd, basis, provider_cost_micro_usd)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           on conflict (call_id) do nothing returning call_id`,
          [
            entry.callId,
            entry.ts,
            entry.kind,
            entry.swarmId,
            entry.agentId,
            entry.model,
            entry.amountMicroUsd,
            entry.basis,
            entry.providerCostMicroUsd,
          ],
        );
        if (ledger.rowCount === 0) return { commit: false, value: undefined };

        const hold = await client.query<{ amount: string }>(
          'delete from budget_holds where call_id = $1 returning amount_micro_usd as amount',
          [entry.callId],
        );
        const reserved = Number(hold.rows[0]?.amount ?? 0); // резерва нет — held не меняется
        await client.query(
          'update swarm_budgets set held_micro_usd = held_micro_usd - $2, spent_micro_usd = spent_micro_usd + $3 where swarm_id = $1',
          [entry.swarmId, reserved, entry.amountMicroUsd],
        );
        await client.query(
          'update swarm_agents set held_micro_usd = held_micro_usd - $3, spent_micro_usd = spent_micro_usd + $4 where swarm_id = $1 and agent_id = $2',
          [entry.swarmId, entry.agentId, reserved, entry.amountMicroUsd],
        );
        return { commit: true, value: undefined };
      });
    },

    async close(swarmId: string, now: Date): Promise<{ spentMicroUsd: number } | null> {
      if (!SwarmId.safeParse(swarmId).success) return null;
      // coalesce: повторное закрытие не переписывает время и отдаёт тот же spent (4.2).
      const result = await pool.query<{ spent: string }>(
        'update swarm_budgets set closed_at = coalesce(closed_at, $2) where swarm_id = $1 returning spent_micro_usd as spent',
        [swarmId, now],
      );
      const row = result.rows[0];
      return row ? { spentMicroUsd: Number(row.spent) } : null;
    },

    async releaseHolds(): Promise<{ callId: string; swarmId: string; amountMicroUsd: number }[]> {
      return transact(pool, async (client) => {
        const holds = await client.query<{
          call_id: string;
          swarm_id: string;
          agent_id: string;
          amount: string;
        }>(
          'delete from budget_holds returning call_id, swarm_id, agent_id, amount_micro_usd as amount',
        );
        for (const hold of holds.rows) {
          await client.query(
            'update swarm_budgets set held_micro_usd = held_micro_usd - $2 where swarm_id = $1',
            [hold.swarm_id, hold.amount],
          );
          await client.query(
            'update swarm_agents set held_micro_usd = held_micro_usd - $3 where swarm_id = $1 and agent_id = $2',
            [hold.swarm_id, hold.agent_id, hold.amount],
          );
        }
        return {
          commit: true,
          value: holds.rows.map((hold) => ({
            callId: hold.call_id,
            swarmId: hold.swarm_id,
            amountMicroUsd: Number(hold.amount),
          })),
        };
      });
    },
  };
}

// Спека 004, 4.5: цена хранится numeric(9, 4), читается без незначащих нулей ("3.0000" → "3").
const plainPrice = (stored: string): string => {
  const [whole = '0', fraction = ''] = stored.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
};

export function createPostgresPriceStore(pool: Pool): PriceStore {
  return {
    async load(): Promise<StoredPrice[]> {
      const result = await pool.query<{
        open_router_model: string;
        input: string;
        cached: string;
        output: string;
        updated_at: Date;
      }>(
        `select open_router_model, input_per_mtok_usd as input,
                cached_input_per_mtok_usd as cached, output_per_mtok_usd as output, updated_at
           from model_prices order by open_router_model`,
      );
      return result.rows.map((row) => ({
        openRouterModel: row.open_router_model,
        prices: {
          inputPerMTokUsd: plainPrice(row.input),
          cachedInputPerMTokUsd: plainPrice(row.cached),
          outputPerMTokUsd: plainPrice(row.output),
        },
        updatedAt: row.updated_at,
      }));
    },

    async save(prices: StoredPrice[]): Promise<void> {
      await transact(pool, async (client) => {
        for (const price of prices) {
          await client.query(
            `insert into model_prices (open_router_model, input_per_mtok_usd, cached_input_per_mtok_usd, output_per_mtok_usd, updated_at)
             values ($1, $2, $3, $4, $5)
             on conflict (open_router_model) do update set
               input_per_mtok_usd = excluded.input_per_mtok_usd,
               cached_input_per_mtok_usd = excluded.cached_input_per_mtok_usd,
               output_per_mtok_usd = excluded.output_per_mtok_usd,
               updated_at = excluded.updated_at`,
            [
              price.openRouterModel,
              price.prices.inputPerMTokUsd,
              price.prices.cachedInputPerMTokUsd,
              price.prices.outputPerMTokUsd,
              price.updatedAt,
            ],
          );
        }
        return { commit: true, value: undefined };
      });
    },
  };
}

export interface LedgerReport {
  calls: number;
  chargedMicroUsd: number;
  byBasis: Record<ChargeBasis, { calls: number; microUsd: number }>;
  providerCostMicroUsd: number; // сумма по вызовам, где факт есть
  callsWithoutProviderCost: number;
  chargedWithProviderCostMicroUsd: number; // списано по тем же вызовам, где факт есть
}

// Спека 004, 4.5 (отчёт для 4.10). Фильтры необязательны; без фильтра — весь ledger.
export async function ledgerReport(
  pool: Pool,
  filter: { swarmId?: string; since?: Date },
): Promise<LedgerReport> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.swarmId !== undefined) {
    params.push(filter.swarmId);
    where.push(`swarm_id = $${params.length}`);
  }
  if (filter.since !== undefined) {
    params.push(filter.since);
    where.push(`ts >= $${params.length}`);
  }
  const result = await pool.query<{
    basis: ChargeBasis;
    calls: string;
    micro_usd: string;
    provider_micro_usd: string;
    without_provider: string;
    charged_with_provider: string;
  }>(
    `select basis, count(*) as calls, sum(amount_micro_usd) as micro_usd,
            coalesce(sum(provider_cost_micro_usd), 0) as provider_micro_usd,
            count(*) filter (where provider_cost_micro_usd is null) as without_provider,
            coalesce(sum(amount_micro_usd) filter (where provider_cost_micro_usd is not null), 0) as charged_with_provider
       from ledger_entries
       ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
      group by basis`,
    params,
  );

  const report: LedgerReport = {
    calls: 0,
    chargedMicroUsd: 0,
    byBasis: {
      usage: { calls: 0, microUsd: 0 },
      estimate: { calls: 0, microUsd: 0 },
      none: { calls: 0, microUsd: 0 },
    },
    providerCostMicroUsd: 0,
    callsWithoutProviderCost: 0,
    chargedWithProviderCostMicroUsd: 0,
  };
  for (const row of result.rows) {
    const calls = Number(row.calls);
    const microUsd = Number(row.micro_usd);
    report.byBasis[row.basis] = { calls, microUsd };
    report.calls += calls;
    report.chargedMicroUsd += microUsd;
    report.providerCostMicroUsd += Number(row.provider_micro_usd);
    report.callsWithoutProviderCost += Number(row.without_provider);
    report.chargedWithProviderCostMicroUsd += Number(row.charged_with_provider);
  }
  return report;
}
