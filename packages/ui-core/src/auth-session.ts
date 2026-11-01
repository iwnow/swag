import type {
  AuthRefreshed,
  AuthSession,
  InvitationAcceptRequest,
  RegistrationConfirmRequest,
} from '@swag/contracts';

// Спека 024, 4.15: сессия входа кабинета. Токен доступа — только в памяти; обновление — по cookie через AuthApi.
// Спека 014, 4.1: регистрация и приглашение в той же сессии.

export interface AuthApi {
  login(email: string, password: string): Promise<AuthSession>; // reject с кодом ошибки — неудача
  refresh(): Promise<AuthRefreshed | null>; // null — 401
  logout(): Promise<void>;
  register(email: string): Promise<void>; // POST /auth/registrations, 202
  confirmRegistration(body: RegistrationConfirmRequest): Promise<AuthSession>; // POST /auth/registrations/confirm, 201
  acceptInvitation(body: InvitationAcceptRequest): Promise<AuthSession>; // POST /auth/invitations/accept, 201
}

export type AuthResult = { ok: true } | { ok: false; code: string };

export interface AuthSessionKeeper {
  restore(): Promise<boolean>; // при старте: refresh по cookie
  login(email: string, password: string): Promise<AuthResult>;
  logout(): Promise<void>;
  accessToken(): string | null;
  renew(): Promise<boolean>; // после 401: один refresh на все одновременные запросы
  onSignedOut(listener: () => void): () => void;
  register(email: string): Promise<AuthResult>;
  confirmRegistration(body: RegistrationConfirmRequest): Promise<AuthResult>;
  acceptInvitation(body: InvitationAcceptRequest): Promise<AuthResult>;
}

// Трактовка: код берётся из `error.code` (строка), иначе `'unknown'`.
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

async function attempt(run: () => Promise<void>): Promise<AuthResult> {
  try {
    await run();
    return { ok: true };
  } catch (error) {
    return { ok: false, code: errorCode(error) };
  }
}

// 'stale' — поколение сессии сменилось во время refresh (logout, login или выход по отказу): результат не записывается.
type RefreshOutcome = 'ok' | 'rejected' | 'stale';

export function createAuthSessionKeeper(api: AuthApi): AuthSessionKeeper {
  let token: string | null = null;
  // Поколение сессии: login, logout и выход по отказу обновления его увеличивают и отбрасывают refresh в полёте.
  let epoch = 0;
  let pendingRefresh: Promise<RefreshOutcome> | null = null;
  const listeners = new Set<() => void>();

  function bumpEpoch(): void {
    epoch += 1;
    pendingRefresh = null;
  }

  // Трактовка: reject refresh (сеть, 5xx) считается неудачей, как null.
  async function refreshToken(): Promise<RefreshOutcome> {
    const started = epoch;
    let refreshed: AuthRefreshed | null;
    try {
      refreshed = await api.refresh();
    } catch {
      refreshed = null;
    }
    if (started !== epoch) return 'stale';
    if (refreshed === null) return 'rejected';
    token = refreshed.accessToken;
    return 'ok';
  }

  // Один refresh на restore и все одновременные renew.
  function refreshShared(): Promise<RefreshOutcome> {
    if (pendingRefresh === null) {
      const current: Promise<RefreshOutcome> = refreshToken().finally(() => {
        if (pendingRefresh === current) pendingRefresh = null;
      });
      pendingRefresh = current;
    }
    return pendingRefresh;
  }

  function signOut(): void {
    token = null;
    bumpEpoch();
    for (const listener of [...listeners]) listener();
  }

  // Трактовка (014, 4.1): вход по ответу с токеном устроен как login — поколение меняется до запроса.
  function signIn(request: () => Promise<AuthSession>): Promise<AuthResult> {
    bumpEpoch();
    return attempt(async () => {
      token = (await request()).accessToken;
    });
  }

  return {
    // Трактовка: restore делит refresh с renew, но неудача здесь выход не инициирует (onSignedOut не вызывается).
    async restore() {
      return (await refreshShared()) === 'ok';
    },

    login: (email, password) => signIn(() => api.login(email, password)),

    // Трактовка (014, 4.1): register не трогает ни токен, ни поколение.
    register: (email) => attempt(() => api.register(email)),

    confirmRegistration: (body) => signIn(() => api.confirmRegistration(body)),

    acceptInvitation: (body) => signIn(() => api.acceptInvitation(body)),

    // Трактовка: слушатели onSignedOut не вызываются — выход инициирует сам вызывающий код.
    // Ошибка api.logout пробрасывается, токен стирается в любом случае.
    async logout() {
      bumpEpoch();
      try {
        await api.logout();
      } finally {
        token = null;
      }
    },

    accessToken: () => token,

    // Трактовка: onSignedOut — только если отказ относится к поколению, в котором вызван renew; второй renew после выхода его не повторяет.
    async renew() {
      const started = epoch;
      const outcome = await refreshShared();
      if (outcome === 'ok') return true;
      if (outcome === 'rejected' && started === epoch) signOut();
      return false;
    },

    onSignedOut(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
