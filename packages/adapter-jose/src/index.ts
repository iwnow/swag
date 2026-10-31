import { createPrivateKey, createPublicKey } from 'node:crypto';
import { SignJWT, decodeProtectedHeader, jwtVerify } from 'jose';
import { AccessTokenClaims } from '@swag/contracts';
import type { TokenSigner, TokenVerifier } from '@swag/identity-core';

// Спека 012, 4.7: JWT EdDSA (Ed25519) на jose. Ключи — PEM; разбор PEM на node:crypto.

const ALG = 'EdDSA';
const ISSUER = 'swag-identity';
const AUDIENCE = 'swag';

export function createJoseSigner({
  privateKeyPem,
  kid,
}: {
  privateKeyPem: string;
  kid: string;
}): TokenSigner {
  const key = createPrivateKey(privateKeyPem);
  return {
    sign: ({ sub, org, role, iss, aud, iat, exp }) =>
      new SignJWT({ sub, org, role })
        .setProtectedHeader({ alg: ALG, kid, typ: 'JWT' })
        .setIssuer(iss)
        .setAudience(aud)
        .setIssuedAt(iat)
        .setExpirationTime(exp)
        .sign(key),
  };
}

export function createJoseVerifier({
  publicKeyPem,
  kid,
}: {
  publicKeyPem: string;
  kid: string;
}): TokenVerifier {
  const key = createPublicKey(publicKeyPem);
  return {
    async verify(token) {
      try {
        if (decodeProtectedHeader(token).kid !== kid) return null;
        const { payload } = await jwtVerify(token, key, {
          algorithms: [ALG],
          issuer: ISSUER,
          audience: AUDIENCE,
        });
        const parsed = AccessTokenClaims.safeParse(payload);
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
  };
}

export function publicKeyFromPrivate(privateKeyPem: string): string {
  return createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();
}
