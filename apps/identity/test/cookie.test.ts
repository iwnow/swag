import { describe, expect, it } from 'vitest';
import {
  EMAIL,
  PASSWORD,
  REFRESH_TTL_S,
  closeHarnessesAfterEach,
  makeHarness,
  refreshValueOf,
  registerAndConfirm,
  setCookieOf,
} from './support.ts';

closeHarnessesAfterEach();

const login = (app: {
  inject: (options: object) => Promise<{ headers: Record<string, unknown> }>;
}) =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { email: EMAIL, password: PASSWORD } });

describe('cookie токена обновления', () => {
  it.each([false, true])(
    'AC-012-17: атрибуты cookie по 4.5 (cookieSecure=%s), Secure только при true, no-store на входе',
    async (cookieSecure) => {
      const h = await makeHarness({ cookieSecure });
      await registerAndConfirm(h);
      const response = await login(h.app);

      const cookie = setCookieOf(response) ?? '';
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Path=/auth');
      expect(cookie).toContain(`Max-Age=${REFRESH_TTL_S}`);
      expect(cookie.includes('Secure')).toBe(cookieSecure);
      expect(response.headers['cache-control']).toBe('no-store');
    },
  );
});

describe('выход и истечение сессии', () => {
  it('AC-012-16: выход даёт 204 и стирает cookie, старый токен и истёкшая сессия дают 401', async () => {
    const h = await makeHarness();
    const confirmed = await registerAndConfirm(h);
    const refresh = refreshValueOf(confirmed) ?? '';

    const logout = await h.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: `swag_refresh=${refresh}` },
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.body).toBe('');
    expect(setCookieOf(logout)).toContain('Max-Age=0');

    const afterLogout = await h.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: `swag_refresh=${refresh}` },
    });
    expect(afterLogout.statusCode).toBe(401);
    expect(afterLogout.json()).toEqual({
      error: { code: 'invalid_refresh_token', message: 'invalid refresh token' },
    });
    expect(setCookieOf(afterLogout)).toContain('Max-Age=0');

    const active = await login(h.app);
    const expiredRefresh = refreshValueOf(active) ?? '';
    h.clock.shift((REFRESH_TTL_S + 1) * 1000);
    const expired = await h.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: `swag_refresh=${expiredRefresh}` },
    });
    expect(expired.statusCode).toBe(401);
  });
});
