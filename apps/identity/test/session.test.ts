import { describe, expect, it } from 'vitest';
import {
  ACCESS_TTL_S,
  EMAIL,
  KID,
  PASSWORD,
  closeHarnessesAfterEach,
  decodeJwt,
  makeHarness,
  refreshValueOf,
  registerAndConfirm,
} from './support.ts';

closeHarnessesAfterEach();

describe('вход по HTTP', () => {
  it('AC-012-11: вход отдаёт 200, cookie и JWT с утверждениями пользователя и заголовками EdDSA и kid', async () => {
    const h = await makeHarness();
    const registered = await registerAndConfirm(h);
    const user = registered.json<{ user: { id: string }; organization: { id: string } }>();

    const response = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(refreshValueOf(response)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const body = response.json<{ accessToken: string; expiresIn: number }>();
    expect(body.expiresIn).toBe(ACCESS_TTL_S);

    const { header, payload } = decodeJwt(body.accessToken);
    expect(header).toMatchObject({ alg: 'EdDSA', kid: KID });
    expect(payload).toMatchObject({
      sub: user.user.id,
      org: user.organization.id,
      role: 'admin',
      iss: 'swag-identity',
      aud: 'swag',
    });
    expect((payload['exp'] as number) - (payload['iat'] as number)).toBe(ACCESS_TTL_S);
  });
});

describe('ответ входа супервизора', () => {
  it('AC-012-21: супервизор входит с org = null в утверждениях и organization = null в теле', async () => {
    const h = await makeHarness({ supervisor: { email: 'root@example.com', password: PASSWORD } });
    const response = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'root@example.com', password: PASSWORD },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      accessToken: string;
      user: { role: string; orgId: string | null };
      organization: unknown;
    }>();
    expect(body.user).toMatchObject({ role: 'supervisor', orgId: null });
    expect(body.organization).toBeNull();
    expect(decodeJwt(body.accessToken).payload).toMatchObject({ role: 'supervisor', org: null });
  });
});
