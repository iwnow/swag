import { describe, expect, it, vi } from 'vitest';
import { signal } from '@preact/signals-core';
import type { AuthMe, BalanceEntry, BalanceView } from '@swag/contracts';
import {
  createBalanceState,
  FORM_TEXT,
  TOPUP_INVALID_TEXT,
  type BalanceApi,
  type SessionUserStore,
} from '../src/index.ts';

type Role = AuthMe['user']['role'];

const ENTRY = (id: number): BalanceEntry => ({
  id,
  orgId: 'a',
  ts: '2026-11-01T00:00:00Z',
  kind: 'topup',
  amountMicroUsd: 1000000,
  swarmId: null,
  actorId: null,
  comment: null,
});

const viewOf = (orgId: string): BalanceView =>
  ({ orgId, balanceMicroUsd: 1000000, heldMicroUsd: 0, availableMicroUsd: 1000000 }) as BalanceView;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fakeSession(role: Role | null = 'admin'): Pick<SessionUserStore, 'role'> {
  return { role: signal<Role | null>(role) };
}

function fakeBalance(overrides: Partial<BalanceApi> = {}): BalanceApi {
  return {
    getBalance: vi.fn(async (orgId: string) => viewOf(orgId)),
    listBalanceEntries: vi.fn(async () => ({ entries: [ENTRY(1)], nextBefore: 7 })),
    topup: vi.fn(async () => ENTRY(3)),
    ...overrides,
  } as BalanceApi;
}

describe('balance state', () => {
  it('AC-014-27: открытие b, ответ a пришёл последним с успехом — view и entries от b', async () => {
    const pendingA = deferred<BalanceView>();
    const pendingPageA = deferred<{ entries: BalanceEntry[]; nextBefore: number | null }>();
    const balance = fakeBalance({
      getBalance: vi.fn((orgId: string) =>
        orgId === 'a' ? pendingA.promise : Promise.resolve(viewOf('b')),
      ),
      listBalanceEntries: vi.fn((orgId: string) =>
        orgId === 'a'
          ? pendingPageA.promise
          : Promise.resolve({ entries: [ENTRY(21)], nextBefore: null }),
      ),
    });
    const state = createBalanceState({ session: fakeSession(), balance });

    const first = state.open('a');
    await state.open('b');
    pendingA.resolve(viewOf('a'));
    pendingPageA.resolve({ entries: [ENTRY(11)], nextBefore: 3 });
    await first;

    expect(state.view.value).toEqual(viewOf('b'));
    expect(state.entries.value).toEqual([ENTRY(21)]);
    expect(state.nextBefore.value).toBeNull();
    expect(state.error.value).toBeNull();
    expect(state.loaded.value).toBe(true);
  });

  it('AC-014-27: открытие b с ошибкой, ответ a пришёл последним с успехом — error от b', async () => {
    const pendingA = deferred<BalanceView>();
    const balance = fakeBalance({
      getBalance: vi.fn((orgId: string) =>
        orgId === 'a' ? pendingA.promise : Promise.reject(new Error('нет связи')),
      ),
    });
    const state = createBalanceState({ session: fakeSession(), balance });

    const first = state.open('a');
    await state.open('b');
    pendingA.resolve(viewOf('a'));
    await first;

    expect(state.view.value).toBeNull();
    expect(state.entries.value).toEqual([]);
    expect(state.error.value).toBe('нет связи');
  });

  it('AC-014-27: поздняя ошибка устаревшего ответа не пишется в error', async () => {
    const pendingA = deferred<BalanceView>();
    const balance = fakeBalance({
      getBalance: vi.fn((orgId: string) =>
        orgId === 'a' ? pendingA.promise : Promise.resolve(viewOf('b')),
      ),
    });
    const state = createBalanceState({ session: fakeSession(), balance });

    const first = state.open('a');
    await state.open('b');
    pendingA.reject(new Error('поздняя ошибка'));
    await first;

    expect(state.view.value).toEqual(viewOf('b'));
    expect(state.error.value).toBeNull();
  });

  it('AC-014-27: orgId null — loaded без запросов', async () => {
    const balance = fakeBalance();
    const state = createBalanceState({ session: fakeSession(), balance });

    await state.open(null);

    expect(state.loaded.value).toBe(true);
    expect(state.orgId.value).toBeNull();
    expect(balance.getBalance).not.toHaveBeenCalled();
    expect(balance.listBalanceEntries).not.toHaveBeenCalled();
  });

  it('AC-014-27: more() запрашивает страницу с before = nextBefore и дописывает записи в конец', async () => {
    const balance = fakeBalance({
      listBalanceEntries: vi
        .fn()
        .mockResolvedValueOnce({ entries: [ENTRY(1)], nextBefore: 7 })
        .mockResolvedValueOnce({ entries: [ENTRY(2)], nextBefore: null }),
    });
    const state = createBalanceState({ session: fakeSession(), balance });
    await state.open('a');

    await state.more();

    expect(balance.listBalanceEntries).toHaveBeenLastCalledWith('a', 7);
    expect(state.entries.value).toEqual([ENTRY(1), ENTRY(2)]);
    expect(state.nextBefore.value).toBeNull();
  });

  it('AC-014-27: more() без nextBefore ничего не запрашивает', async () => {
    const balance = fakeBalance({
      listBalanceEntries: vi.fn(async () => ({ entries: [ENTRY(1)], nextBefore: null })),
    });
    const state = createBalanceState({ session: fakeSession(), balance });
    await state.open('a');

    await state.more();

    expect(balance.listBalanceEntries).toHaveBeenCalledTimes(1);
  });

  it('AC-014-27: topup с суммой abc — formError, запроса нет', async () => {
    const balance = fakeBalance();
    const state = createBalanceState({ session: fakeSession(), balance });
    await state.open('a');

    const ok = await state.topup({ amountUsd: 'abc', comment: '' }, false);

    expect(ok).toBe(false);
    expect(state.formError.value).toBe(TOPUP_INVALID_TEXT);
    expect(balance.topup).not.toHaveBeenCalled();
  });

  it('AC-014-27: topup успешен — true, баланс перечитан', async () => {
    const balance = fakeBalance();
    const state = createBalanceState({ session: fakeSession(), balance });
    await state.open('a');

    const ok = await state.topup({ amountUsd: '1', comment: '  ' }, false);

    expect(ok).toBe(true);
    expect(balance.topup).toHaveBeenCalledWith('a', { amountMicroUsd: 1000000, comment: null });
    expect(balance.getBalance).toHaveBeenCalledTimes(2);
    expect(state.submitting.value).toBe(false);
  });

  it('AC-014-27: requireComment без комментария — commentError, запроса нет', async () => {
    const balance = fakeBalance();
    const state = createBalanceState({ session: fakeSession(), balance });
    await state.open('a');

    const ok = await state.topup({ amountUsd: '1', comment: '   ' }, true);

    expect(ok).toBe(false);
    expect(state.commentError.value).toBe(FORM_TEXT.comment);
    expect(balance.topup).not.toHaveBeenCalled();
  });

  it('AC-014-27: canTopup — у роли с balance.topup true, без права false', () => {
    const admin = createBalanceState({ session: fakeSession('admin'), balance: fakeBalance() });
    const user = createBalanceState({ session: fakeSession('user'), balance: fakeBalance() });

    expect(admin.canTopup.value).toBe(true);
    expect(user.canTopup.value).toBe(false);
  });
});
