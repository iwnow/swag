import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ALREADY_REGISTERED_MAIL_SUBJECT,
  ALREADY_REGISTERED_MAIL_TEXT,
  RATE_LIMITS,
} from '../src/index.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  INVITE_URL,
  addMember,
  createTestEnv,
  loginAs,
  seedAdmin,
  sentMail,
  tokenFromMail,
  type TestEnv,
} from './fakes.ts';

// Спека 024, T-8: приглашение пользователя и принятие приглашения (ядро).

const meta = { ip: '10.0.0.9' };
const INVITED_EMAIL = 'invited@example.test';
const NEW_PASSWORD = 'new user password 1';

async function inviteAs(env: TestEnv, accessToken: string, email: string, role = 'user') {
  return env.core.inviteUser(accessToken, { email, role });
}

async function lastInviteToken(env: TestEnv, email: string): Promise<string> {
  const index = env.mailer.sent.map((m) => m.to).lastIndexOf(email);
  return tokenFromMail(sentMail(env, index).text);
}

describe('identity-core — приглашение (спека 024, T-8)', () => {
  it('AC-024-9: администратор приглашает — письмо с темой, текстом и ссылкой на IDENTITY_INVITE_URL; лог user_invited', async () => {
    const env = createTestEnv();
    const { userId, orgId } = await seedAdmin(env);
    const admin = await loginAs(env, ADMIN_EMAIL);

    const result = await inviteAs(env, admin.session.accessToken, INVITED_EMAIL);
    expect(result).toEqual({ ok: true, value: undefined });

    const token = await lastInviteToken(env, INVITED_EMAIL);
    const mail = sentMail(env, env.mailer.sent.length - 1);
    expect(mail).toEqual({
      to: INVITED_EMAIL,
      subject: 'Приглашение в Swag',
      text: `Вас пригласили в организацию «Компания» в Swag. Чтобы задать пароль и войти, откройте ссылку: ${INVITE_URL}?token=${token} Ссылка действует 168 ч.`,
    });
    expect(env.entries.filter((e) => e.msg === 'user_invited')).toEqual([
      { level: 'info', msg: 'user_invited', ctx: { userId, orgId } },
    ]);
  });

  it('AC-024-9: существующий email — письмо «аккаунт уже есть» без приглашения, ответ ok', async () => {
    const env = createTestEnv();
    await seedAdmin(env);
    const admin = await loginAs(env, ADMIN_EMAIL);
    const before = env.mailer.sent.length;

    const result = await inviteAs(env, admin.session.accessToken, ADMIN_EMAIL);
    expect(result).toEqual({ ok: true, value: undefined });
    expect(env.mailer.sent.slice(before)).toEqual([
      {
        to: ADMIN_EMAIL,
        subject: ALREADY_REGISTERED_MAIL_SUBJECT,
        text: ALREADY_REGISTERED_MAIL_TEXT,
      },
    ]);
    expect(env.mailer.sent.some((m) => m.text.includes(INVITE_URL))).toBe(false);
  });

  it('AC-024-9: роли user и supervisor — forbidden', async () => {
    const env = createTestEnv();
    const { orgId } = await seedAdmin(env);
    await addMember(env, 'member@example.test', orgId);
    const member = await loginAs(env, 'member@example.test');
    await env.store.createUser({
      id: randomUUID(),
      email: 'supervisor@example.test',
      passwordHash: `fake-hash:${ADMIN_PASSWORD}`,
      role: 'supervisor',
      orgId: null,
      createdAt: 0,
      blockedAt: null,
      tokensValidAfter: null,
    });
    const supervisor = await loginAs(env, 'supervisor@example.test');

    for (const session of [member, supervisor]) {
      const result = await inviteAs(env, session.session.accessToken, INVITED_EMAIL);
      expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    }
    expect(env.mailer.sent).toHaveLength(0);
  });

  it('AC-024-9: 21-е приглашение за час — rate_limited', async () => {
    const env = createTestEnv();
    await seedAdmin(env);
    const admin = await loginAs(env, ADMIN_EMAIL);
    const { limit } = RATE_LIMITS.inviteUser;

    for (let i = 0; i < limit; i++) {
      const result = await inviteAs(env, admin.session.accessToken, `guest${i}@example.test`);
      expect(result.ok).toBe(true);
    }
    const exceeded = await inviteAs(env, admin.session.accessToken, 'guest-over@example.test');
    expect(exceeded).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
  });

  it('AC-024-9: почта недоступна — mail_unavailable', async () => {
    const env = createTestEnv();
    await seedAdmin(env);
    const admin = await loginAs(env, ADMIN_EMAIL);
    env.mailer.fail = true;

    const result = await inviteAs(env, admin.session.accessToken, INVITED_EMAIL);
    expect(result).toMatchObject({ ok: false, error: { code: 'mail_unavailable' } });
  });

  it('AC-024-10: принятие приглашения — сессия с ролью приглашения и организацией администратора', async () => {
    const env = createTestEnv();
    const { orgId } = await seedAdmin(env);
    const admin = await loginAs(env, ADMIN_EMAIL);
    await inviteAs(env, admin.session.accessToken, INVITED_EMAIL, 'admin');
    const token = await lastInviteToken(env, INVITED_EMAIL);

    const result = await env.core.acceptInvitation({ token, password: NEW_PASSWORD }, meta);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { session, refreshToken } = result.value;
    expect(session.user).toMatchObject({ email: INVITED_EMAIL, role: 'admin', orgId });
    expect(session.organization).toMatchObject({ id: orgId, name: 'Компания' });
    expect(refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await env.verifier.verify(session.accessToken)).toMatchObject({
      sub: session.user.id,
      org: orgId,
      role: 'admin',
    });
    const stored = await env.store.findUserByEmail(INVITED_EMAIL);
    expect(stored?.passwordHash).toBe(`fake-hash:${NEW_PASSWORD}`);
  });

  it('AC-024-10: повтор принятия — invalid_token и warn invite_invalid_token', async () => {
    const env = createTestEnv();
    await seedAdmin(env);
    const admin = await loginAs(env, ADMIN_EMAIL);
    await inviteAs(env, admin.session.accessToken, INVITED_EMAIL);
    const token = await lastInviteToken(env, INVITED_EMAIL);
    await env.core.acceptInvitation({ token, password: NEW_PASSWORD }, meta);

    const again = await env.core.acceptInvitation({ token, password: NEW_PASSWORD }, meta);
    expect(again).toMatchObject({ ok: false, error: { code: 'invalid_token' } });
    expect(env.entries.filter((e) => e.msg === 'invite_invalid_token')).toEqual([
      { level: 'warn', msg: 'invite_invalid_token', ctx: undefined },
    ]);
  });

  it('AC-024-10: email, занятый к моменту принятия, — email_taken, приглашение не гасится', async () => {
    const env = createTestEnv();
    const { orgId } = await seedAdmin(env);
    const admin = await loginAs(env, ADMIN_EMAIL);
    await inviteAs(env, admin.session.accessToken, INVITED_EMAIL);
    const token = await lastInviteToken(env, INVITED_EMAIL);
    await addMember(env, INVITED_EMAIL, orgId);

    const result = await env.core.acceptInvitation({ token, password: NEW_PASSWORD }, meta);
    expect(result).toMatchObject({ ok: false, error: { code: 'email_taken' } });
  });
});
