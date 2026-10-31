import { describe, expect, it } from 'vitest';
import { ALREADY_REGISTERED_MAIL_SUBJECT, CONFIRM_MAIL_SUBJECT } from '@swag/identity-core';
import { createJoseVerifier, publicKeyFromPrivate } from '@swag/adapter-jose';
import { createArgon2Hasher } from '@swag/adapter-crypto';
import {
  EMAIL,
  PASSWORD,
  closeHarnessesAfterEach,
  decodeJwt,
  logRecords,
  makeHarness,
  refreshValueOf,
  registerAndConfirm,
} from './support.ts';

closeHarnessesAfterEach();

describe('регистрация по HTTP', () => {
  it('AC-012-5: существующий и новый email дают одинаковый 202, для существующего письмо без ссылки', async () => {
    const h = await makeHarness();
    await registerAndConfirm(h, EMAIL);
    const confirmsBefore = h.mailer.sent.filter((m) => m.subject === CONFIRM_MAIL_SUBJECT).length;

    const existing = await h.app.inject({
      method: 'POST',
      url: '/auth/registrations',
      payload: { email: `  ${EMAIL.toUpperCase()} ` },
    });
    const fresh = await h.app.inject({
      method: 'POST',
      url: '/auth/registrations',
      payload: { email: 'new@example.com' },
    });

    expect(existing.statusCode).toBe(202);
    expect(fresh.statusCode).toBe(202);
    expect(existing.body).toBe(fresh.body);
    expect(existing.body).toBe('');

    const alreadyMail = h.mailer.sent.find((m) => m.subject === ALREADY_REGISTERED_MAIL_SUBJECT);
    expect(alreadyMail?.to).toBe(EMAIL);
    expect(alreadyMail?.text).not.toContain('token=');
    const confirmsAfter = h.mailer.sent.filter((m) => m.subject === CONFIRM_MAIL_SUBJECT).length;
    expect(confirmsAfter).toBe(confirmsBefore + 1);
  });

  it('AC-012-6: подтверждение даёт 201 AuthSession, cookie и проверяемый токен доступа', async () => {
    const h = await makeHarness();
    const response = await registerAndConfirm(h, EMAIL, '  Ромашка  ');

    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<{
      accessToken: string;
      expiresIn: number;
      user: { id: string; email: string; role: string; orgId: string };
      organization: { id: string; name: string };
    }>();
    expect(body.user.role).toBe('admin');
    expect(body.user.email).toBe(EMAIL);
    expect(body.organization.name).toBe('Ромашка');
    expect(body.user.orgId).toBe(body.organization.id);
    expect(body.expiresIn).toBe(900);
    expect(refreshValueOf(response)).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const verifier = createJoseVerifier({
      publicKeyPem: publicKeyFromPrivate(
        Buffer.from(h.privateKeyBase64, 'base64').toString('utf8'),
      ),
      kid: 'test-1',
    });
    const claims = await verifier.verify(body.accessToken);
    expect(claims).toMatchObject({ sub: body.user.id, org: body.organization.id, role: 'admin' });

    const stored = await h.store.findUserByEmail(EMAIL);
    expect(stored?.passwordHash).not.toBe(PASSWORD);
    expect(stored?.passwordHash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    expect(await createArgon2Hasher().verify(stored?.passwordHash ?? '', PASSWORD)).toBe(true);
    expect(decodeJwt(body.accessToken).header).toMatchObject({ alg: 'EdDSA', kid: 'test-1' });
  });

  it('AC-012-25: почта недоступна — оба ответа 503 с одинаковым телом и лог error без адреса', async () => {
    const h = await makeHarness();
    await registerAndConfirm(h, EMAIL);
    h.mailer.fail = true;

    const existing = await h.app.inject({
      method: 'POST',
      url: '/auth/registrations',
      payload: { email: EMAIL },
    });
    const fresh = await h.app.inject({
      method: 'POST',
      url: '/auth/registrations',
      payload: { email: 'new@example.com' },
    });

    expect(existing.statusCode).toBe(503);
    expect(fresh.statusCode).toBe(503);
    expect(existing.json()).toEqual(fresh.json());
    expect(existing.json()).toEqual({
      error: { code: 'mail_unavailable', message: 'mail unavailable' },
    });

    const errors = logRecords(h).filter((r) => r['msg'] === 'mail_send_failed');
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.every((r) => r['level'] === 'error')).toBe(true);
    expect(h.lines.join('\n')).not.toContain('new@example.com');
    expect(h.lines.join('\n')).not.toContain(EMAIL);
  });
});
