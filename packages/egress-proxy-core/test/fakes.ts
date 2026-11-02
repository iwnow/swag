import type { EgressGrant } from '@swag/contracts';
import type { Clock, GrantVerifier, LogContext, Logger, Resolver } from '../src/index.ts';

export const NOW = new Date('2026-11-02T10:00:00Z');
export const INVOCATION_ID = '0f8fad5b-d9cb-469f-a165-8c45a5d2c001';
export const TOKEN = 'token-payload.signature';
export const AUTH_HEADER = `Basic ${Buffer.from(`swag:${TOKEN}`).toString('base64')}`;

export const grant = (overrides: Partial<EgressGrant> = {}): EgressGrant => ({
  invocationId: INVOCATION_ID,
  egress: ['allowed.test', '*.cdn.test:8443'],
  expiresAt: NOW.getTime() + 60_000,
  ...overrides,
});

// Верифицирует только TOKEN; возвращает грант, заданный через grantValue.
export function fakeGrants(grantValue: EgressGrant | null = grant()): GrantVerifier & {
  seen: string[];
} {
  const seen: string[] = [];
  return {
    seen,
    verify(token) {
      seen.push(token);
      return token === TOKEN ? grantValue : null;
    },
  };
}

export const fakeClock = (at: Date = NOW): Clock => ({ now: () => at });

export function fakeResolver(table: Record<string, string[] | Error>): Resolver & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    async resolve(hostname) {
      calls.push(hostname);
      const entry = table[hostname];
      if (entry === undefined) throw new Error(`ENOTFOUND ${hostname}`);
      if (entry instanceof Error) throw entry;
      return entry;
    },
  };
}

export interface LogLine {
  level: 'info' | 'warn';
  msg: string;
  ctx: LogContext;
}

export function fakeLogger(): Logger & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  return {
    lines,
    info: (msg, ctx = {}) => lines.push({ level: 'info', msg, ctx }),
    warn: (msg, ctx = {}) => lines.push({ level: 'warn', msg, ctx }),
  };
}
