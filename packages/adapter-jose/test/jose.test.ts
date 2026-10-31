import { createPrivateKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { SignJWT, decodeJwt, decodeProtectedHeader } from 'jose';
import { describe, expect, it } from 'vitest';
import type { AccessTokenClaims } from '@swag/contracts';
import { createJoseSigner, createJoseVerifier, publicKeyFromPrivate } from '../src/index.ts';

// Спека 012, 4.7, REQ-012-10, REQ-012-14, AC-012-19. Ключи создаются в тесте, фикстур с ключами нет.

const KID = 'dev-1';
const FOREIGN_KID = 'other-1';

const pair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
};

const own = pair();
const foreign = pair();

const signer = createJoseSigner({ privateKeyPem: own.privateKeyPem, kid: KID });
const verifier = createJoseVerifier({ publicKeyPem: own.publicKeyPem, kid: KID });

const claimsFor = (overrides: Partial<AccessTokenClaims> = {}): AccessTokenClaims => {
  const now = Math.floor(Date.now() / 1000);
  return {
    sub: randomUUID(),
    org: randomUUID(),
    role: 'admin',
    iss: 'swag-identity',
    aud: 'swag',
    iat: now,
    exp: now + 900,
    ...overrides,
  };
};

// Токен, подписанный напрямую jose: позволяет подделать iss, aud и срок мимо сигнера.
const signRaw = (
  payload: Record<string, unknown>,
  { privateKeyPem = own.privateKeyPem, kid = KID } = {},
) =>
  new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(createPrivateKey(privateKeyPem));

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('createJoseSigner и createJoseVerifier', () => {
  it('REQ-012-10: токен — JWT с alg EdDSA, kid и typ JWT в заголовке; iss, aud и срок в payload', async () => {
    const claims = claimsFor();
    const token = await signer.sign(claims);
    expect(decodeProtectedHeader(token)).toMatchObject({ alg: 'EdDSA', kid: KID, typ: 'JWT' });
    const payload = decodeJwt(token);
    expect(payload).toMatchObject({ iss: 'swag-identity', aud: 'swag' });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(claims.exp - claims.iat);
  });

  it('AC-012-19: свой токен проверяется и отдаёт утверждения', async () => {
    const claims = claimsFor();
    const token = await signer.sign(claims);
    expect(await verifier.verify(token)).toEqual(claims);
  });

  it('AC-012-19: токен с чужим kid — null', async () => {
    const foreignKid = createJoseSigner({ privateKeyPem: own.privateKeyPem, kid: FOREIGN_KID });
    expect(await verifier.verify(await foreignKid.sign(claimsFor()))).toBeNull();
  });

  it('AC-012-19: токен с изменённым утверждением — null', async () => {
    const token = await signer.sign(claimsFor({ role: 'user' }));
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const tampered = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    tampered['role'] = 'supervisor';
    expect(await verifier.verify(`${header}.${base64url(tampered)}.${signature}`)).toBeNull();
  });

  it('AC-012-19: утверждения не проходят AccessTokenClaims (role: root) — null', async () => {
    const token = await signRaw({
      sub: randomUUID(),
      org: randomUUID(),
      role: 'root',
      iss: 'swag-identity',
      aud: 'swag',
    });
    expect(await verifier.verify(token)).toBeNull();
  });

  it('REQ-012-14: токен, подписанный чужим ключом с тем же kid, — null', async () => {
    const token = await signRaw(
      { sub: randomUUID(), org: randomUUID(), role: 'admin', iss: 'swag-identity', aud: 'swag' },
      { privateKeyPem: foreign.privateKeyPem },
    );
    expect(await verifier.verify(token)).toBeNull();
  });

  it('REQ-012-14: неверные iss или aud — null', async () => {
    const base = { sub: randomUUID(), org: randomUUID(), role: 'admin' };
    expect(
      await verifier.verify(await signRaw({ ...base, iss: 'someone-else', aud: 'swag' })),
    ).toBeNull();
    expect(
      await verifier.verify(await signRaw({ ...base, iss: 'swag-identity', aud: 'other-app' })),
    ).toBeNull();
  });

  it('REQ-012-14: просроченный токен — null', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect(
      await verifier.verify(await signer.sign(claimsFor({ iat: past - 900, exp: past }))),
    ).toBeNull();
  });

  it('REQ-012-14: alg none без подписи — null', async () => {
    const unsigned = `${base64url({ alg: 'none', kid: KID })}.${base64url(claimsFor())}.`;
    expect(await verifier.verify(unsigned)).toBeNull();
  });

  it('REQ-012-14: мусор — null без исключения', async () => {
    expect(await verifier.verify('не-jwt')).toBeNull();
    expect(await verifier.verify('')).toBeNull();
    expect(await verifier.verify('a.b.c')).toBeNull();
  });
});

describe('publicKeyFromPrivate', () => {
  it('REQ-012-10: открытый ключ из закрытого совпадает с парой и проверяет подпись', async () => {
    expect(publicKeyFromPrivate(own.privateKeyPem)).toBe(own.publicKeyPem);
    const token = await signer.sign(claimsFor());
    const derived = createJoseVerifier({
      publicKeyPem: publicKeyFromPrivate(own.privateKeyPem),
      kid: KID,
    });
    expect(await derived.verify(token)).not.toBeNull();
  });
});
