import { createHmac, timingSafeEqual } from 'node:crypto';
import { EgressGrant } from '@swag/contracts';
import { parseKeyBase64 } from './cipher.ts';

// Спека 026, 4.7: грант выхода. Токен: base64url(JSON гранта) + '.' + base64url(HMAC-SHA256(key, первая часть)).
// Порт GrantVerifier объявит egress-proxy-core (T-10); здесь тип объявлен структурно и совпадает с ним.
export interface GrantVerifier {
  verify(token: string): EgressGrant | null;
}

export function createEgressGrants(
  keyBase64: string,
): { issue(grant: EgressGrant): string } & GrantVerifier {
  const key = parseKeyBase64(keyBase64, 'EGRESS_PROXY_KEY');
  const sign = (payload: string): Buffer => createHmac('sha256', key).update(payload).digest();

  return {
    issue(grant) {
      const payload = Buffer.from(JSON.stringify(grant), 'utf8').toString('base64url');
      return `${payload}.${sign(payload).toString('base64url')}`;
    },
    verify(token) {
      try {
        const dot = token.indexOf('.');
        if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return null;
        const payload = token.slice(0, dot);
        const expected = sign(payload);
        const given = Buffer.from(token.slice(dot + 1), 'base64url');
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
        const parsed = EgressGrant.safeParse(
          JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
        );
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
  };
}
