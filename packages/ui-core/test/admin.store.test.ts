import { describe, expect, it, vi } from 'vitest';
import { signal } from '@preact/signals-core';
import type { AuthMe, ManagedUser, UserList } from '@swag/contracts';
import {
  authErrorText,
  createAdminStore,
  invitationSentText,
  type SessionUserStore,
  type UsersApi,
} from '../src/index.ts';

const ORG = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';
const OTHER_ORG = '0b6f6d2e-6a4c-4c3e-9f5e-222222222222';
const ME_ID = '00000000-0000-4000-8000-00000000000a';

const me = {
  user: { id: ME_ID, email: 'admin@x.example', role: 'admin' },
  organization: { id: ORG, name: 'Org' },
} as AuthMe;

const user = (overrides: Partial<ManagedUser>): ManagedUser =>
  ({
    id: '00000000-0000-4000-8000-000000000001',
    email: 'u@x.example',
    role: 'user',
    orgId: ORG,
    blocked: false,
    createdAt: '2026-10-22T10:00:00.000Z',
    ...overrides,
  }) as ManagedUser;

const forbidden = (): Error =>
  Object.assign(new Error('forbidden'), { status: 403, code: 'forbidden' });

function fakeUsers(list: ManagedUser[] = []) {
  const api = {
    list: vi.fn(async () => ({ users: list }) as UserList),
    invite: vi.fn(async () => undefined),
    update: vi.fn(async () => list[0]!),
  };
  return api satisfies UsersApi & Record<string, unknown>;
}

function fakeSession(value: AuthMe | null = me): Pick<SessionUserStore, 'me'> {
  return { me: signal<AuthMe | null>(value) };
}

describe('createAdminStore', () => {
  it('AC-014-24: load() — у каждой строки rows действия равны userActions(me, user)', async () => {
    const own = user({ id: ME_ID, role: 'admin' });
    const plain = user({ id: '00000000-0000-4000-8000-000000000002', email: 'a@x.example' });
    const blocked = user({
      id: '00000000-0000-4000-8000-000000000003',
      email: 'b@x.example',
      role: 'admin',
      blocked: true,
    });
    const foreign = user({
      id: '00000000-0000-4000-8000-000000000004',
      email: 'c@x.example',
      orgId: OTHER_ORG,
    });
    const store = createAdminStore({
      session: fakeSession(),
      users: fakeUsers([own, plain, blocked, foreign]),
    });

    await store.load();

    expect(store.rows.value).toEqual([
      { user: own, actions: [] },
      { user: plain, actions: ['make_admin', 'block'] },
      { user: blocked, actions: ['make_user', 'unblock'] },
      { user: foreign, actions: [] },
    ]);
    expect(store.loaded.value).toBe(true);
  });

  it('AC-014-24: apply успешен — UsersApi.list вызван ещё один раз', async () => {
    const target = user({});
    const api = fakeUsers([target]);
    const store = createAdminStore({ session: fakeSession(), users: api });
    await store.load();
    const before = api.list.mock.calls.length;

    await store.apply(target.id, 'block');

    expect(api.update).toHaveBeenCalledWith(target.id, { blocked: true });
    expect(api.list).toHaveBeenCalledTimes(before + 1);
  });

  it('AC-014-24: во время перечитывания после apply users не пустеет и loaded не сбрасывается', async () => {
    const target = user({});
    const api = fakeUsers([target]);
    const store = createAdminStore({ session: fakeSession(), users: api });
    await store.load();

    let release: (value: UserList) => void = () => undefined;
    api.list.mockReturnValueOnce(new Promise<UserList>((resolve) => (release = resolve)));
    const pending = store.apply(target.id, 'block');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.users.value).toEqual([target]);
    expect(store.loaded.value).toBe(true);

    release({ users: [target] });
    await pending;
  });

  // Стор не получает статус сессии, поэтому выйти из сессии по 403 не может.
  it('AC-014-24: apply отклонён 403 — error = forbidden', async () => {
    const target = user({});
    const api = fakeUsers([target]);
    api.update.mockRejectedValueOnce(forbidden());
    const store = createAdminStore({ session: fakeSession(), users: api });
    await store.load();

    await store.apply(target.id, 'block');

    expect(store.error.value).toBe(authErrorText('forbidden'));
  });

  it('AC-014-24: повторный load() сбрасывает users, loaded и error до ответа', async () => {
    const api = fakeUsers([user({})]);
    const store = createAdminStore({ session: fakeSession(), users: api });
    api.list.mockRejectedValueOnce(forbidden());
    await store.load();
    expect(store.error.value).toBe(authErrorText('forbidden'));

    let release: (value: UserList) => void = () => undefined;
    api.list.mockReturnValueOnce(new Promise<UserList>((resolve) => (release = resolve)));
    const pending = store.load();

    expect(store.error.value).toBeNull();
    expect(store.users.value).toEqual([]);
    expect(store.loaded.value).toBe(false);

    release({ users: [user({ email: 'new@x.example' })] });
    await pending;
    expect(store.users.value.map((u) => u.email)).toEqual(['new@x.example']);
    expect(store.loaded.value).toBe(true);
  });

  it('AC-014-24: sendInvite с неверным email — запроса нет, issue email', async () => {
    const api = fakeUsers();
    const store = createAdminStore({ session: fakeSession(), users: api });

    await store.sendInvite('a@b', 'user');

    expect(api.invite).not.toHaveBeenCalled();
    expect(store.invite.value.issues).toEqual([{ path: 'email', message: 'Введите email.' }]);
    expect(store.invite.value.sent).toBeNull();
  });

  it('AC-014-24: sendInvite успешен — sent с текстом 4.6, тело приглашения нормализовано', async () => {
    const api = fakeUsers();
    const store = createAdminStore({ session: fakeSession(), users: api });

    await store.sendInvite(' A@B.example ', 'admin');

    expect(api.invite).toHaveBeenCalledWith({ email: 'a@b.example', role: 'admin' });
    expect(store.invite.value.sent).toBe(invitationSentText('a@b.example'));
    expect(store.invite.value.busy).toBe(false);
  });

  it('AC-014-24: sendInvite отклонён 403 — error = forbidden, sent пуст', async () => {
    const api = fakeUsers();
    api.invite.mockRejectedValueOnce(forbidden());
    const store = createAdminStore({ session: fakeSession(), users: api });

    await store.sendInvite('a@b.example', 'user');

    expect(store.invite.value.error).toBe(authErrorText('forbidden'));
    expect(store.invite.value.sent).toBeNull();
    expect(store.invite.value.busy).toBe(false);
  });

  it('AC-014-24: resetInvite сбрасывает issues, error и sent', async () => {
    const api = fakeUsers();
    const store = createAdminStore({ session: fakeSession(), users: api });
    await store.sendInvite('a@b.example', 'user');
    expect(store.invite.value.sent).not.toBeNull();

    store.resetInvite();

    expect(store.invite.value).toEqual({ busy: false, issues: [], error: null, sent: null });
  });

  it('AC-014-24: без сессии (me = null) строки без действий', async () => {
    const target = user({});
    const store = createAdminStore({
      session: fakeSession(null),
      users: fakeUsers([target]),
    });

    await store.load();

    expect(store.rows.value).toEqual([{ user: target, actions: [] }]);
  });
});
