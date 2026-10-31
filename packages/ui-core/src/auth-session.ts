import type { AuthRefreshed, AuthSession } from '@swag/contracts';

// Спека 024, 4.15: сессия входа кабинета. Токен доступа — только в памяти; обновление — по cookie через AuthApi.

export interface AuthApi {
  login(email: string, password: string): Promise<AuthSession>; // reject с кодом ошибки — неудача
  refresh(): Promise<AuthRefreshed | null>; // null — 401
  logout(): Promise<void>;
}

export interface AuthSessionKeeper {
  restore(): Promise<boolean>; // при старте: refresh по cookie
  login(email: string, password: string): Promise<{ ok: true } | { ok: false; code: string }>;
  logout(): Promise<void>;
  accessToken(): string | null;
  renew(): Promise<boolean>; // после 401: один refresh на все одновременные запросы
  onSignedOut(listener: () => void): () => void;
}

// Трактовка: код берётся из `error.code` (строка), иначе `'unknown'`.
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

export function createAuthSessionKeeper(api: AuthApi): AuthSessionKeeper {
  let token: string | null = null;
  let pendingRenew: Promise<boolean> | null = null;
  const listeners = new Set<() => void>();

  // Трактовка: reject refresh (сеть, 5xx) считается неудачей, как null.
  async function refreshToken(): Promise<boolean> {
    try {
      const refreshed = await api.refresh();
      if (refreshed === null) return false;
      token = refreshed.accessToken;
      return true;
    } catch {
      return false;
    }
  }

  function signOut(): void {
    token = null;
    for (const listener of [...listeners]) listener();
  }

  return {
    restore: refreshToken,

    async login(email, password) {
      try {
        token = (await api.login(email, password)).accessToken;
        return { ok: true };
      } catch (error) {
        return { ok: false, code: errorCode(error) };
      }
    },

    // Трактовка: слушатели onSignedOut не вызываются — выход инициирует сам вызывающий код.
    // Ошибка api.logout пробрасывается, токен стирается в любом случае.
    async logout() {
      try {
        await api.logout();
      } finally {
        token = null;
      }
    },

    accessToken: () => token,

    renew() {
      pendingRenew ??= refreshToken()
        .then((ok) => {
          if (!ok) signOut();
          return ok;
        })
        .finally(() => {
          pendingRenew = null;
        });
      return pendingRenew;
    },

    onSignedOut(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
