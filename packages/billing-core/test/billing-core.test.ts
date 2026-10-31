import { describe, expect, it, vi } from 'vitest';
import { ROLE_PERMISSIONS, type Actor, type BalanceEntry, type Role } from '@swag/contracts';
import {
  createBillingCore,
  type BalanceStore,
  type BillingCore,
  type BillingError,
  type BillingResult,
  type Clock,
  type LogContext,
  type Logger,
  type OrgDirectory,
} from '../src/index.ts';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = '2026-11-01T10:00:00.000Z';
const MAX_TOPUP = 100_000_000;

const ORG_A = uuid(1);
const ORG_B = uuid(2);
const UNKNOWN_ORG = uuid(3);
const SUPERVISOR = uuid(21);
const ADMIN_A = uuid(11);
const USER_A = uuid(12);
const USER_B = uuid(22);
const SWARM = uuid(31);

const actor = (role: Role, userId: string, orgId: string | null): Actor => ({
  userId,
  orgId,
  role,
  permissions: ROLE_PERMISSIONS[role],
});
const supervisor = actor('supervisor', SUPERVISOR, null);
const admin = actor('admin', ADMIN_A, ORG_A);
const userA = actor('user', USER_A, ORG_A);
const userB = actor('user', USER_B, ORG_B);
const adminB = actor('admin', uuid(23), ORG_B);

const clock: Clock = { now: () => NOW };

function fakeStore(): BalanceStore {
  const rows: BalanceEntry[] = [];
  const balances = new Map<string, { balance: number; held: number }>();
  const holds = new Map<string, { orgId: string; amount: number }>();
  let nextId = 1;
  const balanceOf = (orgId: string) => {
    const found = balances.get(orgId);
    if (found) return found;
    const created = { balance: 0, held: 0 };
    balances.set(orgId, created);
    return created;
  };
  return {
    async balance(orgId) {
      const b = balances.get(orgId);
      return { balanceMicroUsd: b?.balance ?? 0, heldMicroUsd: b?.held ?? 0 };
    },
    async entries(orgId, before, limit) {
      const list = rows
        .filter((r) => r.orgId === orgId && (before === null || r.id < before))
        .sort((a, b) => b.id - a.id);
      return { entries: list.slice(0, limit), hasMore: list.length > limit };
    },
    async topup({ orgId, amountMicroUsd, actorId, comment, ts }) {
      balanceOf(orgId).balance += amountMicroUsd;
      const row: BalanceEntry = {
        id: nextId++,
        orgId,
        ts,
        kind: 'topup',
        amountMicroUsd,
        swarmId: null,
        actorId,
        comment,
      };
      rows.push(row);
      return row;
    },
    async reserve({ orgId, swarmId, amountMicroUsd }) {
      const b = balanceOf(orgId);
      if (b.balance - b.held < amountMicroUsd) return 'insufficient';
      b.held += amountMicroUsd;
      holds.set(swarmId, { orgId, amount: amountMicroUsd });
      return 'ok';
    },
    async settle(swarmId, spentMicroUsd, ts) {
      const hold = holds.get(swarmId);
      if (!hold) return null;
      holds.delete(swarmId);
      const charged = Math.min(spentMicroUsd, hold.amount);
      rows.push({
        id: nextId++,
        orgId: hold.orgId,
        ts,
        kind: 'swarm',
        amountMicroUsd: -charged,
        swarmId,
        actorId: null,
        comment: null,
      });
      const b = balanceOf(hold.orgId);
      b.balance -= charged;
      b.held -= hold.amount;
      return { orgId: hold.orgId, heldMicroUsd: hold.amount, chargedMicroUsd: charged };
    },
    async holds() {
      return [...holds].map(([swarmId, h]) => ({
        swarmId,
        orgId: h.orgId,
        amountMicroUsd: h.amount,
      }));
    },
  };
}

type LogCall = {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  ctx: LogContext | undefined;
};

function fakeLog(): { log: Logger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const write = (level: LogCall['level']) => (msg: string, ctx?: LogContext) => {
    calls.push({ level, msg, ctx });
  };
  return {
    calls,
    log: { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') },
  };
}

function setup(known: string[] | 'unavailable' = [ORG_A, ORG_B]) {
  const store = fakeStore();
  const { log, calls } = fakeLog();
  const exists = vi.fn(async (orgId: string) => {
    if (known === 'unavailable') throw new Error('identity недоступна');
    return known.includes(orgId);
  });
  const orgs: OrgDirectory = { exists };
  const core: BillingCore = createBillingCore({
    store,
    orgs,
    clock,
    log,
    limits: { maxTopupMicroUsd: MAX_TOPUP },
  });
  return { core, store, calls, exists };
}

function value<T>(result: BillingResult<T>): T {
  if (!result.ok) throw new Error(`ожидался ok, пришло ${result.error.code}`);
  return result.value;
}

function error<T>(result: BillingResult<T>): BillingError {
  if (result.ok) throw new Error('ожидалась ошибка, пришёл ok');
  return result.error;
}

describe('billing-core', () => {
  it('AC-013-3: user пополняет свою организацию — forbidden, администратор чужую — not_found', async () => {
    const { core, store } = setup();
    const topup = vi.spyOn(store, 'topup');

    expect(error(await core.topup(userA, ORG_A, { amountMicroUsd: 1000 })).code).toBe('forbidden');
    expect(error(await core.topup(admin, ORG_B, { amountMicroUsd: 1000 })).code).toBe('not_found');
    expect(topup).not.toHaveBeenCalled();
  });

  it('AC-013-4: супервизор — без комментария validation_error, с комментарием ok, неизвестная организация not_found', async () => {
    const { core, store, exists } = setup();
    const topup = vi.spyOn(store, 'topup');

    const noComment = error(await core.topup(supervisor, ORG_A, { amountMicroUsd: 1000 }));
    expect(noComment).toMatchObject({ code: 'validation_error', message: 'comment is required' });
    expect(topup).not.toHaveBeenCalled();

    const entry = value(
      await core.topup(supervisor, ORG_A, { amountMicroUsd: 1000, comment: 'оплата счёта' }),
    );
    expect(entry).toMatchObject({ orgId: ORG_A, actorId: SUPERVISOR, comment: 'оплата счёта' });

    expect(
      error(await core.topup(supervisor, UNKNOWN_ORG, { amountMicroUsd: 1000, comment: 'x' })).code,
    ).toBe('not_found');
    expect(exists).toHaveBeenCalledWith(UNKNOWN_ORG);
  });

  it('AC-013-4: identity недоступна — org_directory_unavailable и warn-лог', async () => {
    const { core, store, calls } = setup('unavailable');
    const topup = vi.spyOn(store, 'topup');

    const failed = error(
      await core.topup(supervisor, ORG_A, { amountMicroUsd: 1000, comment: 'x' }),
    );
    expect(failed.code).toBe('org_directory_unavailable');
    expect(topup).not.toHaveBeenCalled();
    expect(calls).toContainEqual({
      level: 'warn',
      msg: 'org_directory_unavailable',
      ctx: { orgId: ORG_A, err: new Error('identity недоступна') },
    });
  });

  it.each([0, 1.5, MAX_TOPUP + 1])(
    'AC-013-5: сумма %s — validation_error, баланс не меняется',
    async (amount) => {
      const { core, store } = setup();
      const topup = vi.spyOn(store, 'topup');

      const failed = error(await core.topup(admin, ORG_A, { amountMicroUsd: amount }));
      expect(failed.code).toBe('validation_error');
      expect(topup).not.toHaveBeenCalled();
      expect(value(await core.getBalance(admin, ORG_A)).balanceMicroUsd).toBe(0);
    },
  );

  it('AC-013-5: сумма больше предела — сообщение с именем переменной', async () => {
    const { core } = setup();
    expect(error(await core.topup(admin, ORG_A, { amountMicroUsd: MAX_TOPUP + 1 }))).toMatchObject({
      code: 'validation_error',
      message: 'amount exceeds BALANCE_MAX_TOPUP_MICRO_USD',
    });
  });

  it('AC-013-6: user, admin своей организации и супервизор читают баланс и историю; чужой user и не-UUID — not_found', async () => {
    const { core } = setup();
    value(await core.topup(admin, ORG_A, { amountMicroUsd: 1000 }));
    expect(await core.reserve(ORG_A, SWARM, 300)).toBe('ok');

    for (const reader of [userA, admin, supervisor]) {
      const balance = value(await core.getBalance(reader, ORG_A));
      expect(balance).toEqual({
        orgId: ORG_A,
        balanceMicroUsd: 1000,
        heldMicroUsd: 300,
        availableMicroUsd: 700,
      });
      expect(value(await core.listEntries(reader, ORG_A, {})).entries).toHaveLength(1);
    }

    expect(error(await core.getBalance(userB, ORG_A)).code).toBe('not_found');
    expect(error(await core.listEntries(userB, ORG_A, {})).code).toBe('not_found');
    expect(error(await core.getBalance(admin, 'не-uuid')).code).toBe('not_found');
  });

  it('AC-013-6: супервизор читает баланс неизвестной организации без проверки identity — нули', async () => {
    const { core, exists } = setup();
    expect(value(await core.getBalance(supervisor, UNKNOWN_ORG))).toEqual({
      orgId: UNKNOWN_ORG,
      balanceMicroUsd: 0,
      heldMicroUsd: 0,
      availableMicroUsd: 0,
    });
    expect(exists).not.toHaveBeenCalled();
    expect(error(await core.getBalance(adminB, ORG_A)).code).toBe('not_found');
  });

  it('AC-013-7: страницы по nextBefore — 50, 50, 20 без пропусков и повторов', async () => {
    const { core, store } = setup();
    for (let i = 0; i < 120; i++) {
      await store.topup({
        orgId: ORG_A,
        amountMicroUsd: 1,
        actorId: ADMIN_A,
        comment: null,
        ts: NOW,
      });
    }

    const first = value(await core.listEntries(admin, ORG_A, { limit: '50' }));
    const second = value(
      await core.listEntries(admin, ORG_A, { limit: '50', before: String(first.nextBefore) }),
    );
    const third = value(
      await core.listEntries(admin, ORG_A, { limit: '50', before: String(second.nextBefore) }),
    );

    expect([first.entries.length, second.entries.length, third.entries.length]).toEqual([
      50, 50, 20,
    ]);
    expect(first.nextBefore).toBe(71);
    expect(second.nextBefore).toBe(21);
    expect(third.nextBefore).toBeNull();
    const ids = [...first.entries, ...second.entries, ...third.entries].map((e) => e.id);
    expect(ids).toEqual(Array.from({ length: 120 }, (_, i) => 120 - i));
  });

  it('AC-013-7: без лимита — 50 записей; одна запись — nextBefore null', async () => {
    const { core, store } = setup();
    await store.topup({
      orgId: ORG_A,
      amountMicroUsd: 5,
      actorId: ADMIN_A,
      comment: null,
      ts: NOW,
    });
    const page = value(await core.listEntries(admin, ORG_A, {}));
    expect(page.entries).toHaveLength(1);
    expect(page.nextBefore).toBeNull();
  });

  it.each([
    { limit: '0' },
    { limit: '101' },
    { limit: 'abc' },
    { before: 'abc' },
    { before: '9007199254740992' },
    { before: '0' },
  ])('AC-013-7: разбор запроса %o — validation_error', async (query) => {
    const { core } = setup();
    expect(error(await core.listEntries(admin, ORG_A, query)).code).toBe('validation_error');
  });

  it('AC-013-23: логи balance_topup, balance_insufficient и balance_settled — только поля 4.3', async () => {
    const { core, calls } = setup();

    value(await core.topup(admin, ORG_A, { amountMicroUsd: 1000 }));
    expect(calls.filter((c) => c.msg === 'balance_topup')).toEqual([
      {
        level: 'info',
        msg: 'balance_topup',
        ctx: { orgId: ORG_A, actorId: ADMIN_A, amountMicroUsd: 1000 },
      },
    ]);

    expect(await core.reserve(ORG_A, SWARM, 2000)).toBe('insufficient');
    expect(calls.filter((c) => c.msg === 'balance_insufficient')).toEqual([
      {
        level: 'info',
        msg: 'balance_insufficient',
        ctx: { orgId: ORG_A, swarmId: SWARM, amountMicroUsd: 2000 },
      },
    ]);

    expect(await core.reserve(ORG_A, SWARM, 600)).toBe('ok');
    await core.settle(SWARM, 250);
    expect(calls.filter((c) => c.msg === 'balance_settled')).toEqual([
      {
        level: 'info',
        msg: 'balance_settled',
        ctx: { orgId: ORG_A, swarmId: SWARM, heldMicroUsd: 600, chargedMicroUsd: 250 },
      },
    ]);

    await core.settle(SWARM, 250);
    expect(calls.filter((c) => c.msg === 'balance_settled')).toHaveLength(1);
  });

  it('balance_overspent: траты больше резерва — error-лог с обеими суммами', async () => {
    const { core, calls } = setup();
    value(await core.topup(admin, ORG_A, { amountMicroUsd: 1000 }));
    expect(await core.reserve(ORG_A, SWARM, 400)).toBe('ok');

    await core.settle(SWARM, 500);

    expect(calls.filter((c) => c.level === 'error')).toEqual([
      {
        level: 'error',
        msg: 'balance_overspent',
        ctx: { orgId: ORG_A, swarmId: SWARM, spentMicroUsd: 500, heldMicroUsd: 400 },
      },
    ]);
  });
});
