import { describe, expect, it } from 'vitest';
import type { AccessTokenClaims, TokenRevocationList } from '@swag/contracts';
import { createRevocationSync, type RevocationSyncDeps } from '../src/revocations.ts';

// Спека 024, T-12: синхронизация отзывов в оболочке api (4.12). Часы и таймеры — свои фейки в памяти.

type Entry = { level: string; msg: string; ctx?: Record<string, unknown> };

function makeEnv() {
  let clock = 1_000_000;
  const entries: Entry[] = [];
  const blockedCalls: string[] = [];
  let list: TokenRevocationList = { revocations: [] };
  let failFetch = false;
  let failOnBlocked = false;
  let intervalHandler: (() => void) | null = null;
  let intervalCleared = 0;
  let intervalSet = 0;

  const log = {
    debug: () => undefined,
    info: () => undefined,
    warn: (msg: string, ctx?: Record<string, unknown>) =>
      entries.push(ctx === undefined ? { level: 'warn', msg } : { level: 'warn', msg, ctx }),
    error: () => undefined,
  };

  const deps: RevocationSyncDeps = {
    fetchRevocations: async () => {
      if (failFetch) throw new Error('connect ECONNREFUSED identity-secret-host');
      return list;
    },
    onBlocked: async (userId) => {
      blockedCalls.push(userId);
      if (failOnBlocked) throw new Error('stop failed');
    },
    pollMs: 5000,
    maxStaleMs: 30000,
    now: () => clock,
    timers: {
      setInterval: (handler) => {
        intervalSet += 1;
        intervalHandler = handler;
        return intervalSet;
      },
      clearInterval: () => {
        intervalCleared += 1;
        intervalHandler = null;
      },
    },
    log,
  };

  return {
    sync: createRevocationSync(deps),
    entries,
    blockedCalls,
    advance: (ms: number) => (clock += ms),
    setList: (next: TokenRevocationList) => (list = next),
    setFailFetch: (value: boolean) => (failFetch = value),
    setFailOnBlocked: (value: boolean) => (failOnBlocked = value),
    fire: () => intervalHandler?.(),
    hasInterval: () => intervalHandler !== null,
    counts: () => ({ set: intervalSet, cleared: intervalCleared }),
  };
}

function claims(sub: string, iatMs: number): AccessTokenClaims {
  return {
    sub,
    org: 'org-1',
    role: 'user',
    iss: 'swag-identity',
    aud: 'swag',
    iat: iatMs / 1000,
    exp: iatMs / 1000 + 900,
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('RevocationSync (спека 024, T-12, 4.12)', () => {
  it('AC-024-19: revoked для iat*1000 < validAfter, ok для равного и более позднего, ok без записи', async () => {
    const env = makeEnv();
    env.setList({ revocations: [{ userId: 'u1', validAfter: 5000, blocked: false }] });
    await env.sync.start();
    expect(env.sync.check(claims('u1', 4999))).toBe('revoked');
    expect(env.sync.check(claims('u1', 5000))).toBe('ok');
    expect(env.sync.check(claims('u1', 6000))).toBe('ok');
    expect(env.sync.check(claims('u2', 1000))).toBe('ok');
  });

  it('AC-024-19: unavailable до первой синхронизации и после maxStaleMs без удачной; неудачные не продлевают свежесть', async () => {
    const env = makeEnv();
    expect(env.sync.check(claims('u1', 1000))).toBe('unavailable');
    await env.sync.start();
    expect(env.sync.check(claims('u1', 1000))).toBe('ok');
    env.advance(30000);
    expect(env.sync.check(claims('u1', 1000))).toBe('ok');
    env.advance(1);
    expect(env.sync.check(claims('u1', 1000))).toBe('unavailable');
    env.setFailFetch(true);
    env.fire();
    await flush();
    env.advance(1000);
    expect(env.sync.check(claims('u1', 1000))).toBe('unavailable');
  });

  it('AC-024-19: каждая удачная синхронизация целиком заменяет таблицу (пропавшая запись → ok)', async () => {
    const env = makeEnv();
    env.setList({ revocations: [{ userId: 'u1', validAfter: 9000, blocked: false }] });
    await env.sync.start();
    expect(env.sync.check(claims('u1', 1000))).toBe('revoked');
    env.setList({ revocations: [] });
    env.fire();
    await flush();
    expect(env.sync.check(claims('u1', 1000))).toBe('ok');
  });

  it('AC-024-19: onBlocked один раз на новую пару blocked: true, повторно — при новом validAfter, не для blocked: false', async () => {
    const env = makeEnv();
    env.setList({
      revocations: [
        { userId: 'u1', validAfter: 5000, blocked: true },
        { userId: 'u2', validAfter: 5000, blocked: false },
      ],
    });
    await env.sync.start();
    expect(env.blockedCalls).toEqual(['u1']);

    env.fire();
    await flush();
    expect(env.blockedCalls).toEqual(['u1']);

    env.setList({
      revocations: [
        { userId: 'u1', validAfter: 8000, blocked: true },
        { userId: 'u2', validAfter: 5000, blocked: false },
      ],
    });
    env.fire();
    await flush();
    expect(env.blockedCalls).toEqual(['u1', 'u1']);
  });

  it('AC-024-19: ошибка fetchRevocations — warn revocations_sync_failed без текста ошибки, таблица прежняя', async () => {
    const env = makeEnv();
    env.setList({ revocations: [{ userId: 'u1', validAfter: 5000, blocked: false }] });
    await env.sync.start();
    env.setFailFetch(true);
    env.advance(1000);
    env.fire();
    await flush();
    expect(env.entries).toEqual([{ level: 'warn', msg: 'revocations_sync_failed' }]);
    expect(JSON.stringify(env.entries)).not.toContain('ECONNREFUSED');
    expect(env.sync.check(claims('u1', 4000))).toBe('revoked');
  });

  it('AC-024-19: start при неудачной первой синхронизации — reject, интервал не ставится', async () => {
    const env = makeEnv();
    env.setFailFetch(true);
    await expect(env.sync.start()).rejects.toThrow('revocations sync failed');
    expect(env.hasInterval()).toBe(false);
    expect(env.entries.map((e) => e.msg)).toEqual(['revocations_sync_failed']);
  });

  it('AC-024-19: start ставит интервал, stop его снимает', async () => {
    const env = makeEnv();
    await env.sync.start();
    expect(env.counts()).toEqual({ set: 1, cleared: 0 });
    expect(env.hasInterval()).toBe(true);
    env.sync.stop();
    expect(env.counts()).toEqual({ set: 1, cleared: 1 });
    expect(env.hasInterval()).toBe(false);
  });

  it('AC-024-19: ошибка onBlocked — warn revocation_block_failed без текста, таблица обновлена, синхронизация продолжается', async () => {
    const env = makeEnv();
    env.setFailOnBlocked(true);
    env.setList({ revocations: [{ userId: 'u1', validAfter: 5000, blocked: true }] });
    await env.sync.start();
    expect(env.entries).toEqual([
      { level: 'warn', msg: 'revocation_block_failed', ctx: { userId: 'u1' } },
    ]);
    expect(env.sync.check(claims('u1', 4000))).toBe('revoked');
    env.setList({ revocations: [{ userId: 'u1', validAfter: 6000, blocked: true }] });
    env.fire();
    await flush();
    expect(env.blockedCalls).toEqual(['u1', 'u1']);
    expect(env.sync.check(claims('u1', 5000))).toBe('revoked');
  });

  it('AC-024-19: тик пропускается, пока предыдущая синхронизация не закончилась', async () => {
    const pending: Array<(value: TokenRevocationList) => void> = [];
    const ticks: Array<() => void> = [];
    let calls = 0;
    const sync = createRevocationSync({
      fetchRevocations: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve({ revocations: [] });
        return new Promise((resolve) => pending.push(resolve));
      },
      onBlocked: async () => undefined,
      pollMs: 5000,
      maxStaleMs: 30000,
      now: () => 0,
      timers: {
        setInterval: (h) => (ticks.push(h), 1),
        clearInterval: () => undefined,
      },
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });
    await sync.start();
    ticks[0]?.();
    ticks[0]?.();
    await flush();
    expect(calls).toBe(2);
    pending[0]?.({ revocations: [] });
    await flush();
    ticks[0]?.();
    await flush();
    expect(calls).toBe(3);
  });
});
