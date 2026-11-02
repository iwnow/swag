import { type EgressGrant, egressMatches } from '@swag/contracts';

// Спека 026, 4.7. Порты ядра: адаптеры собирает оболочка `apps/egress-proxy`.
export interface GrantVerifier {
  verify(token: string): EgressGrant | null;
}

export interface Resolver {
  resolve(hostname: string): Promise<string[]>;
}

export interface Clock {
  now(): Date;
}

export type LogContext = Record<string, unknown>;

export interface Logger {
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
}

export type Decision =
  | { ok: true; address: string; port: number; invocationId: string }
  | {
      ok: false;
      status: 403 | 405 | 407 | 502;
      reason: 'method' | 'auth' | 'expired' | 'host' | 'private_address' | 'resolve_failed';
    };

type Refusal = Extract<Decision, { ok: false }>;

export interface EgressProxyDeps {
  grants: GrantVerifier;
  resolver: Resolver;
  clock: Clock;
  logger: Logger;
  // По умолчанию isPublicAddress. Подмена нужна только тестам оболочки (AC-026-11), см. D-162.
  isPublic?: (address: string) => boolean;
}

export function createEgressProxyCore(deps: EgressProxyDeps): {
  authorize(
    method: string,
    target: string,
    proxyAuthorization: string | undefined,
  ): Promise<Decision>;
} {
  const { grants, resolver, clock, logger } = deps;
  const isPublic = deps.isPublic ?? isPublicAddress;

  const refuse = (status: Refusal['status'], reason: Refusal['reason'], ctx: LogContext = {}) => {
    logger.warn('egress denied', { reason, ...ctx });
    const decision: Refusal = { ok: false, status, reason };
    return decision;
  };

  return {
    // Спека 026, 4.7: шаги 1–5 по порядку; каждый отказ соответствует первому нарушенному шагу.
    async authorize(method, target, proxyAuthorization) {
      if (method !== 'CONNECT') return refuse(405, 'method');

      const grant = grantFromHeader(proxyAuthorization, grants);
      if (!grant) return refuse(407, 'auth');
      const invocationId = grant.invocationId;

      if (grant.expiresAt <= clock.now().getTime()) return refuse(407, 'expired', { invocationId });

      const endpoint = parseTarget(target);
      if (!endpoint || !egressMatches(grant.egress, endpoint.host, endpoint.port)) {
        return refuse(403, 'host', { invocationId, ...endpoint });
      }
      const { host, port } = endpoint;
      const ctx = { invocationId, host, port };

      let addresses: string[];
      try {
        addresses = await resolver.resolve(host);
      } catch {
        return refuse(502, 'resolve_failed', ctx);
      }
      if (addresses.length === 0) return refuse(502, 'resolve_failed', ctx);
      if (!addresses.every((address) => isPublic(address))) {
        return refuse(403, 'private_address', ctx);
      }

      logger.info('egress allowed', ctx);
      return { ok: true, address: addresses[0] as string, port, invocationId };
    },
  };
}

const BASIC_PREFIX = 'Basic ';
const PROXY_USER = 'swag';

// Спека 026, 4.7, шаг 2: `Basic base64("swag:" + token)`; любой сбой разбора — null.
function grantFromHeader(header: string | undefined, grants: GrantVerifier): EgressGrant | null {
  if (header === undefined || !header.startsWith(BASIC_PREFIX)) return null;
  let credentials: string;
  try {
    credentials = atob(header.slice(BASIC_PREFIX.length));
  } catch {
    return null;
  }
  const colon = credentials.indexOf(':');
  if (colon === -1 || credentials.slice(0, colon) !== PROXY_USER) return null;
  return grants.verify(credentials.slice(colon + 1));
}

// Спека 026, 4.7, шаг 4: `host:port` из CONNECT; хост — в нижнем регистре, порт — целое 1…65535.
export function parseTarget(target: string): { host: string; port: number } | null {
  const colon = target.lastIndexOf(':');
  if (colon <= 0) return null;
  const port = parseDecimal(target.slice(colon + 1), 65535);
  if (port === null || port === 0) return null;
  return { host: target.slice(0, colon).toLowerCase(), port };
}

// Спека 026, 4.7: адреса, на которые прокси не соединяется. Адрес, который не разобран, — непубличный.
export function isPublicAddress(address: string): boolean {
  if (address.includes(':')) {
    const groups = parseIPv6(address);
    if (!groups) return false;
    const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
    const compatible = groups.slice(0, 6).every((group) => group === 0);
    if (mapped || compatible) {
      const high = groups[6] ?? 0;
      const low = groups[7] ?? 0;
      const v4 = [high >> 8, high & 0xff, low >> 8, low & 0xff];
      return isPublicIPv4(v4);
    }
    return isPublicIPv6(groups);
  }
  const v4 = parseIPv4(address);
  return v4 !== null && isPublicIPv4(v4);
}

function isPublicIPv4([a = 0, b = 0, c = 0]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // 0/8, 10/8, 127/8, 224/4, 240/4
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64/10
  if (a === 169 && b === 254) return false; // 169.254/16
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16/12
  if (a === 192 && b === 0 && c === 0) return false; // 192.0.0/24
  if (a === 192 && b === 168) return false; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return false; // 198.18/15
  return true;
}

function isPublicIPv6(groups: number[]): boolean {
  const first = groups[0] ?? 0;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return false; // ::1
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10
  if ((first & 0xff00) === 0xff00) return false; // ff00::/8
  return true;
}

// Разбор вручную: без регулярных выражений и без node:net (ядро не использует Node API).
function parseDecimal(text: string, max: number): number | null {
  if (text.length === 0 || text.length > String(max).length) return null;
  let value = 0;
  for (const ch of text) {
    const digit = ch.charCodeAt(0) - 48;
    if (digit < 0 || digit > 9) return null;
    value = value * 10 + digit;
  }
  return value <= max ? value : null;
}

function parseHextet(text: string): number | null {
  if (text.length === 0 || text.length > 4) return null;
  let value = 0;
  for (const ch of text.toLowerCase()) {
    const code = ch.charCodeAt(0);
    const digit = code >= 48 && code <= 57 ? code - 48 : code >= 97 && code <= 102 ? code - 87 : -1;
    if (digit < 0) return null;
    value = value * 16 + digit;
  }
  return value;
}

function parseIPv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => parseDecimal(part, 255));
  return octets.every((octet) => octet !== null) ? (octets as number[]) : null;
}

// Восемь 16-битных групп: `::` раскрывается, хвост `a.b.c.d` переводится в две группы.
function parseIPv6(text: string): number[] | null {
  let source = text;
  const lastColon = source.lastIndexOf(':');
  const tail = source.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    source = `${source.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = source.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' || halves[0] === undefined ? [] : halves[0].split(':');
  const rest = halves.length === 2 && halves[1] !== '' ? (halves[1] as string).split(':') : [];
  let parts: string[];
  if (halves.length === 1) {
    parts = head;
  } else {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    parts = [...head, ...new Array<string>(missing).fill('0'), ...rest];
  }
  if (parts.length !== 8) return null;
  const groups = parts.map((part) => parseHextet(part));
  return groups.every((group) => group !== null) ? (groups as number[]) : null;
}
