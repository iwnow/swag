import { describe, expect, it, vi } from 'vitest';
import { CONFIRM_MAIL_SUBJECT } from '../src/index.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  createTestEnv,
  seedAdmin,
  sentMail,
  tokenFromMail,
  type TestEnv,
} from './fakes.ts';

// Спека 012, T-9: refresh и logout (4.2), сроки сессии (Q-1).

const meta = { ip: '10.0.0.4' };
const REFRESH_TTL_MS = 2_592_000 * 1000;
const INVALID = {
  ok: false,
  error: { code: 'invalid_refresh_token', message: 'invalid refresh token' },
};

async function loginToken(
  env: TestEnv,
): Promise<{ userId: string; refreshToken: string; accessToken: string }> {
  const { userId } = await seedAdmin(env);
  const result = await env.core.login({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, meta);
  if (!result.ok) throw new Error('вход не прошёл');
  return {
    userId,
    refreshToken: result.value.refreshToken,
    accessToken: result.value.session.accessToken,
  };
}

describe('identity-core — refresh и logout (спека 012, T-9)', () => {
  it('REQ-012-11: refresh отдаёт новый токен доступа и новый токен обновления', async () => {
    const env = createTestEnv();
    const { refreshToken } = await loginToken(env);

    const result = await env.core.refresh(refreshToken);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.refreshToken).not.toBe(refreshToken);
    expect(result.value.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.value.refreshed.expiresIn).toBe(900);
    expect(await env.verifier.verify(result.value.refreshed.accessToken)).toMatchObject({
      role: 'admin',
      iss: 'swag-identity',
    });
  });

  it('AC-012-15: повтор уже заменённого токена — invalid_refresh_token и warn refresh_reuse_detected; новый токен после этого тоже отказ', async () => {
    const env = createTestEnv();
    const { userId, refreshToken } = await loginToken(env);
    const first = await env.core.refresh(refreshToken);
    if (!first.ok) throw new Error('обновление не прошло');

    const reused = await env.core.refresh(refreshToken);
    expect(reused).toEqual(INVALID);
    expect(env.entries).toContainEqual({
      level: 'warn',
      msg: 'refresh_reuse_detected',
      ctx: { userId },
    });
    expect(await env.core.refresh(first.value.refreshToken)).toEqual(INVALID);
  });

  it('4.2 (D-116 а): сессия обновлена, но пользователя нет в хранилище — invalid_refresh_token', async () => {
    const env = createTestEnv();
    const { refreshToken } = await loginToken(env);
    vi.spyOn(env.store, 'findUserById').mockResolvedValueOnce(null);
    expect(await env.core.refresh(refreshToken)).toEqual(INVALID);
  });

  it('REQ-012-12: нет токена или неизвестный токен — invalid_refresh_token', async () => {
    const env = createTestEnv();
    await loginToken(env);
    expect(await env.core.refresh(undefined)).toEqual(INVALID);
    expect(await env.core.refresh('z'.repeat(43))).toEqual(INVALID);
  });

  it('AC-012-16: logout отзывает сессию; refresh с прежним токеном — invalid_refresh_token; повторный logout — ok', async () => {
    const env = createTestEnv();
    const { refreshToken } = await loginToken(env);

    expect(await env.core.logout(refreshToken)).toEqual({ ok: true, value: undefined });
    expect(await env.core.refresh(refreshToken)).toEqual(INVALID);
    expect(await env.core.logout(refreshToken)).toEqual({ ok: true, value: undefined });
  });

  it('AC-012-16: logout без токена и с неизвестным токеном — тоже ok', async () => {
    const env = createTestEnv();
    expect(await env.core.logout(undefined)).toEqual({ ok: true, value: undefined });
    expect(await env.core.logout('q'.repeat(43))).toEqual({ ok: true, value: undefined });
  });

  it('AC-012-16: сессия с истёкшим сроком (refreshTtl + 1 с) — invalid_refresh_token', async () => {
    const env = createTestEnv();
    const { refreshToken } = await loginToken(env);
    env.clock.advance(REFRESH_TTL_MS + 1000);
    expect(await env.core.refresh(refreshToken)).toEqual(INVALID);
  });

  it('AC-012-22 (ядро): полный сценарий — регистрация, подтверждение, вход, обновление, выход, неверный вход — в логах и ошибках нет секретов', async () => {
    const env = createTestEnv();
    const email = 'flow@example.test';
    const password = 'flow password 123';
    const reg = await env.core.requestRegistration({ email }, meta);
    expect(reg.ok).toBe(true);
    const rawToken = tokenFromMail(sentMail(env).text);
    const confirm = await env.core.confirmRegistration(
      { token: rawToken, password, organizationName: 'Поток' },
      meta,
    );
    if (!confirm.ok) throw new Error('подтверждение не прошло');
    const login = await env.core.login({ email, password }, meta);
    if (!login.ok) throw new Error('вход не прошёл');
    const refreshed = await env.core.refresh(login.value.refreshToken);
    if (!refreshed.ok) throw new Error('обновление не прошло');
    await env.core.logout(refreshed.value.refreshToken);
    const wrong = await env.core.login({ email, password: 'wrong password 1' }, meta);

    const secrets = [
      email,
      password,
      `fake-hash:${password}`,
      rawToken,
      login.value.refreshToken,
      refreshed.value.refreshToken,
      login.value.session.accessToken,
      refreshed.value.refreshed.accessToken,
    ];
    const observed = JSON.stringify({ entries: env.entries, wrong, reg });
    for (const secret of secrets) {
      expect(observed).not.toContain(secret);
    }
    expect(env.mailer.sent.map((m) => m.subject)).toEqual([CONFIRM_MAIL_SUBJECT]);
  });
});
