import type { Logger } from '@swag/api-core';
import type { AccessTokenClaims, TokenRevocationList } from '@swag/contracts';

// Спека 024, 4.12: синхронизация отзывов токенов из identity. Таблица userId → validAfter целиком заменяется каждой удачной синхронизацией.
export interface RevocationSync {
  start(): Promise<void>;
  stop(): void;
  check(claims: AccessTokenClaims): 'ok' | 'revoked' | 'unavailable';
}

export interface RevocationSyncDeps {
  fetchRevocations(): Promise<TokenRevocationList>;
  onBlocked(userId: string): Promise<void>;
  pollMs: number;
  maxStaleMs: number;
  now(): number;
  timers: {
    setInterval(handler: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
  log: Logger;
}

export function createRevocationSync(deps: RevocationSyncDeps): RevocationSync {
  let validAfterByUser = new Map<string, number>();
  // Пары userId → validAfter, для которых onBlocked уже успешно вызван.
  const handled = new Map<string, number>();
  let lastSuccessAt: number | null = null;
  let handle: unknown = null;
  let busy = false;
  let stopped = false;

  async function sync(): Promise<boolean> {
    let list: TokenRevocationList;
    try {
      list = await deps.fetchRevocations();
    } catch {
      deps.log.warn('revocations_sync_failed');
      return false;
    }
    if (stopped) return true;
    validAfterByUser = new Map(list.revocations.map((r) => [r.userId, r.validAfter]));
    lastSuccessAt = deps.now();
    const blocked = new Map(
      list.revocations.filter((r) => r.blocked).map((r) => [r.userId, r.validAfter]),
    );
    for (const [userId, validAfter] of handled) {
      if (blocked.get(userId) !== validAfter) handled.delete(userId);
    }
    const pending = [...blocked].filter(
      ([userId, validAfter]) => handled.get(userId) !== validAfter,
    );
    await Promise.allSettled(
      pending.map(async ([userId, validAfter]) => {
        try {
          await deps.onBlocked(userId);
          handled.set(userId, validAfter);
        } catch {
          deps.log.warn('revocation_block_failed', { userId });
        }
      }),
    );
    return true;
  }

  return {
    async start() {
      if (handle !== null) return;
      stopped = false;
      if (!(await sync())) throw new Error('revocations sync failed');
      if (stopped || handle !== null) return;
      handle = deps.timers.setInterval(() => {
        if (busy) return;
        busy = true;
        void sync().finally(() => {
          busy = false;
        });
      }, deps.pollMs);
    },
    stop() {
      stopped = true;
      if (handle !== null) deps.timers.clearInterval(handle);
      handle = null;
    },
    check(claims) {
      if (lastSuccessAt === null || deps.now() - lastSuccessAt > deps.maxStaleMs)
        return 'unavailable';
      const validAfter = validAfterByUser.get(claims.sub);
      if (validAfter !== undefined && claims.iat * 1000 < validAfter) return 'revoked';
      return 'ok';
    },
  };
}
