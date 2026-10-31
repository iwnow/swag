import type { ApiCore } from '@swag/api-core';
import { UNAUTHORIZED_CLOSE_CODE } from './auth.ts';

// Спека 024, 4.6 и 4.12: открытые потоки по пользователю, чтобы блокировка закрыла их.
export interface StreamSocket {
  close(code: number, reason: string): void;
}

export interface StreamRegistry {
  add(userId: string, socket: StreamSocket): () => void;
  closeUser(userId: string, code: number, reason: string): void;
}

export function createStreamRegistry(): StreamRegistry {
  const byUser = new Map<string, Set<StreamSocket>>();
  return {
    add(userId, socket) {
      const sockets = byUser.get(userId) ?? new Set<StreamSocket>();
      sockets.add(socket);
      byUser.set(userId, sockets);
      return () => {
        sockets.delete(socket);
        if (sockets.size === 0 && byUser.get(userId) === sockets) byUser.delete(userId);
      };
    },
    closeUser(userId, code, reason) {
      const sockets = byUser.get(userId);
      if (sockets === undefined) return;
      byUser.delete(userId);
      for (const socket of sockets) socket.close(code, reason);
    },
  };
}

// onBlocked для синхронизации отзывов (4.12, правило 3): потоки закрываются, даже если остановка роёв упала;
// ошибка уходит дальше, и синхронизация повторит вызов.
export function createBlockHandler(
  core: Pick<ApiCore, 'stopSwarmsOfUser'>,
  streams: StreamRegistry,
): (userId: string) => Promise<void> {
  return async (userId) => {
    try {
      await core.stopSwarmsOfUser(userId);
    } finally {
      streams.closeUser(userId, UNAUTHORIZED_CLOSE_CODE, 'unauthorized');
    }
  };
}
