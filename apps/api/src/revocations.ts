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
  let lastSuccessAt: number | null = null;
  let handle: unknown = null;
  let busy = false;

  async function sync(): Promise<boolean> {
    let list: TokenRevocationList;
    try {
      list = await deps.fetchRevocations();
    } catch {
      deps.log.warn('revocations_sync_failed');
      return false;
    }
    const previous = validAfterByUser;
    validAfterByUser = new Map(list.revocations.map((r) => [r.userId, r.validAfter]));
    lastSuccessAt = deps.now();
    for (const r of list.revocations) {
      if (!r.blocked || previous.get(r.userId) === r.validAfter) continue;
      try {
        await deps.onBlocked(r.userId);
      } catch {
        deps.log.warn('revocation_block_failed', { userId: r.userId });
      }
    }
    return true;
  }

  return {
    async start() {
      if (!(await sync())) throw new Error('revocations sync failed');
      handle = deps.timers.setInterval(() => {
        if (busy) return;
        busy = true;
        void sync().finally(() => {
          busy = false;
        });
      }, deps.pollMs);
    },
    stop() {
      deps.timers.clearInterval(handle);
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
