import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  INTERNAL_TOKEN,
  bearerOf,
  closeHarnessesAfterEach,
  makeHarness,
  registerAndConfirm,
} from './support.ts';

closeHarnessesAfterEach();

// Спека 013, 4.8: внутренний маршрут «организация существует».
describe('GET /internal/organizations/:orgId', () => {
  it('AC-013-20: верный токен — 204 для существующей, 404 для неизвестной и не UUID; без токена или с неверным — 401', async () => {
    const h = await makeHarness();
    const admin = (await registerAndConfirm(h)).json<{ accessToken: string }>();
    const me = (
      await h.app.inject({ method: 'GET', url: '/auth/me', headers: bearerOf(admin.accessToken) })
    ).json<{ organization: { id: string } }>();
    const url = (orgId: string) => `/internal/organizations/${orgId}`;
    const check = (orgId: string, authorization?: string) =>
      h.app.inject({
        method: 'GET',
        url: url(orgId),
        headers: authorization === undefined ? {} : { authorization },
      });
    const good = `Bearer ${INTERNAL_TOKEN}`;

    const found = await check(me.organization.id, good);
    expect(found.statusCode).toBe(204);
    expect(found.body).toBe('');

    const missing = await check(randomUUID(), good);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({
      error: { code: 'not_found', message: 'Organization not found' },
    });

    expect((await check('не-uuid', good)).statusCode).toBe(404);

    const none = await check(me.organization.id);
    expect(none.statusCode).toBe(401);
    expect(none.json()).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });

    const wrongSameLength = INTERNAL_TOKEN.replace(/.$/, 'X');
    expect((await check(me.organization.id, `Bearer ${wrongSameLength}`)).statusCode).toBe(401);
    expect((await check(me.organization.id, `Bearer ${INTERNAL_TOKEN}x`)).statusCode).toBe(401);
  });
});
