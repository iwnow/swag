import { describe, expect, it } from 'vitest';
import { ALREADY_REGISTERED_MAIL_SUBJECT, INVITATION_MAIL_SUBJECT } from '@swag/identity-core';
import {
  EMAIL,
  INVITE_URL,
  PASSWORD,
  REFRESH_TTL_S,
  addMember,
  bearerOf,
  closeHarnessesAfterEach,
  confirmTokenFrom,
  loginAs,
  makeHarness,
  registerAndConfirm,
  setCookieOf,
  type Harness,
} from './support.ts';

closeHarnessesAfterEach();

const SUPERVISOR = { email: 'supervisor@example.com', password: PASSWORD };

const invite = (h: Harness, accessToken: string | undefined, payload: unknown) =>
  h.app.inject({
    method: 'POST',
    url: '/auth/invitations',
    headers: accessToken === undefined ? {} : bearerOf(accessToken),
    payload: payload as object,
  });

describe('POST /auth/invitations', () => {
  it('AC-024-9: admin — 202 с пустым телом и письмо с темой, текстом и ссылкой на IDENTITY_INVITE_URL; занятый email — 202 и письмо «аккаунт уже есть» без токена', async () => {
    const h = await makeHarness();
    const admin = (await registerAndConfirm(h, EMAIL)).json<{ accessToken: string }>();
    await registerAndConfirm(h, 'existing@example.com', 'Другая');

    const fresh = await invite(h, admin.accessToken, {
      email: 'new@example.com',
      role: 'user',
    });
    expect(fresh.statusCode).toBe(202);
    expect(fresh.body).toBe('');
    const sent = h.mailer.sent.at(-1);
    expect(sent?.to).toBe('new@example.com');
    expect(sent?.subject).toBe(INVITATION_MAIL_SUBJECT);
    expect(sent?.text).toContain(`${INVITE_URL}?token=`);

    const existing = await invite(h, admin.accessToken, {
      email: 'existing@example.com',
      role: 'user',
    });
    expect(existing.statusCode).toBe(202);
    const notice = h.mailer.sent.at(-1);
    expect(notice?.to).toBe('existing@example.com');
    expect(notice?.subject).toBe(ALREADY_REGISTERED_MAIL_SUBJECT);
    expect(notice?.text).not.toContain('token=');
  });

  it('AC-024-9: user и supervisor — 403; 21-е приглашение за час — 429', async () => {
    const h = await makeHarness({ supervisor: SUPERVISOR });
    const admin = (await registerAndConfirm(h, EMAIL)).json<{ accessToken: string }>();
    const supervisor = (await loginAs(h, SUPERVISOR.email)).json<{ accessToken: string }>();
    const member = (await addMember(h, admin.accessToken, 'member@example.com')).json<{
      accessToken: string;
    }>().accessToken;

    expect((await invite(h, member, { email: 'x@example.com', role: 'user' })).statusCode).toBe(
      403,
    );
    expect(
      (await invite(h, supervisor.accessToken, { email: 'x@example.com', role: 'user' }))
        .statusCode,
    ).toBe(403);

    // Приглашение участника уже тратит одно из 20 за час.
    for (let i = 0; i < 19; i += 1) {
      const response = await invite(h, admin.accessToken, {
        email: `guest${i}@example.com`,
        role: 'user',
      });
      expect(response.statusCode).toBe(202);
    }
    const limited = await invite(h, admin.accessToken, { email: 'late@example.com', role: 'user' });
    expect(limited.statusCode).toBe(429);
  });
});

describe('POST /auth/invitations/accept', () => {
  it('AC-024-10: принятие — 201 AuthSession с ролью приглашения и организацией администратора, cookie 012, no-store; повтор — 400 invalid_token', async () => {
    const h = await makeHarness();
    const admin = (await registerAndConfirm(h, EMAIL, 'Компания')).json<{
      accessToken: string;
      organization: { id: string };
    }>();
    await invite(h, admin.accessToken, { email: 'guest@example.com', role: 'admin' });
    const token = confirmTokenFrom(h.mailer);

    const accept = () =>
      h.app.inject({
        method: 'POST',
        url: '/auth/invitations/accept',
        payload: { token, password: PASSWORD },
      });
    const response = await accept();
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      user: { email: 'guest@example.com', role: 'admin' },
      organization: { id: admin.organization.id, name: 'Компания' },
    });
    expect(response.headers['cache-control']).toBe('no-store');
    const cookie = setCookieOf(response) ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/auth');
    expect(cookie).toContain(`Max-Age=${REFRESH_TTL_S}`);

    expect((await accept()).json()).toMatchObject({ error: { code: 'invalid_token' } });
    expect((await accept()).statusCode).toBe(400);
  });
});
