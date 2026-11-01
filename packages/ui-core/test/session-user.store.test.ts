import { describe, expect, it, vi } from 'vitest';
import type { AuthMe, AuthSession } from '@swag/contracts';
import { createSessionUserStore, type AuthApi, type MeApi } from '../src/index.ts';

const USER_A = '6f1c2b1e-0000-4000-8000-00000000000a';
const USER_B = '6f1c2b1e-0000-4000-8000-00000000000b';

const session = (accessToken: string): AuthSession =>
  ({
    accessToken,
    expiresIn: 900,
    user: { id: USER_A, email: 'u@example.test', role: 'user', orgId: null, blocked: false },
    organization: null,
  }) as AuthSession;

const meOf = (userId: string): AuthMe =>
  ({
    user: { id: userId, email: 'u@example.test', role: 'user', orgId: null },
    organization: null,
  }) as AuthMe;

function fakeAuth(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    login: vi.fn(async () => session('login-token')),
    refresh: vi.fn(async () => ({ accessToken: 'refreshed-token', expiresIn: 900 })),
    logout: vi.fn(async () => undefined),
    register: vi.fn(async () => undefined),
    confirmRegistration: vi.fn(async () => session('confirm-token')),
    acceptInvitation: vi.fn(async () => session('invite-token')),
    ...overrides,
  };
}

// refresh по очереди отдаёт токены из списка; когда список пуст — null (401).
function refreshing(...tokens: string[]): AuthApi['refresh'] {
  return vi.fn<AuthApi['refresh']>(async () => {
    const accessToken = tokens.shift();
    return accessToken === undefined ? null : { accessToken, expiresIn: 900 };
  });
}

function fakeMe(me: MeApi['me'] = async () => meOf(USER_A)): MeApi {
  return { me: vi.fn(me) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('session user store', () => {
  it('AC-014-21: два одновременных restore дают один refresh и один me', async () => {
    const auth = fakeAuth();
    const meApi = fakeMe();
    const store = createSessionUserStore({ auth, me: meApi });

    await expect(Promise.all([store.restore(), store.restore()])).resolves.toEqual([true, true]);
    expect(auth.refresh).toHaveBeenCalledTimes(1);
    expect(meApi.me).toHaveBeenCalledTimes(1);
    expect(store.status.value).toBe('signed-in');
  });

  it('AC-014-21: login успешен — signed-in, me из MeApi, вызов me один', async () => {
    const meApi = fakeMe();
    const store = createSessionUserStore({ auth: fakeAuth(), me: meApi });

    await expect(store.login('u@example.test', 'pw')).resolves.toEqual({ ok: true });
    expect(store.status.value).toBe('signed-in');
    expect(store.me.value).toEqual(meOf(USER_A));
    expect(meApi.me).toHaveBeenCalledTimes(1);
  });

  it('AC-014-21: ensureMe с тем же токеном не вызывает MeApi повторно', async () => {
    const meApi = fakeMe();
    const store = createSessionUserStore({ auth: fakeAuth(), me: meApi });

    await store.login('u@example.test', 'pw');
    await store.ensureMe();
    expect(meApi.me).toHaveBeenCalledTimes(1);
  });

  it('AC-014-21: renew дал новый токен — me перечитан один раз', async () => {
    const meApi = fakeMe();
    const store = createSessionUserStore({
      auth: fakeAuth({ refresh: refreshing('t1', 't2') }),
      me: meApi,
    });

    await store.restore();
    await expect(store.renew()).resolves.toBe(true);
    expect(meApi.me).toHaveBeenCalledTimes(2);
    expect(meApi.me).toHaveBeenLastCalledWith('t2');
  });

  it('AC-014-21: MeApi.me вернул null — один renew и один повтор', async () => {
    const auth = fakeAuth({ refresh: refreshing('t1', 't2') });
    const meApi = fakeMe(async (token) => (token === 't2' ? meOf(USER_A) : null));
    const store = createSessionUserStore({ auth, me: meApi });

    await store.restore();
    expect(auth.refresh).toHaveBeenCalledTimes(2);
    expect(meApi.me).toHaveBeenCalledTimes(2);
    expect(store.status.value).toBe('signed-in');
  });

  it('AC-014-21: токен сменился, пока шёл me — ответ для старого токена не записан', async () => {
    const stale = deferred<AuthMe | null>();
    const meApi = fakeMe(async (token) => (token === 'login-token' ? meOf(USER_B) : stale.promise));
    const store = createSessionUserStore({
      auth: fakeAuth({ refresh: refreshing('t1') }),
      me: meApi,
    });

    const restoring = store.restore();
    await vi.waitFor(() => expect(meApi.me).toHaveBeenCalledWith('t1'));
    await expect(store.login('u@example.test', 'pw')).resolves.toEqual({ ok: true });

    stale.resolve(meOf(USER_A));
    await restoring;
    expect(store.me.value).toEqual(meOf(USER_B));
    expect(store.status.value).toBe('signed-in');
  });

  it('AC-014-21: отказ renew — onSignedOut хранителя, me null и signed-out', async () => {
    const store = createSessionUserStore({
      auth: fakeAuth({ refresh: vi.fn(async () => null) }),
      me: fakeMe(),
    });

    await store.login('u@example.test', 'pw');
    expect(store.status.value).toBe('signed-in');

    await expect(store.renew()).resolves.toBe(false);
    expect(store.me.value).toBeNull();
    expect(store.status.value).toBe('signed-out');
  });

  it('AC-014-21: logout — me null и signed-out', async () => {
    const auth = fakeAuth();
    const store = createSessionUserStore({ auth, me: fakeMe() });

    await store.login('u@example.test', 'pw');
    await store.logout();
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(store.me.value).toBeNull();
    expect(store.status.value).toBe('signed-out');
  });
});
