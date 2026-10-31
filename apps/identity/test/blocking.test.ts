import { describe, expect, it } from 'vitest';
import {
  INTERNAL_TOKEN,
  PASSWORD,
  addMember,
  bearerOf,
  closeHarnessesAfterEach,
  loginAs,
  logRecords,
  makeHarness,
  refreshValueOf,
  registerAndConfirm,
  type Harness,
} from './support.ts';

closeHarnessesAfterEach();

interface Session {
  accessToken: string;
  user: { id: string };
}

const patch = (h: Harness, accessToken: string, id: string, payload: object) =>
  h.app.inject({
    method: 'PATCH',
    url: `/auth/users/${id}`,
    headers: bearerOf(accessToken),
    payload,
  });

const refresh = (h: Harness, cookie: string | undefined) =>
  h.app.inject({
    method: 'POST',
    url: '/auth/refresh',
    headers: cookie === undefined ? {} : { cookie: `swag_refresh=${cookie}` },
  });

// Администратор организации и его пользователь, уже вошедший в систему.
async function setup(h: Harness) {
  const admin = (await registerAndConfirm(h)).json<Session>();
  const member = (await addMember(h, admin.accessToken, 'member@example.com')).json<Session>();
  const memberLogin = await loginAs(h, 'member@example.com');
  return { admin, member, memberLogin };
}

describe('блокировка пользователя', () => {
  it('AC-024-6: заблокированный с верным паролем — 403 user_blocked и warn login_blocked; с неверным — 401 invalid_credentials; после разблокировки вход проходит', async () => {
    const h = await makeHarness();
    const { admin, member } = await setup(h);

    expect((await patch(h, admin.accessToken, member.user.id, { blocked: true })).statusCode).toBe(
      200,
    );

    const blocked = await loginAs(h, 'member@example.com');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ error: { code: 'user_blocked' } });
    expect(logRecords(h).some((r) => r['msg'] === 'login_blocked')).toBe(true);

    const wrong = await loginAs(h, 'member@example.com', 'wrong-password-123');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ error: { code: 'invalid_credentials' } });

    await patch(h, admin.accessToken, member.user.id, { blocked: false });
    expect((await loginAs(h, 'member@example.com', PASSWORD)).statusCode).toBe(200);
  });
});

describe('отзыв токенов при блокировке и смене роли', () => {
  it('AC-024-7: блокировка — токен доступа на /auth/me и маршрутах 4.7 даёт 401, refresh cookie — 401 invalid_refresh_token', async () => {
    const h = await makeHarness();
    const { admin, member, memberLogin } = await setup(h);
    const memberToken = memberLogin.json<Session>().accessToken;
    const cookie = refreshValueOf(memberLogin);
    const memberId = member.user.id;

    expect((await patch(h, admin.accessToken, member.user.id, { blocked: true })).statusCode).toBe(
      200,
    );

    const me = await h.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearerOf(memberToken),
    });
    expect(me.statusCode).toBe(401);
    const users = await h.app.inject({
      method: 'GET',
      url: '/auth/users',
      headers: bearerOf(memberToken),
    });
    expect(users.statusCode).toBe(401);
    const organizations = await h.app.inject({
      method: 'GET',
      url: '/auth/organizations',
      headers: bearerOf(memberToken),
    });
    expect(organizations.statusCode).toBe(401);

    const stale = await refresh(h, cookie);
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toMatchObject({ error: { code: 'invalid_refresh_token' } });

    const update = await h.app.inject({
      method: 'PATCH',
      url: `/auth/users/${memberId}`,
      headers: bearerOf(memberToken),
      payload: { blocked: false },
    });
    expect(update.statusCode).toBe(401);
    const invite = await h.app.inject({
      method: 'POST',
      url: '/auth/invitations',
      headers: bearerOf(memberToken),
      payload: { email: 'guest@example.com', role: 'user' },
    });
    expect(invite.statusCode).toBe(401);
  });

  it('AC-024-7: смена роли — старый токен и refresh не работают; новый вход даёт токен с новой ролью, и он принимается', async () => {
    const h = await makeHarness();
    const { admin, member, memberLogin } = await setup(h);
    const oldToken = memberLogin.json<Session>().accessToken;
    const oldCookie = refreshValueOf(memberLogin);

    expect((await patch(h, admin.accessToken, member.user.id, { role: 'admin' })).statusCode).toBe(
      200,
    );
    const revoked = await h.app.inject({
      method: 'GET',
      url: '/internal/token-revocations',
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    });
    expect(revoked.json<{ revocations: object[] }>().revocations).toContainEqual(
      expect.objectContaining({ userId: member.user.id, blocked: false }),
    );

    const stale = await h.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: bearerOf(oldToken),
    });
    expect(stale.statusCode).toBe(401);
    expect((await refresh(h, oldCookie)).json()).toMatchObject({
      error: { code: 'invalid_refresh_token' },
    });

    // Токен выдан в ту же секунду, что и отзыв: `iat * 1000 < validAfter` — сдвигаем часы за секунду.
    h.clock.shift(1000);
    const relogin = await loginAs(h, 'member@example.com');
    expect(relogin.statusCode).toBe(200);
    const fresh = relogin.json<Session & { user: { role: string } }>();
    expect(fresh.user.role).toBe('admin');
    const listed = await h.app.inject({
      method: 'GET',
      url: '/auth/users',
      headers: bearerOf(fresh.accessToken),
    });
    expect(listed.statusCode).toBe(200);
  });
});
