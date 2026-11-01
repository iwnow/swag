import { describe, expect, it, vi } from 'vitest';
import type { AuthResult, SessionUserStore } from '../src/index.ts';
import { authErrorText, createShellStore } from '../src/index.ts';

type ShellSession = Pick<
  SessionUserStore,
  'login' | 'register' | 'confirmRegistration' | 'acceptInvitation' | 'logout'
>;

const OK: AuthResult = { ok: true };

function fakeSession(overrides: Partial<ShellSession> = {}): ShellSession {
  return {
    login: vi.fn(async (): Promise<AuthResult> => OK),
    register: vi.fn(async (): Promise<AuthResult> => OK),
    confirmRegistration: vi.fn(async (): Promise<AuthResult> => OK),
    acceptInvitation: vi.fn(async (): Promise<AuthResult> => OK),
    logout: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakePreferences(stored: string | null = null) {
  return { get: vi.fn(() => stored), set: vi.fn() };
}

const CONFIRM_INPUT = {
  token: 'token-1',
  password: 'пароль-один',
  repeat: 'пароль-два',
  organizationName: 'Org',
};

describe('shell store', () => {
  it('AC-014-22: register с неверным email — issues, запроса нет', async () => {
    const session = fakeSession();
    const store = createShellStore({ session, preferences: fakePreferences() });

    await store.register('не-email');

    expect(store.form.value.issues.length).toBeGreaterThan(0);
    expect(session.register).not.toHaveBeenCalled();
  });

  it('AC-014-22: register с ответом 202 — sent', async () => {
    const session = fakeSession();
    const store = createShellStore({ session, preferences: fakePreferences() });

    await store.register('u@example.test');

    expect(session.register).toHaveBeenCalledWith('u@example.test');
    expect(store.form.value.sent).toBe(true);
    expect(store.form.value.busy).toBe(false);
  });

  it('AC-014-22: login с invalid_credentials — null, error из authErrorText', async () => {
    const session = fakeSession({
      login: vi.fn(async (): Promise<AuthResult> => ({ ok: false, code: 'invalid_credentials' })),
    });
    const store = createShellStore({ session, preferences: fakePreferences() });

    const result = await store.login('u@example.test', 'пароль-один', null);

    expect(result).toBeNull();
    expect(store.form.value.error).toBe(authErrorText('invalid_credentials'));
    expect(store.form.value.busy).toBe(false);
  });

  it('AC-014-22: login успешен с returnTo //evil.example — результат /', async () => {
    const store = createShellStore({ session: fakeSession(), preferences: fakePreferences() });

    const result = await store.login('u@example.test', 'пароль-один', '//evil.example');

    expect(result).toBe('/');
  });

  it('AC-014-22: confirmRegistration с разными паролями — issues, запроса нет', async () => {
    const session = fakeSession();
    const store = createShellStore({ session, preferences: fakePreferences() });

    const result = await store.confirmRegistration(CONFIRM_INPUT);

    expect(result).toBeNull();
    expect(store.form.value.issues.map((issue) => issue.path)).toContain('repeat');
    expect(session.confirmRegistration).not.toHaveBeenCalled();
  });

  it('AC-014-22: theme из preferences — dark; неизвестное значение — system', () => {
    const dark = createShellStore({ session: fakeSession(), preferences: fakePreferences('dark') });
    const unknown = createShellStore({ session: fakeSession(), preferences: fakePreferences('x') });

    expect(dark.theme.value).toBe('dark');
    expect(unknown.theme.value).toBe('system');
  });

  it('AC-014-22: setTheme(light) — сигнал и preferences.set', () => {
    const preferences = fakePreferences();
    const store = createShellStore({ session: fakeSession(), preferences });

    store.setTheme('light');

    expect(store.theme.value).toBe('light');
    expect(preferences.set).toHaveBeenCalledWith('swag.theme', 'light');
  });
});
