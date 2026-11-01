import { batch, computed, signal, type ReadonlySignal } from '@preact/signals-core';
import type { AuthMe, InvitationAcceptRequest, RegistrationConfirmRequest } from '@swag/contracts';
import { canOpen as canOpenArea, navigationFor, type NavItem, type UiArea } from './access-ui.ts';
import { createAuthSessionKeeper, type AuthApi, type AuthResult } from './auth-session.ts';
import type { MeApi } from './ports.ts';

// Спека 014, 4.12: сессионный пользователь страницы; один экземпляр на каркас и все remote.

export type SessionStatus = 'unknown' | 'signed-in' | 'signed-out';

export interface SessionUserStore {
  readonly me: ReadonlySignal<AuthMe | null>;
  readonly status: ReadonlySignal<SessionStatus>;
  readonly role: ReadonlySignal<AuthMe['user']['role'] | null>;
  readonly orgId: ReadonlySignal<string | null>;
  readonly navigation: ReadonlySignal<NavItem[]>;
  canOpen(area: UiArea): boolean;
  accessToken(): string | null;
  renew(): Promise<boolean>;
  restore(): Promise<boolean>;
  ensureMe(): Promise<void>;
  login(email: string, password: string): Promise<AuthResult>;
  register(email: string): Promise<AuthResult>;
  confirmRegistration(body: RegistrationConfirmRequest): Promise<AuthResult>;
  acceptInvitation(body: InvitationAcceptRequest): Promise<AuthResult>;
  logout(): Promise<void>;
}

export function createSessionUserStore({
  auth,
  me: meApi,
}: {
  auth: AuthApi;
  me: MeApi;
}): SessionUserStore {
  const keeper = createAuthSessionKeeper(auth);
  const me = signal<AuthMe | null>(null);
  const status = signal<SessionStatus>('unknown');
  const role = computed(() => me.value?.user.role ?? null);
  const orgId = computed(() => me.value?.organization?.id ?? null);
  const navigation = computed(() => navigationFor(me.value));

  // Токен последней загрузки и её промис: повторные вызовы с тем же токеном ждут тот же промис.
  let loadedToken: string | null = null;
  let loading: Promise<void> | null = null;
  let restored: Promise<boolean> | null = null;

  function signOut(): void {
    loadedToken = null;
    loading = null;
    batch(() => {
      me.value = null;
      status.value = 'signed-out';
    });
  }

  // Ответ для токена, который уже сменился, не записывается: актуален только текущий токен.
  // Сбой me (сеть, 5xx) бросает исключение: его ловит ensureMe, me и status не меняются.
  async function loadMe(token: string): Promise<void> {
    let current = token;
    let user = await meApi.me(token);
    let renewed = false;
    if (user === null && (await keeper.renew())) {
      const next = keeper.accessToken();
      if (next === null) return;
      current = next;
      loadedToken = next;
      renewed = true;
      user = await meApi.me(next);
    }
    if (keeper.accessToken() !== current) return;
    if (user === null) {
      // Повторный null после renew: токен стирается у хранителя (D-148).
      if (renewed) await keeper.logout().catch(() => undefined);
      signOut();
      return;
    }
    batch(() => {
      me.value = user;
      status.value = 'signed-in';
    });
  }

  function ensureMe(): Promise<void> {
    const token = keeper.accessToken();
    if (token === null) {
      signOut();
      return Promise.resolve();
    }
    if (token !== loadedToken || loading === null) {
      loadedToken = token;
      // Сбой загрузки (D-147): кэш сбрасывается, следующий ensureMe повторит запрос; ensureMe не отклоняется.
      const started: Promise<void> = loadMe(token).catch(() => {
        if (loading === started) {
          loadedToken = null;
          loading = null;
        }
      });
      loading = started;
    }
    return loading;
  }

  keeper.onSignedOut(signOut);

  return {
    me,
    status,
    role,
    orgId,
    navigation,
    canOpen: (area) => canOpenArea(area, me.value),
    accessToken: () => keeper.accessToken(),

    async renew() {
      const renewed = await keeper.renew();
      if (renewed) await ensureMe();
      return renewed;
    },

    // Один restore на стор: повторные вызовы получают тот же промис.
    restore() {
      restored ??= (async () => {
        const ok = await keeper.restore();
        await ensureMe();
        return ok;
      })();
      return restored;
    },

    ensureMe,

    async login(email, password) {
      const result = await keeper.login(email, password);
      if (result.ok) await ensureMe();
      return result;
    },

    register: (email) => keeper.register(email),

    async confirmRegistration(body) {
      const result = await keeper.confirmRegistration(body);
      if (result.ok) await ensureMe();
      return result;
    },

    async acceptInvitation(body) {
      const result = await keeper.acceptInvitation(body);
      if (result.ok) await ensureMe();
      return result;
    },

    async logout() {
      try {
        await keeper.logout();
      } finally {
        signOut();
      }
    },
  };
}
