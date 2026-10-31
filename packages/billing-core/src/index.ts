import {
  OrgId,
  TopupRequest,
  can,
  type Actor,
  type BalanceEntry,
  type BalanceEntryList,
  type BalanceView,
  type Permission,
} from '@swag/contracts';

// Спека 013, 4.3. Свои порты ядра по образцу api-core: ядра не импортируют друг друга.
export interface Clock {
  now(): string;
}

export type LogContext = {
  orgId?: string;
  swarmId?: string;
  actorId?: string;
  amountMicroUsd?: number;
  spentMicroUsd?: number;
  heldMicroUsd?: number;
  chargedMicroUsd?: number;
  err?: unknown;
};

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
}

export interface BalanceStore {
  balance(orgId: string): Promise<{ balanceMicroUsd: number; heldMicroUsd: number }>;
  entries(
    orgId: string,
    before: number | null,
    limit: number,
  ): Promise<{ entries: BalanceEntry[]; hasMore: boolean }>;
  topup(input: {
    orgId: string;
    amountMicroUsd: number;
    actorId: string;
    comment: string | null;
    ts: string;
  }): Promise<BalanceEntry>;
  reserve(input: {
    orgId: string;
    swarmId: string;
    amountMicroUsd: number;
    ts: string;
  }): Promise<'ok' | 'insufficient'>;
  settle(
    swarmId: string,
    spentMicroUsd: number,
    ts: string,
  ): Promise<{ orgId: string; heldMicroUsd: number; chargedMicroUsd: number } | null>;
  holds(): Promise<{ swarmId: string; orgId: string; amountMicroUsd: number }[]>;
}

export interface OrgDirectory {
  exists(orgId: string): Promise<boolean>;
}

export interface BillingCoreDeps {
  store: BalanceStore;
  orgs: OrgDirectory;
  clock: Clock;
  log: Logger;
  limits: { maxTopupMicroUsd: number };
}

export interface BillingError {
  code: string;
  message: string;
  issues?: { path: string; message: string }[];
}

export type BillingResult<T> = { ok: true; value: T } | { ok: false; error: BillingError };

export interface BillingCore {
  getBalance(actor: Actor, orgId: string): Promise<BillingResult<BalanceView>>;
  listEntries(
    actor: Actor,
    orgId: string,
    query: { before?: string; limit?: string },
  ): Promise<BillingResult<BalanceEntryList>>;
  topup(actor: Actor, orgId: string, body: unknown): Promise<BillingResult<BalanceEntry>>;
  reserve(orgId: string, swarmId: string, amountMicroUsd: number): Promise<'ok' | 'insufficient'>;
  settle(swarmId: string, spentMicroUsd: number): Promise<void>;
  holds(): Promise<{ swarmId: string; orgId: string; amountMicroUsd: number }[]>;
}

const ok = <T>(value: T): BillingResult<T> => ({ ok: true, value });
const fail = <T>(
  code: string,
  message: string,
  issues?: BillingError['issues'],
): BillingResult<T> =>
  issues === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, issues } };

const NOT_FOUND: BillingError = { code: 'not_found', message: 'Организация не найдена' };

// Правила доступа (4.3): uuid, право, область организации. Возвращает ошибку или null.
function accessError(actor: Actor, orgId: string, permission: Permission): BillingError | null {
  if (!OrgId.safeParse(orgId).success) return NOT_FOUND;
  if (!can(actor, permission)) return { code: 'forbidden', message: 'Нет права на операцию' };
  if (actor.role !== 'supervisor' && orgId !== actor.orgId) return NOT_FOUND;
  return null;
}

const LIMIT_DEFAULT = 50;

// Целое из строки запроса в диапазоне; иначе null.
function parseInteger(raw: string | undefined, min: number, max: number): number | null {
  if (raw === undefined) return null;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

export function createBillingCore(deps: BillingCoreDeps): BillingCore {
  const { store, orgs, clock, log, limits } = deps;

  return {
    async getBalance(actor, orgId) {
      const denied = accessError(actor, orgId, 'balance.read');
      if (denied) return { ok: false, error: denied };
      const { balanceMicroUsd, heldMicroUsd } = await store.balance(orgId);
      return ok({
        orgId,
        balanceMicroUsd,
        heldMicroUsd,
        availableMicroUsd: balanceMicroUsd - heldMicroUsd,
      });
    },

    async listEntries(actor, orgId, query) {
      const denied = accessError(actor, orgId, 'balance.read');
      if (denied) return { ok: false, error: denied };
      const limit = query.limit === undefined ? LIMIT_DEFAULT : parseInteger(query.limit, 1, 100);
      if (limit === null) return fail('validation_error', 'limit: целое от 1 до 100');
      const before =
        query.before === undefined ? null : parseInteger(query.before, 1, Number.MAX_SAFE_INTEGER);
      if (query.before !== undefined && before === null) {
        return fail('validation_error', 'before: целое от 1 до Number.MAX_SAFE_INTEGER');
      }
      const page = await store.entries(orgId, before, limit);
      const last = page.entries.at(-1);
      return ok({
        entries: page.entries,
        nextBefore: page.hasMore && last ? last.id : null,
      });
    },

    async topup(actor, orgId, body) {
      const denied = accessError(actor, orgId, 'balance.topup');
      if (denied) return { ok: false, error: denied };
      const parsed = TopupRequest.safeParse(body);
      if (!parsed.success) {
        return fail(
          'validation_error',
          'Запрос на пополнение не прошёл проверку',
          parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        );
      }
      const { amountMicroUsd, comment } = parsed.data;
      if (amountMicroUsd > limits.maxTopupMicroUsd) {
        return fail('validation_error', 'amount exceeds BALANCE_MAX_TOPUP_MICRO_USD');
      }
      const isSupervisor = actor.role === 'supervisor';
      if (isSupervisor && comment === null) {
        return fail('validation_error', 'comment is required');
      }
      if (isSupervisor) {
        let exists: boolean;
        try {
          exists = await orgs.exists(orgId);
        } catch (err) {
          log.warn('org_directory_unavailable', { orgId, err });
          return fail('org_directory_unavailable', 'Проверка организации временно недоступна');
        }
        if (!exists) return { ok: false, error: NOT_FOUND };
      }
      const entry = await store.topup({
        orgId,
        amountMicroUsd,
        actorId: actor.userId,
        comment,
        ts: clock.now(),
      });
      log.info('balance_topup', { orgId, actorId: actor.userId, amountMicroUsd });
      return ok(entry);
    },

    async reserve(orgId, swarmId, amountMicroUsd) {
      const result = await store.reserve({ orgId, swarmId, amountMicroUsd, ts: clock.now() });
      if (result === 'insufficient') {
        log.info('balance_insufficient', { orgId, swarmId, amountMicroUsd });
      }
      return result;
    },

    async settle(swarmId, spentMicroUsd) {
      const settled = await store.settle(swarmId, spentMicroUsd, clock.now());
      if (settled === null) return;
      const { orgId, heldMicroUsd, chargedMicroUsd } = settled;
      log.info('balance_settled', { orgId, swarmId, heldMicroUsd, chargedMicroUsd });
      if (spentMicroUsd > heldMicroUsd) {
        log.error('balance_overspent', { orgId, swarmId, spentMicroUsd, heldMicroUsd });
      }
    },

    holds() {
      return store.holds();
    },
  };
}
