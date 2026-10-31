import { describe, expect, it } from 'vitest';
import {
  ACCESS_TTL_S,
  INTERNAL_TOKEN,
  addMember,
  bearerOf,
  closeHarnessesAfterEach,
  makeHarness,
  registerAndConfirm,
  type Harness,
} from './support.ts';

closeHarnessesAfterEach();

const revocations = (h: Harness, authorization?: string) =>
  h.app.inject({
    method: 'GET',
    url: '/internal/token-revocations',
    headers: authorization === undefined ? {} : { authorization },
  });

describe('GET /internal/token-revocations', () => {
  it('AC-024-13: без токена — 401, с неверным — 401, с верным — 200; записи старше IDENTITY_ACCESS_TTL_S не попадают в список', async () => {
    const h = await makeHarness();
    const admin = (await registerAndConfirm(h)).json<{ accessToken: string }>();
    const member = (await addMember(h, admin.accessToken, 'member@example.com')).json<{
      user: { id: string };
    }>();
    await h.app.inject({
      method: 'PATCH',
      url: `/auth/users/${member.user.id}`,
      headers: bearerOf(admin.accessToken),
      payload: { blocked: true },
    });

    const none = await revocations(h);
    expect(none.statusCode).toBe(401);
    expect(none.json()).toEqual({
      error: { code: 'unauthorized', message: expect.any(String) },
    });

    const wrongSameLength = INTERNAL_TOKEN.replace(/.$/, 'X');
    expect((await revocations(h, `Bearer ${wrongSameLength}`)).statusCode).toBe(401);
    expect((await revocations(h, `Bearer ${INTERNAL_TOKEN}x`)).statusCode).toBe(401);
    expect((await revocations(h, bearerOf(admin.accessToken).authorization)).statusCode).toBe(401);

    const ok = await revocations(h, `Bearer ${INTERNAL_TOKEN}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      revocations: [{ userId: member.user.id, validAfter: expect.any(Number), blocked: true }],
    });

    h.clock.shift(ACCESS_TTL_S * 1000 - 1000);
    const edge = await revocations(h, `Bearer ${INTERNAL_TOKEN}`);
    expect(edge.json()).toEqual({
      revocations: [{ userId: member.user.id, validAfter: expect.any(Number), blocked: true }],
    });

    h.clock.shift(2000);
    const later = await revocations(h, `Bearer ${INTERNAL_TOKEN}`);
    expect(later.json()).toEqual({ revocations: [] });
  });
});
