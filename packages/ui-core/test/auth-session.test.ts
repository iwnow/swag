import { describe, expect, it, vi } from 'vitest';
import type { AuthRefreshed, AuthSession } from '@swag/contracts';
import { createAuthSessionKeeper, type AuthApi } from '../src/index.ts';

const session = (accessToken: string): AuthSession =>
  ({
    accessToken,
    expiresIn: 900,
    user: {
      id: '6f1c2b1e-0000-4000-8000-000000000001',
      email: 'u@example.test',
      role: 'user',
      orgId: null,
      blocked: false,
    },
    organization: null,
  }) as AuthSession;

function fakeApi(overrides: Partial<AuthApi> = {}): AuthApi {
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

describe('auth session keeper', () => {
  it('AC-024-23: restore берёт токен по refresh', async () => {
    const api = fakeApi();
    const keeper = createAuthSessionKeeper(api);

    expect(keeper.accessToken()).toBeNull();
    await expect(keeper.restore()).resolves.toBe(true);
    expect(keeper.accessToken()).toBe('refreshed-token');
    expect(api.refresh).toHaveBeenCalledTimes(1);
  });

  it('AC-024-23: restore при null от refresh возвращает false без токена', async () => {
    const keeper = createAuthSessionKeeper(fakeApi({ refresh: async () => null }));

    await expect(keeper.restore()).resolves.toBe(false);
    expect(keeper.accessToken()).toBeNull();
  });

  it('AC-024-23: login запоминает токен и возвращает код ошибки при reject', async () => {
    const keeper = createAuthSessionKeeper(fakeApi());
    await expect(keeper.login('u@example.test', 'pw')).resolves.toEqual({ ok: true });
    expect(keeper.accessToken()).toBe('login-token');

    const failing = createAuthSessionKeeper(
      fakeApi({
        login: async () => Promise.reject(Object.assign(new Error('x'), { code: 'user_blocked' })),
      }),
    );
    await expect(failing.login('u@example.test', 'pw')).resolves.toEqual({
      ok: false,
      code: 'user_blocked',
    });
    expect(failing.accessToken()).toBeNull();

    const anonymous = createAuthSessionKeeper(
      fakeApi({ login: async () => Promise.reject(new Error('net')) }),
    );
    await expect(anonymous.login('u@example.test', 'pw')).resolves.toEqual({
      ok: false,
      code: 'unknown',
    });
  });

  it('AC-024-23: три одновременных renew делают один refresh', async () => {
    const api = fakeApi();
    const keeper = createAuthSessionKeeper(api);

    const results = await Promise.all([keeper.renew(), keeper.renew(), keeper.renew()]);

    expect(results).toEqual([true, true, true]);
    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(keeper.accessToken()).toBe('refreshed-token');
  });

  it('AC-024-23: неудачный renew стирает токен и вызывает onSignedOut', async () => {
    const listener = vi.fn();
    const keeper = createAuthSessionKeeper(fakeApi({ refresh: async () => null }));
    keeper.onSignedOut(listener);
    await keeper.login('u@example.test', 'pw');

    await expect(keeper.renew()).resolves.toBe(false);
    expect(keeper.accessToken()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);

    const rejecting = createAuthSessionKeeper(
      fakeApi({ refresh: async () => Promise.reject(new Error('net')) }),
    );
    const rejectListener = vi.fn();
    rejecting.onSignedOut(rejectListener);
    await expect(rejecting.renew()).resolves.toBe(false);
    expect(rejectListener).toHaveBeenCalledTimes(1);
  });

  it('AC-024-23: logout стирает токен', async () => {
    const api = fakeApi();
    const keeper = createAuthSessionKeeper(api);
    await keeper.login('u@example.test', 'pw');

    await keeper.logout();

    expect(api.logout).toHaveBeenCalledTimes(1);
    expect(keeper.accessToken()).toBeNull();
  });

  it('AC-024-23: отписка от onSignedOut работает', async () => {
    const listener = vi.fn();
    const keeper = createAuthSessionKeeper(fakeApi({ refresh: async () => null }));
    const unsubscribe = keeper.onSignedOut(listener);
    unsubscribe();

    await keeper.renew();

    expect(listener).not.toHaveBeenCalled();
  });

  it('AC-024-23: restore и renew делят один refresh', async () => {
    const api = fakeApi();
    const keeper = createAuthSessionKeeper(api);

    const results = await Promise.all([keeper.restore(), keeper.renew()]);

    expect(results).toEqual([true, true]);
    expect(api.refresh).toHaveBeenCalledTimes(1);
    expect(keeper.accessToken()).toBe('refreshed-token');
  });

  it('AC-024-23: renew, затем logout, затем поздний refresh не записывает токен и не вызывает onSignedOut', async () => {
    const pending = deferred<AuthRefreshed | null>();
    const listener = vi.fn();
    const keeper = createAuthSessionKeeper(fakeApi({ refresh: () => pending.promise }));
    keeper.onSignedOut(listener);

    const renewed = keeper.renew();
    await keeper.logout();
    pending.resolve({ accessToken: 'late-token', expiresIn: 900 });

    await expect(renewed).resolves.toBe(false);
    expect(keeper.accessToken()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it('AC-024-23: renew, затем login, затем поздний refresh — токен от login', async () => {
    const pending = deferred<AuthRefreshed | null>();
    const keeper = createAuthSessionKeeper(fakeApi({ refresh: () => pending.promise }));

    const renewed = keeper.renew();
    await expect(keeper.login('u@example.test', 'pw')).resolves.toEqual({ ok: true });
    pending.resolve({ accessToken: 'late-token', expiresIn: 900 });

    await expect(renewed).resolves.toBe(false);
    expect(keeper.accessToken()).toBe('login-token');
  });

  it('AC-014-1: confirmRegistration и acceptInvitation с успехом дают ok и токен из ответа', async () => {
    const confirm = createAuthSessionKeeper(fakeApi());
    await expect(
      confirm.confirmRegistration({ token: 't', password: 'password-10', organizationName: 'Org' }),
    ).resolves.toEqual({ ok: true });
    expect(confirm.accessToken()).toBe('confirm-token');

    const invite = createAuthSessionKeeper(fakeApi());
    await expect(invite.acceptInvitation({ token: 't', password: 'password-10' })).resolves.toEqual(
      { ok: true },
    );
    expect(invite.accessToken()).toBe('invite-token');
  });

  it('AC-014-1: reject invalid_token даёт код и не записывает токен', async () => {
    const rejecting = { code: 'invalid_token' };
    const keeper = createAuthSessionKeeper(
      fakeApi({
        confirmRegistration: async () => Promise.reject(rejecting),
        acceptInvitation: async () => Promise.reject(rejecting),
      }),
    );

    await expect(
      keeper.confirmRegistration({
        token: 'bad',
        password: 'password-10',
        organizationName: 'Org',
      }),
    ).resolves.toEqual({ ok: false, code: 'invalid_token' });
    await expect(
      keeper.acceptInvitation({ token: 'bad', password: 'password-10' }),
    ).resolves.toEqual({ ok: false, code: 'invalid_token' });
    expect(keeper.accessToken()).toBeNull();
  });

  it('AC-014-1: register с успехом даёт ok, с rate_limited — код, токен прежний', async () => {
    const keeper = createAuthSessionKeeper(fakeApi());
    await keeper.login('u@example.test', 'pw');

    await expect(keeper.register('new@example.test')).resolves.toEqual({ ok: true });
    expect(keeper.accessToken()).toBe('login-token');

    const limited = createAuthSessionKeeper(
      fakeApi({ register: async () => Promise.reject({ code: 'rate_limited' }) }),
    );
    await limited.login('u@example.test', 'pw');
    await expect(limited.register('new@example.test')).resolves.toEqual({
      ok: false,
      code: 'rate_limited',
    });
    expect(limited.accessToken()).toBe('login-token');
  });

  it('AC-014-1: refresh, начатый до confirmRegistration, не записывает токен после него', async () => {
    const pending = deferred<AuthRefreshed | null>();
    const keeper = createAuthSessionKeeper(fakeApi({ refresh: () => pending.promise }));

    const restored = keeper.restore();
    await keeper.confirmRegistration({
      token: 't',
      password: 'password-10',
      organizationName: 'Org',
    });
    pending.resolve({ accessToken: 'late-token', expiresIn: 900 });

    await expect(restored).resolves.toBe(false);
    expect(keeper.accessToken()).toBe('confirm-token');
  });

  it('AC-014-1: register не меняет поколение — refresh, начатый до него, записывает токен', async () => {
    const pending = deferred<AuthRefreshed | null>();
    const keeper = createAuthSessionKeeper(fakeApi({ refresh: () => pending.promise }));

    const renewed = keeper.renew();
    await keeper.register('new@example.test');
    pending.resolve({ accessToken: 'late-token', expiresIn: 900 });

    await expect(renewed).resolves.toBe(true);
    expect(keeper.accessToken()).toBe('late-token');
  });

  it('AC-014-1: reject acceptInvitation при уже выданном токене оставляет прежний токен', async () => {
    const keeper = createAuthSessionKeeper(
      fakeApi({ acceptInvitation: async () => Promise.reject({ code: 'invalid_token' }) }),
    );
    await keeper.login('u@example.test', 'pw');

    await expect(
      keeper.acceptInvitation({ token: 'bad', password: 'password-10' }),
    ).resolves.toEqual({ ok: false, code: 'invalid_token' });
    expect(keeper.accessToken()).toBe('login-token');
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
