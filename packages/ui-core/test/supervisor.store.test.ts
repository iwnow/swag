import { describe, expect, it, vi } from 'vitest';
import { signal } from '@preact/signals-core';
import type {
  AuthMe,
  BalanceEntry,
  BalanceView,
  ManagedUser,
  OrganizationList,
  OrganizationSummary,
  UserList,
} from '@swag/contracts';
import {
  authErrorText,
  createSupervisorStore,
  FORM_TEXT,
  type BalanceApi,
  type OrganizationsApi,
  type SessionUserStore,
  type UsersApi,
} from '../src/index.ts';

const ORG_A = '0b6f6d2e-6a4c-4c3e-9f5e-00000000000a';
const ORG_B = '0b6f6d2e-6a4c-4c3e-9f5e-00000000000b';
const SUPERVISOR_ID = '00000000-0000-4000-8000-0000000000ff';

const me = {
  user: { id: SUPERVISOR_ID, email: 'sup@x.example', role: 'supervisor', orgId: null },
  organization: null,
} as AuthMe;

const org = (id: string, name: string): OrganizationSummary => ({
  id,
  name,
  createdAt: '2026-10-22T10:00:00.000Z',
  userCount: 1,
});

const user = (overrides: Partial<ManagedUser>): ManagedUser =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    email: 'u@x.example',
    role: 'user',
    orgId: ORG_A,
    blocked: false,
    createdAt: '2026-10-22T10:00:00.000Z',
    ...overrides,
  }) as ManagedUser;

const forbidden = (): Error =>
  Object.assign(new Error('forbidden'), { status: 403, code: 'forbidden' });

const ENTRY = { id: 1 } as BalanceEntry;
const viewOf = (orgId: string): BalanceView =>
  ({ orgId, balanceMicroUsd: 1000000, heldMicroUsd: 0, availableMicroUsd: 1000000 }) as BalanceView;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeSession(value: AuthMe | null = me): Pick<SessionUserStore, 'me' | 'role'> {
  return {
    me: signal<AuthMe | null>(value),
    role: signal<AuthMe['user']['role'] | null>('supervisor'),
  };
}

function fakeOrganizations(list: OrganizationSummary[] = [org(ORG_A, 'A'), org(ORG_B, 'B')]) {
  return {
    list: vi.fn(async () => ({ organizations: list }) as OrganizationList),
  } satisfies OrganizationsApi;
}

function fakeUsers(list: ManagedUser[] = [user({})]) {
  const api = {
    list: vi.fn(async (_orgId: string | null) => ({ users: list }) as UserList),
    invite: vi.fn(async () => undefined),
    update: vi.fn(async () => list[0]!),
  };
  return api satisfies UsersApi & Record<string, unknown>;
}

function fakeBalance() {
  return {
    getBalance: vi.fn(async (orgId: string) => viewOf(orgId)),
    listBalanceEntries: vi.fn(async () => ({ entries: [ENTRY], nextBefore: null })),
    topup: vi.fn(async () => ENTRY),
  } satisfies BalanceApi & Record<string, unknown>;
}

function makeStore(
  parts: {
    session?: Pick<SessionUserStore, 'me' | 'role'>;
    users?: ReturnType<typeof fakeUsers>;
    organizations?: ReturnType<typeof fakeOrganizations>;
    balance?: ReturnType<typeof fakeBalance>;
  } = {},
) {
  const users = parts.users ?? fakeUsers();
  const organizations = parts.organizations ?? fakeOrganizations();
  const balance = parts.balance ?? fakeBalance();
  const store = createSupervisorStore({
    session: parts.session ?? fakeSession(),
    users,
    organizations,
    balance,
  });
  return { store, users, organizations, balance };
}

describe('createSupervisorStore', () => {
  it('AC-014-25: openOrganization(missing) после загрузки списка — notFound true', async () => {
    const { store } = makeStore();
    await store.loadOrganizations();

    await store.openOrganization('missing');

    expect(store.notFound.value).toBe(true);
    expect(store.organization.value).toBeNull();
  });

  it('AC-014-25: openOrganization(a) после загрузки списка — notFound false, organization по orgId', async () => {
    const { store } = makeStore();
    await store.loadOrganizations();

    await store.openOrganization(ORG_A);

    expect(store.notFound.value).toBe(false);
    expect(store.organization.value).toEqual(org(ORG_A, 'A'));
  });

  it('AC-014-25: notFound false, пока список не загружен', async () => {
    const { store } = makeStore();

    await store.openOrganization('missing');

    expect(store.loaded.value).toBe(false);
    expect(store.notFound.value).toBe(false);
  });

  it('AC-014-25: открытие a, затем b, ответ пользователей a пришёл последним — users от b', async () => {
    const pendingA = deferred<UserList>();
    const usersB = [user({ id: '00000000-0000-4000-8000-0000000000b1', email: 'b@x.example' })];
    const users = fakeUsers();
    users.list.mockImplementation((orgId: string | null) =>
      orgId === ORG_A ? pendingA.promise : Promise.resolve({ users: usersB }),
    );
    const { store } = makeStore({ users });

    const openA = store.openOrganization(ORG_A);
    await store.openOrganization(ORG_B);
    pendingA.resolve({ users: [user({ email: 'a@x.example' })] });
    await openA;

    expect(store.users.value).toEqual(usersB);
    expect(store.usersLoaded.value).toBe(true);
  });

  it('AC-014-25: topup без комментария — commentError, BalanceApi.topup не вызван', async () => {
    const { store, balance } = makeStore();
    await store.openOrganization(ORG_A);

    const sent = await store.topup({ amountUsd: '1', comment: '   ' });

    expect(sent).toBe(false);
    expect(store.balance.commentError.value).toBe(FORM_TEXT.comment);
    expect(balance.topup).not.toHaveBeenCalled();
  });

  it('AC-014-25: topup с комментарием — запрос уходит и баланс перечитывается', async () => {
    const { store, balance } = makeStore();
    await store.openOrganization(ORG_A);
    const reads = balance.getBalance.mock.calls.length;

    const sent = await store.topup({ amountUsd: '1', comment: 'оплата' });

    expect(sent).toBe(true);
    expect(balance.topup).toHaveBeenCalledWith(ORG_A, {
      amountMicroUsd: 1000000,
      comment: 'оплата',
    });
    expect(balance.getBalance).toHaveBeenCalledTimes(reads + 1);
  });

  it('AC-014-25: apply — один повторный list(orgId), users не опустошаются во время перечитывания', async () => {
    const target = user({});
    const users = fakeUsers([target]);
    const { store } = makeStore({ users });
    await store.openOrganization(ORG_A);
    const before = users.list.mock.calls.length;

    let release: (value: UserList) => void = () => undefined;
    users.list.mockReturnValueOnce(new Promise<UserList>((resolve) => (release = resolve)));
    const pending = store.apply(target.id, 'block');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(users.update).toHaveBeenCalledWith(target.id, { blocked: true });
    expect(users.list).toHaveBeenCalledTimes(before + 1);
    expect(users.list).toHaveBeenLastCalledWith(ORG_A);
    expect(store.users.value).toEqual([target]);

    release({ users: [target] });
    await pending;
    expect(users.list).toHaveBeenCalledTimes(before + 1);
  });

  it('AC-014-25: apply отклонён 403 — error = forbidden', async () => {
    const target = user({});
    const users = fakeUsers([target]);
    users.update.mockRejectedValueOnce(forbidden());
    const { store } = makeStore({ users });
    await store.openOrganization(ORG_A);

    await store.apply(target.id, 'block');

    expect(store.error.value).toBe(authErrorText('forbidden'));
  });

  it('AC-014-25: rows — действия userActions(me, user), без me — пусто', async () => {
    const target = user({});
    const { store } = makeStore({ users: fakeUsers([target]) });
    await store.openOrganization(ORG_A);
    expect(store.rows.value).toEqual([{ user: target, actions: ['make_admin', 'block'] }]);

    const detached = makeStore({ users: fakeUsers([target]), session: fakeSession(null) }).store;
    await detached.openOrganization(ORG_A);
    expect(detached.rows.value).toEqual([{ user: target, actions: [] }]);
  });

  it('AC-014-25: openOrganization сбрасывает users до ответа', async () => {
    const users = fakeUsers([user({})]);
    const { store } = makeStore({ users });
    await store.openOrganization(ORG_A);
    expect(store.users.value).toHaveLength(1);

    const pending = deferred<UserList>();
    users.list.mockReturnValueOnce(pending.promise);
    const reopen = store.openOrganization(ORG_B);

    expect(store.users.value).toEqual([]);
    expect(store.usersLoaded.value).toBe(false);

    pending.resolve({ users: [] });
    await reopen;
    expect(store.usersLoaded.value).toBe(true);
  });

  it('AC-014-25: loadOrganizations — повторный вызов не пишет устаревший список', async () => {
    const organizations = fakeOrganizations();
    const pending = deferred<OrganizationList>();
    organizations.list.mockReturnValueOnce(pending.promise);
    const { store } = makeStore({ organizations });

    const first = store.loadOrganizations();
    organizations.list.mockResolvedValueOnce({ organizations: [org(ORG_B, 'B')] });
    await store.loadOrganizations();
    pending.resolve({ organizations: [org(ORG_A, 'A')] });
    await first;

    expect(store.organizations.value).toEqual([org(ORG_B, 'B')]);
    expect(store.loaded.value).toBe(true);
  });

  it('AC-014-25: loadOrganizations с 403 — error = forbidden', async () => {
    const organizations = fakeOrganizations();
    organizations.list.mockRejectedValueOnce(forbidden());
    const { store } = makeStore({ organizations });

    await store.loadOrganizations();

    expect(store.error.value).toBe(authErrorText('forbidden'));
    expect(store.loaded.value).toBe(true);
  });
});
