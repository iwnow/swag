import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { bearer, captureLog, makeApi, makeStartedAuth, T } from './support.ts';

// Спека 026, 4.6 и AC-026-7: маршруты /secrets по HTTP; значение секрета не попадает ни в ответы, ни в лог api.
const FAKE_VALUE = 'fake-avito-token-1234567890';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function setup() {
  const log = captureLog();
  const { core, billing } = await makeApi({ log: log.logger });
  const auth = await makeStartedAuth({ core });
  const app = await buildApp(
    core,
    billing,
    { logger: { level: 'info', stream: log.stream } },
    auth.app,
  );
  apps.push(app);
  return { app, log };
}

describe('маршруты /secrets по HTTP', () => {
  it('AC-026-7: PUT, GET, DELETE администратора A, права пользователя и администратора B, имя Bad Name; значения нет в ответах и логе', async () => {
    const { app, log } = await setup();
    const bodies: string[] = [];

    const put = await app.inject({
      method: 'PUT',
      url: '/secrets/avito_token',
      headers: bearer(T.adminA),
      payload: { value: FAKE_VALUE },
    });
    bodies.push(put.body);
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ name: 'avito_token', hint: '7890' });
    expect(Object.keys(put.json()).sort()).toEqual(['hint', 'name', 'updatedAt']);

    const listed = await app.inject({ method: 'GET', url: '/secrets', headers: bearer(T.adminA) });
    bodies.push(listed.body);
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ items: Array<{ name: string }> }>().items.map((i) => i.name)).toEqual([
      'avito_token',
    ]);

    const deleted = await app.inject({
      method: 'DELETE',
      url: '/secrets/avito_token',
      headers: bearer(T.adminA),
    });
    bodies.push(deleted.body);
    expect(deleted.statusCode).toBe(204);

    const again = await app.inject({
      method: 'DELETE',
      url: '/secrets/avito_token',
      headers: bearer(T.adminA),
    });
    bodies.push(again.body);
    expect(again.statusCode).toBe(404);
    expect(again.json()).toMatchObject({ error: { code: 'not_found' } });

    const user = await app.inject({ method: 'GET', url: '/secrets', headers: bearer(T.u1) });
    bodies.push(user.body);
    expect(user.statusCode).toBe(403);
    expect(user.json()).toMatchObject({ error: { code: 'forbidden' } });

    const foreign = await app.inject({ method: 'GET', url: '/secrets', headers: bearer(T.adminB) });
    bodies.push(foreign.body);
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json()).toEqual({ items: [] });

    const put2 = await app.inject({
      method: 'PUT',
      url: '/secrets/avito_token',
      headers: bearer(T.adminA),
      payload: { value: FAKE_VALUE },
    });
    bodies.push(put2.body);
    const badName = await app.inject({
      method: 'PUT',
      url: '/secrets/Bad%20Name',
      headers: bearer(T.adminA),
      payload: { value: FAKE_VALUE },
    });
    bodies.push(badName.body);
    expect(badName.statusCode).toBe(400);
    expect(badName.json()).toMatchObject({ error: { code: 'invalid_request' } });

    // Проверка «не встречается» должна опираться на реальные записи лога, иначе она пуста.
    expect(log.entries.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body).not.toContain(FAKE_VALUE);
    expect(log.text()).not.toContain(FAKE_VALUE);
  });
});
