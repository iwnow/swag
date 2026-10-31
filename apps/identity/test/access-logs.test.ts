import { describe, expect, it } from 'vitest';
import {
  EMAIL,
  INTERNAL_TOKEN,
  PASSWORD,
  addMember,
  bearerOf,
  closeHarnessesAfterEach,
  confirmTokenFrom,
  loginAs,
  makeHarness,
  refreshValueOf,
  registerAndConfirm,
  telemetryText,
} from './support.ts';

closeHarnessesAfterEach();

const MEMBER = 'member@example.com';

describe('логи и спаны управления доступом', () => {
  it('AC-024-25: приглашение, вход, блокировка, отзыв и внутренний список — в логах и спанах нет токенов, токена приглашения, паролей, внутреннего токена и email', async () => {
    const h = await makeHarness();
    const secrets: (string | undefined)[] = [EMAIL, MEMBER, PASSWORD, INTERNAL_TOKEN];

    const admin = (await registerAndConfirm(h)).json<{
      accessToken: string;
      user: { id: string };
    }>();
    secrets.push(admin.accessToken, confirmTokenFrom(h.mailer));

    const member = await addMember(h, admin.accessToken, MEMBER);
    secrets.push(confirmTokenFrom(h.mailer), refreshValueOf(member));
    const memberId = member.json<{ user: { id: string } }>().user.id;

    const login = await loginAs(h, MEMBER);
    secrets.push(login.json<{ accessToken: string }>().accessToken, refreshValueOf(login));
    const refreshCookie = refreshValueOf(login);

    await h.app.inject({
      method: 'PATCH',
      url: `/auth/users/${memberId}`,
      headers: bearerOf(admin.accessToken),
      payload: { blocked: true },
    });
    await loginAs(h, MEMBER);
    await h.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: `swag_refresh=${refreshCookie}` },
    });
    await h.app.inject({
      method: 'GET',
      url: '/auth/users',
      headers: bearerOf(admin.accessToken),
    });
    await h.app.inject({
      method: 'GET',
      url: '/internal/token-revocations',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    });

    const text = telemetryText(h);
    expect(text).toContain('login_blocked');
    for (const secret of secrets) {
      if (secret !== undefined) expect(text).not.toContain(secret);
    }
  });
});
