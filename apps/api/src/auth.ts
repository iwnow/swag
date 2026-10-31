import { actorFromClaims, type AccessTokenClaims, type Actor } from '@swag/contracts';
import type { RevocationSync } from './revocations.ts';

// Спека 024, 4.5 и 4.6: проверка токена доступа в оболочке api. Решений о правах здесь нет — только вход в ядро.
export const UNAUTHORIZED_CLOSE_CODE = 4401;

export type AuthFailure = 'missing' | 'invalid' | 'revoked' | 'unavailable';
export type AuthOutcome = { ok: true; actor: Actor } | { ok: false; reason: AuthFailure };
export type Authenticator = (token: string | null) => Promise<AuthOutcome>;

export interface TokenVerifier {
  verify(token: string): Promise<AccessTokenClaims | null>;
}

export function createAuthenticator(deps: {
  verifier: TokenVerifier;
  revocations: Pick<RevocationSync, 'check'>;
}): Authenticator {
  return async (token) => {
    if (token === null || token === '') return { ok: false, reason: 'missing' };
    const claims = await deps.verifier.verify(token).catch(() => null);
    if (claims === null) return { ok: false, reason: 'invalid' };
    const status = deps.revocations.check(claims);
    if (status === 'unavailable') return { ok: false, reason: 'unavailable' };
    if (status === 'revoked') return { ok: false, reason: 'revoked' };
    return { ok: true, actor: actorFromClaims(claims) };
  };
}

export function bearerToken(header: string | undefined): string | null {
  return /^Bearer (.+)$/.exec(header ?? '')?.[1] ?? null;
}

// Токен WebSocket — в подпротоколе swag.bearer.<jwt> (4.6), заголовок Authorization браузер не задаёт.
const BEARER_PROTOCOL = 'swag.bearer.';

export function protocolToken(header: string | undefined): string | null {
  const entry = header
    ?.split(',')
    .map((protocol) => protocol.trim())
    .find((protocol) => protocol.startsWith(BEARER_PROTOCOL));
  return entry === undefined ? null : entry.slice(BEARER_PROTOCOL.length);
}
