import { describe, expect, it } from 'vitest';
import { RATE_LIMITS } from '../src/index.ts';
import { createTestEnv, tokenFromMail, HOUR_MS, type TestEnv } from './fakes.ts';

// Спека 012, T-7: confirmRegistration и issueSession (4.2), правила 4.3 для confirmRegistration.

const meta = { ip: '10.0.0.2' };
const PASSWORD = 'correct horse battery';
const EMAIL = 'owner@example.test';

async function requestToken(env: TestEnv, email = EMAIL): Promise<string> {
  const result = await env.core.requestRegistration({ email }, meta);
  if (!result.ok) throw new Error(`регистрация не прошла: ${result.error.code}`);
  const mails = env.mailer.sent.filter((m) => m.to === email);
  return tokenFromMail(mails[mails.length - 1]?.text ?? '');
}

const confirmBody = (token: string, overrides: Record<string, unknown> = {}) => ({
  token,
  password: PASSWORD,
  organizationName: '  Компания  ',
  ...overrides,
});

describe('identity-core — confirmRegistration (спека 012, T-7)', () => {
  it('REQ-012-5: подтверждение создаёт организацию и admin, выдаёт сессию; пароль в хранилище только хэшем', async () => {
    const env = createTestEnv();
    const token = await requestToken(env);

    const result = await env.core.confirmRegistration(confirmBody(token), meta);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { session, refreshToken } = result.value;
    expect(session.user).toMatchObject({ email: EMAIL, role: 'admin' });
    expect(session.organization?.name).toBe('Компания');
    expect(session.user.orgId).toBe(session.organization?.id);
    expect(session.expiresIn).toBe(900);
    expect(refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const claims = await env.verifier.verify(session.accessToken);
    expect(claims).toMatchObject({
      sub: session.user.id,
      org: session.organization?.id,
      role: 'admin',
      iss: 'swag-identity',
      aud: 'swag',
    });

    const stored = await env.store.findUserById(session.user.id);
    expect(stored?.user.passwordHash).not.toBe(PASSWORD);
    expect(await env.hasher.verify(stored?.user.passwordHash ?? '', PASSWORD)).toBe(true);
  });

  it('REQ-012-19: пароль короче 10 символов и пустое название — validation_error', async () => {
    const env = createTestEnv();
    const token = await requestToken(env);

    const shortPassword = await env.core.confirmRegistration(
      confirmBody(token, { password: '123456789' }),
      meta,
    );
    expect(shortPassword).toMatchObject({
      ok: false,
      error: { code: 'validation_error', issues: [{ path: 'password' }] },
    });

    const blankName = await env.core.confirmRegistration(
      confirmBody(token, { organizationName: '   ' }),
      meta,
    );
    expect(blankName).toMatchObject({
      ok: false,
      error: { code: 'validation_error', issues: [{ path: 'organizationName' }] },
    });
  });

  it('AC-012-7: повторное подтверждение того же токена — invalid_token, пользователь и организация прежние', async () => {
    const env = createTestEnv();
    const token = await requestToken(env);
    const first = await env.core.confirmRegistration(confirmBody(token), meta);
    expect(first.ok).toBe(true);

    const second = await env.core.confirmRegistration(
      confirmBody(token, { organizationName: 'Другая' }),
      meta,
    );
    expect(second).toEqual({
      ok: false,
      error: { code: 'invalid_token', message: 'invalid or expired token' },
    });
    const stored = await env.store.findUserByEmail(EMAIL);
    expect(stored?.id).toBe(first.ok ? first.value.session.user.id : '');
  });

  it('AC-012-8: истёкший и неизвестный токен дают одинаковый invalid_token, в логе warn confirm_invalid_token', async () => {
    const env = createTestEnv();
    const token = await requestToken(env);
    env.clock.advance(86_400_000 + 1000);

    const expired = await env.core.confirmRegistration(confirmBody(token), meta);
    const unknown = await env.core.confirmRegistration(confirmBody('x'.repeat(43)), meta);

    expect(expired).toEqual(unknown);
    expect(expired).toMatchObject({ ok: false, error: { code: 'invalid_token' } });
    const warnings = env.entries.filter((e) => e.msg === 'confirm_invalid_token');
    expect(warnings).toHaveLength(2);
    expect(warnings.every((e) => e.level === 'warn' && e.ctx === undefined)).toBe(true);
  });

  it('REQ-012-6: одновременные подтверждения одним токеном — ровно один ok', async () => {
    const env = createTestEnv();
    const token = await requestToken(env);

    const results = await Promise.all([
      env.core.confirmRegistration(confirmBody(token), meta),
      env.core.confirmRegistration(confirmBody(token), meta),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, error: { code: 'invalid_token', message: 'invalid or expired token' } },
    ]);
  });

  it('AC-012-10: две регистрации одного email — вторая получает email_taken и её токен не погашен', async () => {
    const env = createTestEnv();
    const firstToken = await requestToken(env);
    const secondToken = await requestToken(env);
    expect(secondToken).not.toBe(firstToken);

    const first = await env.core.confirmRegistration(confirmBody(firstToken), meta);
    expect(first.ok).toBe(true);

    const second = await env.core.confirmRegistration(confirmBody(secondToken), meta);
    expect(second).toEqual({
      ok: false,
      error: { code: 'email_taken', message: 'email already registered' },
    });
    // Токен не погашен: повтор отвечает email_taken, а не invalid_token.
    const again = await env.core.confirmRegistration(confirmBody(secondToken), meta);
    expect(again).toMatchObject({ ok: false, error: { code: 'email_taken' } });
    const stored = await env.store.findUserByEmail(EMAIL);
    expect(stored?.id).toBe(first.ok ? first.value.session.user.id : '');
  });

  it('REQ-012-16: лимит confirm:ip — 21-я попытка rate_limited, хэшер на ней не вызывается', async () => {
    const env = createTestEnv();
    const bad = confirmBody('y'.repeat(43));
    for (let i = 0; i < RATE_LIMITS.confirmIp.limit; i++) {
      expect(await env.core.confirmRegistration(bad, meta)).toMatchObject({
        error: { code: 'invalid_token' },
      });
    }
    const hashCalls = env.hasher.hash.mock.calls.length;
    expect(await env.core.confirmRegistration(bad, meta)).toMatchObject({
      ok: false,
      error: { code: 'rate_limited' },
    });
    expect(env.hasher.hash.mock.calls.length).toBe(hashCalls);

    env.clock.advance(HOUR_MS);
    expect(await env.core.confirmRegistration(bad, meta)).toMatchObject({
      error: { code: 'invalid_token' },
    });
  });
});
