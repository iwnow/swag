import { fileURLToPath } from 'node:url';
import type { SwarmStore } from '@swag/api-core';
import { applyEvent, type SwarmView } from '@swag/api-integration';
import {
  OrgId,
  SwarmId,
  type BalanceEntry,
  type ChargeBasis,
  type LlmCaller,
  type LlmSwarmRegistration,
  type ModelId,
  type PlatformEvent,
} from '@swag/contracts';
import type { BalanceStore } from '@swag/billing-core';
import type { IdentityStore, StoredOrganization, StoredUser } from '@swag/identity-core';
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

    async close(
      swarmId: string,
      now: Date,
    ): Promise<{ spentMicroUsd: number; heldMicroUsd: number } | null> {
      if (!SwarmId.safeParse(swarmId).success) return null;
      // coalesce: повторное закрытие не переписывает время и отдаёт тот же spent (4.2).
      const result = await pool.query<{ spent: string; held: string }>(
        `update swarm_budgets set closed_at = coalesce(closed_at, $2) where swarm_id = $1
         returning spent_micro_usd as spent, held_micro_usd as held`,
        [swarmId, now],
      );
      const row = result.rows[0];
      return row ? { spentMicroUsd: Number(row.spent), heldMicroUsd: Number(row.held) } : null;
    },

    // Спека 013, 4.7: суммы роя для ожидания списаний; не UUID — null без запроса (как в close).
    async totals(swarmId: string): Promise<{ spentMicroUsd: number; heldMicroUsd: number } | null> {
      if (!SwarmId.safeParse(swarmId).success) return null;
      const result = await pool.query<{ spent: string; held: string }>(
        'select spent_micro_usd as spent, held_micro_usd as held from swarm_budgets where swarm_id = $1',
        [swarmId],
      );
      const row = result.rows[0];
      return row ? { spentMicroUsd: Number(row.spent), heldMicroUsd: Number(row.held) } : null;
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

// Спека 012, 4.3 и 4.9: хранилище identity. Времена порта — мс эпохи, в базе — timestamptz: в запросы идут Date, из базы — getTime().
type RotateResult = Awaited<ReturnType<IdentityStore['rotateSession']>>;
type ConfirmResult = Awaited<ReturnType<IdentityStore['confirmRegistration']>>;
type AcceptResult = Awaited<ReturnType<IdentityStore['acceptInvitation']>>;

const toDate = (ms: number): Date => new Date(ms);

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: StoredUser['role'];
  org_id: string | null;
  created_at: Date;
  blocked_at: Date | null;
  tokens_valid_after: Date | null;
}

const USER_COLUMNS =
  'id, email, password_hash, role, org_id, created_at, blocked_at, tokens_valid_after';

const userFromRow = (row: UserRow): StoredUser => ({
  id: row.id,
  email: row.email,
  passwordHash: row.password_hash,
  role: row.role,
  orgId: row.org_id,
  createdAt: row.created_at.getTime(),
  blockedAt: row.blocked_at?.getTime() ?? null,
  tokensValidAfter: row.tokens_valid_after?.getTime() ?? null,
});

// Конфликт уникального индекса users.email (4.3, п. 4 confirmRegistration): гонка двух регистраций одного email.
function isEmailConflict(error: unknown): boolean {
  const pgError = error as { code?: string; constraint?: string };
  return pgError.code === '23505' && pgError.constraint === 'users_email_key';
}

export function createPostgresIdentityStore(pool: Pool): IdentityStore {
  return {
    async findUserByEmail(email: string): Promise<StoredUser | null> {
      const result = await pool.query<UserRow>(
        `select ${USER_COLUMNS} from users where email = $1`,
        [email],
      );
      const row = result.rows[0];
      return row ? userFromRow(row) : null;
    },

    async findUserById(id: string) {
      const result = await pool.query<
        UserRow & { org_name: string | null; org_created_at: Date | null }
      >(
        `select u.id, u.email, u.password_hash, u.role, u.org_id, u.created_at,
                u.blocked_at, u.tokens_valid_after,
                o.name as org_name, o.created_at as org_created_at
           from users u left join organizations o on o.id = u.org_id
          where u.id = $1`,
        [id],
      );
      const row = result.rows[0];
      if (!row) return null;
      const organization: StoredOrganization | null =
        row.org_id === null || row.org_name === null || row.org_created_at === null
          ? null
          : { id: row.org_id, name: row.org_name, createdAt: row.org_created_at.getTime() };
      return { user: userFromRow(row), organization };
    },

    async hasSupervisor(): Promise<boolean> {
      const result = await pool.query<{ found: boolean }>(
        `select exists (select 1 from users where role = 'supervisor') as found`,
      );
      return result.rows[0]?.found ?? false;
    },

    async createUser(user: StoredUser): Promise<void> {
      await pool.query(
        'insert into users (id, email, password_hash, role, org_id, created_at) values ($1, $2, $3, $4, $5, $6)',
        [user.id, user.email, user.passwordHash, user.role, user.orgId, toDate(user.createdAt)],
      );
    },

    async addConfirmation(c): Promise<void> {
      await pool.query(
        'insert into email_confirmations (token_hash, email, expires_at, used_at, created_at) values ($1, $2, $3, null, $4)',
        [c.tokenHash, c.email, toDate(c.expiresAt), toDate(c.createdAt)],
      );
    },

    // Одна транзакция. Гонка двух подтверждений одного токена: update берёт блокировку строки,
    // проигравший после commit победителя не находит строку с used_at is null → invalid_token.
    async confirmRegistration({ tokenHash, now, org, user }): Promise<ConfirmResult> {
      return transact<ConfirmResult>(pool, async (client) => {
        const confirmed = await client.query<{ email: string }>(
          'update email_confirmations set used_at = $2 where token_hash = $1 and used_at is null and expires_at > $2 returning email',
          [tokenHash, toDate(now)],
        );
        const email = confirmed.rows[0]?.email;
        if (email === undefined) return { commit: false, value: { status: 'invalid_token' } };

        const taken = await client.query('select 1 from users where email = $1', [email]);
        if ((taken.rowCount ?? 0) > 0) return { commit: false, value: { status: 'email_taken' } };

        try {
          await client.query(
            'insert into organizations (id, name, created_at) values ($1, $2, $3)',
            [org.id, org.name, toDate(org.createdAt)],
          );
          await client.query(
            'insert into users (id, email, password_hash, role, org_id, created_at) values ($1, $2, $3, $4, $5, $6)',
            [user.id, email, user.passwordHash, user.role, user.orgId, toDate(user.createdAt)],
          );
        } catch (error) {
          if (isEmailConflict(error)) return { commit: false, value: { status: 'email_taken' } };
          throw error;
        }
        return { commit: true, value: { status: 'ok', email } };
      });
    },

    async createSession(s): Promise<void> {
      await pool.query(
        'insert into sessions (id, user_id, refresh_hash, previous_hash, expires_at, revoked_at, created_at) values ($1, $2, $3, null, $4, null, $5)',
        [s.id, s.userId, s.refreshHash, toDate(s.expiresAt), toDate(s.createdAt)],
      );
    },

    // Одна транзакция. reused — отзыв найденной живой сессии; commit нужен, чтобы отзыв сохранился.
    async rotateSession({ oldHash, newHash, now, expiresAt }): Promise<RotateResult> {
      return transact<RotateResult>(pool, async (client) => {
        const at = toDate(now);
        const current = await client.query<{ id: string; user_id: string }>(
          'select id, user_id from sessions where refresh_hash = $1 and revoked_at is null and expires_at > $2 for update',
          [oldHash, at],
        );
        const session = current.rows[0];
        if (session) {
          await client.query(
            'update sessions set previous_hash = refresh_hash, refresh_hash = $2, expires_at = $3 where id = $1',
            [session.id, newHash, toDate(expiresAt)],
          );
          return { commit: true, value: { status: 'ok', userId: session.user_id } };
        }

        const previous = await client.query<{ id: string; user_id: string }>(
          'select id, user_id from sessions where previous_hash = $1 and revoked_at is null and expires_at > $2 for update',
          [oldHash, at],
        );
        const stale = previous.rows[0];
        if (stale) {
          await client.query('update sessions set revoked_at = $2 where id = $1', [stale.id, at]);
          return { commit: true, value: { status: 'reused', userId: stale.user_id } };
        }
        return { commit: false, value: { status: 'invalid' } };
      });
    },

    async revokeSession(refreshHash: string, now: number): Promise<void> {
      await pool.query(
        'update sessions set revoked_at = $2 where refresh_hash = $1 and revoked_at is null and expires_at > $2',
        [refreshHash, toDate(now)],
      );
    },

    async listUsers({ orgId }: { orgId?: string }): Promise<StoredUser[]> {
      const result = await pool.query<UserRow>(
        `select ${USER_COLUMNS} from users where $1::uuid is null or org_id = $1 order by email`,
        [orgId ?? null],
      );
      return result.rows.map(userFromRow);
    },

    // Одна транзакция. Непереданные поля не меняются; revokeAt отзывает живые сессии пользователя.
    async updateUser({ id, role, blockedAt, revokeAt }): Promise<StoredUser> {
      return transact<StoredUser>(pool, async (client) => {
        const updated = await client.query<UserRow>(
          `update users
              set role = coalesce($2::text, role),
                  blocked_at = case when $3::boolean then $4::timestamptz else blocked_at end,
                  tokens_valid_after = coalesce($5::timestamptz, tokens_valid_after)
            where id = $1
        returning ${USER_COLUMNS}`,
          [
            id,
            role ?? null,
            blockedAt !== undefined,
            blockedAt === undefined || blockedAt === null ? null : toDate(blockedAt),
            revokeAt === undefined ? null : toDate(revokeAt),
          ],
        );
        const user = updated.rows[0];
        if (!user) throw new Error('user not found');
        if (revokeAt !== undefined) {
          await client.query(
            'update sessions set revoked_at = $2 where user_id = $1 and revoked_at is null',
            [id, toDate(revokeAt)],
          );
        }
        return { commit: true, value: userFromRow(user) };
      });
    },

    async addInvitation(i): Promise<void> {
      await pool.query(
        'insert into invitations (token_hash, email, org_id, role, invited_by, expires_at, used_at, created_at) values ($1, $2, $3, $4, $5, $6, null, $7)',
        [
          i.tokenHash,
          i.email,
          i.orgId,
          i.role,
          i.invitedBy,
          toDate(i.expiresAt),
          toDate(i.createdAt),
        ],
      );
    },

    // Одна транзакция, как confirmRegistration: приглашение гасится, при занятом email — rollback.
    async acceptInvitation({ tokenHash, now, user }): Promise<AcceptResult> {
      return transact<AcceptResult>(pool, async (client) => {
        const accepted = await client.query<{
          email: string;
          org_id: string;
          role: StoredUser['role'];
        }>(
          'update invitations set used_at = $2 where token_hash = $1 and used_at is null and expires_at > $2 returning email, org_id, role',
          [tokenHash, toDate(now)],
        );
        const invitation = accepted.rows[0];
        if (!invitation) return { commit: false, value: { status: 'invalid_token' } };

        const taken = await client.query('select 1 from users where email = $1', [
          invitation.email,
        ]);
        if ((taken.rowCount ?? 0) > 0) return { commit: false, value: { status: 'email_taken' } };

        try {
          await client.query(
            'insert into users (id, email, password_hash, role, org_id, created_at) values ($1, $2, $3, $4, $5, $6)',
            [
              user.id,
              invitation.email,
              user.passwordHash,
              invitation.role,
              invitation.org_id,
              toDate(user.createdAt),
            ],
          );
        } catch (error) {
          if (isEmailConflict(error)) return { commit: false, value: { status: 'email_taken' } };
          throw error;
        }
        const organization = await client.query<{ id: string; name: string; created_at: Date }>(
          'select id, name, created_at from organizations where id = $1',
          [invitation.org_id],
        );
        const org = organization.rows[0];
        if (!org) throw new Error('organization not found');
        return {
          commit: true,
          value: {
            status: 'ok',
            user: {
              id: user.id,
              email: invitation.email,
              passwordHash: user.passwordHash,
              role: invitation.role,
              orgId: invitation.org_id,
              createdAt: user.createdAt,
              blockedAt: null,
              tokensValidAfter: null,
            },
            organization: { id: org.id, name: org.name, createdAt: org.created_at.getTime() },
          },
        };
      });
    },

    async listOrganizations(): Promise<(StoredOrganization & { userCount: number })[]> {
      const result = await pool.query<{
        id: string;
        name: string;
        created_at: Date;
        user_count: number;
      }>(
        `select o.id, o.name, o.created_at, count(u.id)::int as user_count
           from organizations o left join users u on u.org_id = o.id
          group by o.id order by o.name`,
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at.getTime(),
        userCount: row.user_count,
      }));
    },

    // Спека 013, 4.8: не UUID — null без запроса (иначе ошибка приведения к uuid).
    async findOrganizationById(id: string): Promise<StoredOrganization | null> {
      if (!OrgId.safeParse(id).success) return null;
      const result = await pool.query<{ id: string; name: string; created_at: Date }>(
        'select id, name, created_at from organizations where id = $1',
        [id],
      );
      const row = result.rows[0];
      if (!row) return null;
      return { id: row.id, name: row.name, createdAt: row.created_at.getTime() };
    },

    async tokenRevocations(since: number) {
      const result = await pool.query<{
        id: string;
        tokens_valid_after: Date;
        blocked_at: Date | null;
      }>('select id, tokens_valid_after, blocked_at from users where tokens_valid_after > $1', [
        toDate(since),
      ]);
      return result.rows.map((row) => ({
        userId: row.id,
        validAfter: row.tokens_valid_after.getTime(),
        blocked: row.blocked_at !== null,
      }));
    },

    async purge(before: number) {
      const at = toDate(before);
      const confirmations = await pool.query(
        'delete from email_confirmations where expires_at < $1',
        [at],
      );
      const invitations = await pool.query('delete from invitations where expires_at < $1', [at]);
      const sessions = await pool.query(
        'delete from sessions where expires_at < $1 or revoked_at < $1',
        [at],
      );
      return {
        confirmations: confirmations.rowCount ?? 0,
        invitations: invitations.rowCount ?? 0,
        sessions: sessions.rowCount ?? 0,
      };
    },
  };
}

// Спека 013, 4.2 и T-4: хранилище баланса. Каждая операция — одна транзакция (topup, reserve, settle).
type BalanceEntryRow = {
  id: string;
  org_id: string;
  ts: Date;
  kind: 'topup' | 'swarm';
  amount_micro_usd: string;
  swarm_id: string | null;
  actor_id: string | null;
  comment: string | null;
};

const BALANCE_ENTRY_COLUMNS = 'id, org_id, ts, kind, amount_micro_usd, swarm_id, actor_id, comment';

const toBalanceEntry = (row: BalanceEntryRow): BalanceEntry => ({
  id: Number(row.id),
  orgId: row.org_id,
  ts: row.ts.toISOString(),
  kind: row.kind,
  amountMicroUsd: Number(row.amount_micro_usd),
  swarmId: row.swarm_id,
  actorId: row.actor_id,
  comment: row.comment,
});

// Спека 013, 4.2: баланс организации и журнал баланса; резерв роя — balance_holds.
export function createPostgresBalanceStore(pool: Pool): BalanceStore {
  return {
    async balance(orgId: string) {
      const result = await pool.query<{ balance: string; held: string }>(
        'select balance_micro_usd as balance, held_micro_usd as held from org_balances where org_id = $1',
        [orgId],
      );
      const row = result.rows[0];
      return row
        ? { balanceMicroUsd: Number(row.balance), heldMicroUsd: Number(row.held) }
        : { balanceMicroUsd: 0, heldMicroUsd: 0 };
    },

    async entries(orgId: string, before: number | null, limit: number) {
      const result = await pool.query<BalanceEntryRow>(
        `select ${BALANCE_ENTRY_COLUMNS} from balance_entries
          where org_id = $1 and ($2::bigint is null or id < $2)
          order by id desc limit $3`,
        [orgId, before, limit + 1],
      );
      return {
        entries: result.rows.slice(0, limit).map(toBalanceEntry),
        hasMore: result.rows.length > limit,
      };
    },

    async topup(input) {
      return transact(pool, async (client) => {
        await client.query(
          `insert into org_balances (org_id, balance_micro_usd) values ($1, $2)
             on conflict (org_id) do update set balance_micro_usd = org_balances.balance_micro_usd + $2`,
          [input.orgId, input.amountMicroUsd],
        );
        const inserted = await client.query<BalanceEntryRow>(
          `insert into balance_entries (org_id, ts, kind, amount_micro_usd, actor_id, comment)
             values ($1, $2, 'topup', $3, $4, $5) returning ${BALANCE_ENTRY_COLUMNS}`,
          [input.orgId, input.ts, input.amountMicroUsd, input.actorId, input.comment],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error('balance entry not inserted');
        return { commit: true, value: toBalanceEntry(row) };
      });
    },

    // Отказ — 'insufficient' без записи; повтор swarmId — конфликт первичного ключа, откат и исключение.
    async reserve(input) {
      return transact(
        pool,
        async (client): Promise<{ commit: boolean; value: 'ok' | 'insufficient' }> => {
          const held = await client.query(
            `update org_balances set held_micro_usd = held_micro_usd + $2
            where org_id = $1 and balance_micro_usd - held_micro_usd >= $2
          returning 1`,
            [input.orgId, input.amountMicroUsd],
          );
          if (held.rowCount === 0) return { commit: false, value: 'insufficient' };
          await client.query(
            'insert into balance_holds (swarm_id, org_id, amount_micro_usd, created_at) values ($1, $2, $3, $4)',
            [input.swarmId, input.orgId, input.amountMicroUsd, input.ts],
          );
          return { commit: true, value: 'ok' };
        },
      );
    },

    async settle(swarmId: string, spentMicroUsd: number, ts: string) {
      return transact(pool, async (client) => {
        const released = await client.query<{ org_id: string; amount: string }>(
          'delete from balance_holds where swarm_id = $1 returning org_id, amount_micro_usd as amount',
          [swarmId],
        );
        const hold = released.rows[0];
        if (!hold) return { commit: false, value: null };
        const heldMicroUsd = Number(hold.amount);
        const chargedMicroUsd = Math.min(spentMicroUsd, heldMicroUsd);
        await client.query(
          `insert into balance_entries (org_id, ts, kind, amount_micro_usd, swarm_id)
             values ($1, $2, 'swarm', $3, $4)`,
          [hold.org_id, ts, 0 - chargedMicroUsd, swarmId],
        );
        await client.query(
          `update org_balances set balance_micro_usd = balance_micro_usd - $2,
                                   held_micro_usd = held_micro_usd - $3
            where org_id = $1`,
          [hold.org_id, chargedMicroUsd, heldMicroUsd],
        );
        return {
          commit: true,
          value: { orgId: hold.org_id, heldMicroUsd, chargedMicroUsd },
        };
      });
    },

    async holds() {
      const result = await pool.query<{ swarm_id: string; org_id: string; amount: string }>(
        'select swarm_id, org_id, amount_micro_usd as amount from balance_holds',
      );
      return result.rows.map((row) => ({
        swarmId: row.swarm_id,
        orgId: row.org_id,
        amountMicroUsd: Number(row.amount),
      }));
    },
  };
}
