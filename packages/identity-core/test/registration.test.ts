import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ALREADY_REGISTERED_MAIL_SUBJECT,
  ALREADY_REGISTERED_MAIL_TEXT,
  CONFIRM_MAIL_SUBJECT,
} from '../src/index.ts';
import { CONFIRM_URL, HOUR_MS, NOW, createTestEnv, sentMail, tokenFromMail } from './fakes.ts';

// Спека 012, T-6: requestRegistration (4.2), лимиты регистрации (4.8), письма (4.6).

const meta = { ip: '10.0.0.1' };
const DAY_MS = 24 * HOUR_MS;

describe('identity-core — requestRegistration (спека 012, T-6)', () => {
  it('REQ-012-2: email нормализуется (trim и нижний регистр), письмо уходит на него, ответ ok с пустым значением', async () => {
    const env = createTestEnv();
    const result = await env.core.requestRegistration({ email: '  Shop@Example.COM ' }, meta);
    expect(result).toEqual({ ok: true, value: undefined });
    expect(env.mailer.sent).toHaveLength(1);
    expect(sentMail(env).to).toBe('shop@example.com');
  });

  it('REQ-012-2: некорректный email — validation_error с путём email, письма нет', async () => {
    const env = createTestEnv();
    const result = await env.core.requestRegistration({ email: 'не почта' }, meta);
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'validation_error', issues: [{ path: 'email' }] },
    });
    expect(env.mailer.sent).toHaveLength(0);
  });

  it('AC-012-4: новый email — одно письмо с темой подтверждения и ссылкой, в хранилище только хэш токена', async () => {
    const env = createTestEnv();
    const addSpy = vi.spyOn(env.store, 'addConfirmation');
    await env.core.requestRegistration({ email: 'new@example.test' }, meta);

    expect(env.mailer.sent).toHaveLength(1);
    const mail = sentMail(env);
    expect(mail).toMatchObject({ to: 'new@example.test', subject: CONFIRM_MAIL_SUBJECT });
    const token = tokenFromMail(mail.text);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mail.text).toContain(`${CONFIRM_URL}?token=${token}`);
    expect(addSpy).toHaveBeenCalledWith({
      tokenHash: env.deps.opaque.hash(token),
      email: 'new@example.test',
      expiresAt: NOW + DAY_MS,
      createdAt: NOW,
    });
    expect(JSON.stringify(addSpy.mock.calls)).not.toContain(token);
  });

  it('REQ-012-3: существующий email — тот же ok, письмо «аккаунт уже есть» без token=, новая запись подтверждения не создаётся', async () => {
    const env = createTestEnv();
    await env.store.createUser({
      id: randomUUID(),
      email: 'taken@example.test',
      passwordHash: 'fake-hash:x',
      role: 'supervisor',
      orgId: null,
      createdAt: NOW,
      blockedAt: null,
      tokensValidAfter: null,
    });
    const addSpy = vi.spyOn(env.store, 'addConfirmation');

    const existing = await env.core.requestRegistration({ email: 'taken@example.test' }, meta);
    const fresh = await env.core.requestRegistration({ email: 'new@example.test' }, meta);

    expect(existing).toEqual(fresh);
    expect(env.mailer.sent[0]).toEqual({
      to: 'taken@example.test',
      subject: ALREADY_REGISTERED_MAIL_SUBJECT,
      text: ALREADY_REGISTERED_MAIL_TEXT,
    });
    expect(env.mailer.sent[0]?.text).not.toContain('token=');
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(addSpy.mock.calls[0]?.[0].email).toBe('new@example.test');
  });

  it('REQ-012-4: срок жизни подтверждения — confirmTtlS из настроек, токен в хранилище не сырой', async () => {
    const env = createTestEnv({ confirmTtlS: 1800 });
    const addSpy = vi.spyOn(env.store, 'addConfirmation');
    await env.core.requestRegistration({ email: 'ttl@example.test' }, meta);
    expect(addSpy.mock.calls[0]?.[0].expiresAt).toBe(NOW + 1800 * 1000);
  });

  it.each([
    [600, 1],
    [3600, 1],
    [5400, 2],
    [86_400, 24],
  ])('D-113: срок %i с — в письме «%i ч», округление вверх', async (ttlS, hours) => {
    const env = createTestEnv({ confirmTtlS: ttlS });
    await env.core.requestRegistration({ email: 'round@example.test' }, meta);
    expect(sentMail(env).text).toContain(`Ссылка действует ${hours} ч.`);
  });

  it('AC-012-13: 4 регистрации одного email за час — 4-я rate_limited, письма нет, в логе warn без email; после окна снова разрешено', async () => {
    const env = createTestEnv();
    const email = 'same@example.test';
    for (let i = 0; i < 3; i++) {
      expect((await env.core.requestRegistration({ email }, meta)).ok).toBe(true);
    }
    const fourth = await env.core.requestRegistration({ email }, meta);
    expect(fourth).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    expect(env.mailer.sent).toHaveLength(3);
    expect(env.entries).toContainEqual(
      expect.objectContaining({ level: 'warn', msg: 'rate_limited' }),
    );
    expect(JSON.stringify(env.entries)).not.toContain(email);

    env.clock.advance(HOUR_MS);
    expect((await env.core.requestRegistration({ email }, meta)).ok).toBe(true);
  });

  it('AC-012-13: 11 регистраций с одного IP на разные email — 11-я rate_limited; после сдвига часов снова разрешено', async () => {
    const env = createTestEnv();
    for (let i = 0; i < 10; i++) {
      expect((await env.core.requestRegistration({ email: `u${i}@example.test` }, meta)).ok).toBe(
        true,
      );
    }
    const eleventh = await env.core.requestRegistration({ email: 'u10@example.test' }, meta);
    expect(eleventh).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    expect(env.mailer.sent).toHaveLength(10);

    env.clock.advance(HOUR_MS);
    expect((await env.core.requestRegistration({ email: 'u10@example.test' }, meta)).ok).toBe(true);
  });

  it('AC-012-25: почта падает — новый и существующий email дают одинаковый mail_unavailable, в логе error без адреса', async () => {
    const env = createTestEnv();
    await env.store.createUser({
      id: randomUUID(),
      email: 'taken@example.test',
      passwordHash: 'fake-hash:x',
      role: 'supervisor',
      orgId: null,
      createdAt: NOW,
      blockedAt: null,
      tokensValidAfter: null,
    });
    env.mailer.fail = true;

    const fresh = await env.core.requestRegistration({ email: 'new@example.test' }, meta);
    const existing = await env.core.requestRegistration({ email: 'taken@example.test' }, meta);

    expect(fresh).toMatchObject({ ok: false, error: { code: 'mail_unavailable' } });
    expect(existing).toEqual(fresh);
    expect(
      env.entries.filter((e) => e.level === 'error' && e.msg === 'mail_send_failed'),
    ).toHaveLength(2);
    expect(JSON.stringify(env.entries)).not.toContain('@example.test');
  });

  it('4.2: исключение хранилища — internal_error, текст ошибки наружу не уходит', async () => {
    const env = createTestEnv();
    vi.spyOn(env.store, 'findUserByEmail').mockRejectedValueOnce(new Error('db down'));
    const result = await env.core.requestRegistration({ email: 'boom@example.test' }, meta);
    expect(result).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'internal error' },
    });
    expect(JSON.stringify(result)).not.toContain('db down');
    expect(env.entries).toContainEqual({
      level: 'error',
      msg: 'identity_operation_failed',
      ctx: { operation: 'requestRegistration' },
    });
    const failure = env.entries.find((e) => e.msg === 'identity_operation_failed');
    expect(failure?.ctx).not.toHaveProperty('err');
    expect(JSON.stringify(env.entries)).not.toContain('boom@example.test');
    expect(JSON.stringify(env.entries)).not.toContain('db down');
  });
});
