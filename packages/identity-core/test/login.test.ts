import { describe, expect, it } from 'vitest';
import { RATE_LIMITS } from '../src/index.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  NOW,
  createTestEnv,
  seedAdmin,
  type TestEnv,
} from './fakes.ts';

// Спека 012, T-8: login, me, dummyHash (4.2), лимиты входа (4.8).

const meta = { ip: '10.0.0.3' };
const PASSWORD = ADMIN_PASSWORD;
const EMAIL = ADMIN_EMAIL;
const MINUTE_MS = 60_000;

// Пользователь с организацией, как после confirmRegistration (через хранилище, без HTTP).
async function seedEnv(): Promise<{ env: TestEnv; userId: string; orgId: string }> {
  const env = createTestEnv();
  return { env, ...(await seedAdmin(env)) };
}

describe('identity-core — login и me (спека 012, T-8)', () => {
  it('REQ-012-9: верный пароль — сессия с утверждениями пользователя и токен обновления', async () => {
    const { env, userId, orgId } = await seedEnv();
    const result = await env.core.login({ email: EMAIL, password: PASSWORD }, meta);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { session, refreshToken } = result.value;
    expect(session.user).toMatchObject({ id: userId, email: EMAIL, role: 'admin', orgId });
    expect(session.organization).toEqual({ id: orgId, name: 'Компания' });
    expect(refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const claims = await env.verifier.verify(session.accessToken);
    expect(claims).toEqual({
      sub: userId,
      org: orgId,
      role: 'admin',
      iss: 'swag-identity',
      aud: 'swag',
      iat: NOW / 1000,
      exp: NOW / 1000 + 900,
    });
    expect(session.expiresIn).toBe(900);
  });

  it('REQ-012-9: пустой пароль и email не по схеме — validation_error', async () => {
    const { env } = await seedEnv();
    expect(await env.core.login({ email: EMAIL, password: '' }, meta)).toMatchObject({
      ok: false,
      error: { code: 'validation_error', issues: [{ path: 'password' }] },
    });
    expect(await env.core.login({ email: 'не почта', password: PASSWORD }, meta)).toMatchObject({
      ok: false,
      error: { code: 'validation_error', issues: [{ path: 'email' }] },
    });
  });

  it('AC-012-12: неверный пароль существующего и неизвестный email — одинаковый invalid_credentials, verify ровно один раз в каждом случае, два warn login_failed без email', async () => {
    const { env } = await seedEnv();

    const wrongPassword = await env.core.login(
      { email: EMAIL, password: 'wrong password 1' },
      meta,
    );
    const verifyAfterWrong = env.hasher.verify.mock.calls.length;
    const unknown = await env.core.login(
      { email: 'nobody@example.test', password: 'wrong password 1' },
      meta,
    );
    const verifyAfterUnknown = env.hasher.verify.mock.calls.length;

    expect(wrongPassword).toEqual(unknown);
    expect(wrongPassword).toMatchObject({ ok: false, error: { code: 'invalid_credentials' } });
    expect(verifyAfterWrong).toBe(1);
    expect(verifyAfterUnknown - verifyAfterWrong).toBe(1);

    const failures = env.entries.filter((e) => e.msg === 'login_failed');
    expect(failures).toHaveLength(2);
    expect(failures.every((e) => e.level === 'warn')).toBe(true);
    expect(failures[0]?.ctx).toHaveProperty('userId');
    expect(failures[1]?.ctx).toEqual({});
    expect(JSON.stringify(env.entries)).not.toContain('nobody@example.test');
    expect(JSON.stringify(env.entries)).not.toContain(EMAIL);
  });

  it('4.2 dummyHash: на неизвестный email хэш от случайной строки считается один раз, верify идёт с ним', async () => {
    const env = createTestEnv();
    const hashCallsBefore = env.hasher.hash.mock.calls.length;
    await env.core.login({ email: 'a@example.test', password: PASSWORD }, meta);
    await env.core.login({ email: 'b@example.test', password: PASSWORD }, meta);

    expect(env.hasher.hash.mock.calls.length - hashCallsBefore).toBe(1);
    expect(env.hasher.verify.mock.calls[0]?.[0]).toMatch(/^fake-hash:/);
    expect(env.hasher.verify.mock.calls[0]?.[0]).toBe(env.hasher.verify.mock.calls[1]?.[0]);
  });

  it('AC-012-13: 11 входов одного email за 15 мин — 11-й rate_limited без verify и письма; после окна снова разрешено', async () => {
    const { env } = await seedEnv();
    for (let i = 0; i < RATE_LIMITS.loginEmail.limit; i++) {
      expect(
        await env.core.login({ email: EMAIL, password: 'wrong password 1' }, meta),
      ).toMatchObject({
        error: { code: 'invalid_credentials' },
      });
    }
    const verifyCalls = env.hasher.verify.mock.calls.length;
    expect(await env.core.login({ email: EMAIL, password: PASSWORD }, meta)).toMatchObject({
      ok: false,
      error: { code: 'rate_limited' },
    });
    expect(env.hasher.verify.mock.calls.length).toBe(verifyCalls);
    expect(env.entries).toContainEqual(
      expect.objectContaining({ level: 'warn', msg: 'rate_limited' }),
    );

    env.clock.advance(15 * MINUTE_MS);
    expect((await env.core.login({ email: EMAIL, password: PASSWORD }, meta)).ok).toBe(true);
  });

  it('AC-012-13: 31 вход с одного IP на разные email — 31-й rate_limited', async () => {
    const env = createTestEnv();
    for (let i = 0; i < RATE_LIMITS.loginIp.limit; i++) {
      await env.core.login({ email: `n${i}@example.test`, password: PASSWORD }, meta);
    }
    expect(
      await env.core.login({ email: 'last@example.test', password: PASSWORD }, meta),
    ).toMatchObject({
      error: { code: 'rate_limited' },
    });
  });

  it('REQ-012-13: me — верный токен отдаёт пользователя и организацию', async () => {
    const { env, userId, orgId } = await seedEnv();
    const login = await env.core.login({ email: EMAIL, password: PASSWORD }, meta);
    if (!login.ok) throw new Error('вход не прошёл');

    const me = await env.core.me(login.value.session.accessToken);
    expect(me).toEqual({
      ok: true,
      value: {
        user: { id: userId, email: EMAIL, role: 'admin', orgId },
        organization: { id: orgId, name: 'Компания' },
      },
    });
  });

  it('REQ-012-13: me — нет токена, испорченный, чужой iss или aud, alg none и просроченный — unauthorized', async () => {
    const { env } = await seedEnv();
    const login = await env.core.login({ email: EMAIL, password: PASSWORD }, meta);
    if (!login.ok) throw new Error('вход не прошёл');
    const claims = await env.verifier.verify(login.value.session.accessToken);
    if (!claims) throw new Error('токен не разобран');

    const forged = (patch: Record<string, unknown>) =>
      `fake.${JSON.stringify({ ...claims, ...patch })}`;
    const rejected = [
      undefined,
      'garbage',
      'none.' + JSON.stringify(claims),
      forged({ iss: 'evil' }),
      forged({ aud: 'other' }),
    ];
    for (const token of rejected) {
      expect(await env.core.me(token)).toEqual({
        ok: false,
        error: { code: 'unauthorized', message: 'unauthorized' },
      });
    }

    env.clock.advance(900 * 1000 + 1000);
    expect(await env.core.me(login.value.session.accessToken)).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    });
  });
});
