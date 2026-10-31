import { describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@swag/contracts';
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
});
