import { describe, expect, it } from 'vitest';
import type { AccessTokenClaims } from '@swag/contracts';
import { jwtKeys } from '../src/start.ts';
import {
  EMAIL,
  KID,
  PASSWORD,
  closeHarnessesAfterEach,
  makeHarness,
  privateKeyBase64,
  registerAndConfirm,
  type Harness,
} from './support.ts';

closeHarnessesAfterEach();

async function session(h: Harness) {
  const confirmed = await registerAndConfirm(h, EMAIL, 'Компания', PASSWORD);
  return confirmed.json<{
    accessToken: string;
    user: { id: string; orgId: string };
    organization: { id: string };
  }>();
}

const me = (h: Harness, authorization?: string) =>
  h.app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: authorization === undefined ? {} : { authorization },
  });

describe('GET /auth/me', () => {
  it('AC-012-18: верный токен даёт 200 AuthMe своего пользователя', async () => {
    const h = await makeHarness();
    const s = await session(h);
    const response = await me(h, `Bearer ${s.accessToken}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      user: { id: s.user.id, email: EMAIL, role: 'admin', orgId: s.organization.id },
      organization: { id: s.organization.id, name: 'Компания' },
    });
  });

  it('AC-012-18: нет токена, испорчена подпись, чужой ключ, просрочен, alg none, чужой aud или iss — каждый раз 401 unauthorized', async () => {
    const h = await makeHarness();
    const s = await session(h);
    const own = jwtKeys({ privateKeyBase64: h.privateKeyBase64, kid: KID }).signer;
    const foreign = jwtKeys({ privateKeyBase64: privateKeyBase64(), kid: KID }).signer;
    const now = Math.floor(Date.now() / 1000);
    const claims: AccessTokenClaims = {
      sub: s.user.id,
      org: s.organization.id,
      role: 'admin',
      iss: 'swag-identity',
      aud: 'swag',
      iat: now,
      exp: now + 900,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const algNone = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${payload}.`;
    // Последний символ base64url подписи содержит два неиспользуемых бита: его замена иногда не меняет подпись.
    const [head = '', body = '', signature = ''] = s.accessToken.split('.');
    const flipped = signature.startsWith('A') ? 'B' : 'A';
    const tampered = [head, body, `${flipped}${signature.slice(1)}`].join('.');

    const cases: (string | undefined)[] = [
      undefined,
      `Bearer ${tampered}`,
      `Bearer ${await foreign.sign(claims)}`,
      `Bearer ${await own.sign({ ...claims, iat: now - 2000, exp: now - 1000 })}`,
      `Bearer ${algNone}`,
      `Bearer ${await own.sign({ ...claims, aud: 'other' } as unknown as AccessTokenClaims)}`,
      `Bearer ${await own.sign({ ...claims, iss: 'other' } as unknown as AccessTokenClaims)}`,
    ];
    for (const authorization of cases) {
      const response = await me(h, authorization);
      expect(response.statusCode).toBe(401);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('unauthorized');
    }
  });
});
