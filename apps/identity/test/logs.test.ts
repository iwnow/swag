import { describe, expect, it } from 'vitest';
import {
  EMAIL,
  PASSWORD,
  closeHarnessesAfterEach,
  confirmTokenFrom,
  logRecords,
  makeHarness,
  refreshValueOf,
  setCookieOf,
  telemetryText,
} from './support.ts';

closeHarnessesAfterEach();

const ORG = 'Компания';

describe('лог и спаны оболочки', () => {
  it('AC-012-22: полный сценарий — в логах и спанах нет email, пароля, хэша, токенов', async () => {
    const h = await makeHarness();
    const secrets: (string | undefined)[] = [EMAIL, PASSWORD];

    await h.app.inject({ method: 'POST', url: '/auth/registrations', payload: { email: EMAIL } });
    const confirmToken = confirmTokenFrom(h.mailer);
    secrets.push(confirmToken);

    const confirm = await h.app.inject({
      method: 'POST',
      url: '/auth/registrations/confirm',
      payload: { token: confirmToken, password: PASSWORD, organizationName: ORG },
    });
    const user = confirm.json<{ user: { id: string }; accessToken: string }>();
    secrets.push(user.accessToken, refreshValueOf(confirm));
    secrets.push((await h.store.findUserByEmail(EMAIL))?.passwordHash);

    const login = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    });
    const signedIn = login.json<{ accessToken: string }>();
    secrets.push(signedIn.accessToken, refreshValueOf(login));

    await h.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${signedIn.accessToken}` },
    });
    const refreshed = await h.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: `swag_refresh=${refreshValueOf(login)}` },
    });
    secrets.push(refreshed.json<{ accessToken: string }>().accessToken, refreshValueOf(refreshed));
    await h.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: `swag_refresh=${refreshValueOf(refreshed)}` },
    });

    const wrong = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: 'wrong-password-value' },
    });
    expect(wrong.statusCode).toBe(401);

    const text = telemetryText(h);
    const leaks = secrets.filter(
      (secret): secret is string => secret !== undefined && text.includes(secret),
    );
    expect(leaks).toEqual([]);

    const failed = logRecords(h).find((record) => record['msg'] === 'login_failed');
    expect(failed).toMatchObject({ level: 'warn', userId: user.user.id });
  });

  it('AC-012-22: authorization и cookie запросов не попадают в лог', async () => {
    const h = await makeHarness();
    await h.app.inject({ method: 'POST', url: '/auth/registrations', payload: { email: EMAIL } });
    const confirm = await h.app.inject({
      method: 'POST',
      url: '/auth/registrations/confirm',
      payload: { token: confirmTokenFrom(h.mailer), password: PASSWORD, organizationName: ORG },
    });
    const access = confirm.json<{ accessToken: string }>().accessToken;
    const refresh = refreshValueOf(confirm) ?? '';

    await h.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${access}` },
    });
    await h.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: `swag_refresh=${refresh}` },
    });

    expect(logRecords(h).some((record) => record['msg'] === 'incoming request')).toBe(true);
    const text = telemetryText(h);
    expect(text).not.toContain(access);
    expect(text).not.toContain(refresh);
    expect(text).not.toContain('authorization');
    expect(text).not.toContain('swag_refresh');
  });

  it('AC-012-22: неверный JSON с паролем не попадает ни в лог, ни в ответ', async () => {
    const h = await makeHarness();
    const secret = 'Trailing-Secret-9';
    const response = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: `{"email":"${EMAIL}","password":"${secret}"`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(secret);
    expect(telemetryText(h)).not.toContain(secret);
    expect(setCookieOf(response)).toBeUndefined();
  });
});
