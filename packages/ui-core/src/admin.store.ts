import { computed, signal, type ReadonlySignal } from '@preact/signals-core';
import type { InvitationRequest, ManagedUser } from '@swag/contracts';
import { userActionBody, userActions, type UserAction } from './access-ui.ts';
import { authErrorText, invitationSentText, validateEmailForm } from './auth-forms.ts';
import { errorCode } from './auth-session.ts';
import type { SessionUserStore } from './session-user.store.ts';
import type { FormIssue, UsersApi } from './swarm-ui.ts';

// Спека 014, 4.12 (AdminStore, REQ-014-12, REQ-014-23): страница пользователей админки поверх UsersApi.

export interface AdminRow {
  user: ManagedUser;
  actions: UserAction[];
}

export interface AdminInvite {
  busy: boolean;
  issues: FormIssue[];
  error: string | null;
  // Текст «Приглашение отправлено на …» или null; форма показывает его вместо формы.
  sent: string | null;
}

export interface AdminStoreDeps {
  session: Pick<SessionUserStore, 'me'>;
  users: UsersApi;
}

export interface AdminStore {
  readonly users: ReadonlySignal<ManagedUser[]>;
  readonly loaded: ReadonlySignal<boolean>;
  readonly error: ReadonlySignal<string | null>;
  readonly invite: ReadonlySignal<AdminInvite>;
  readonly rows: ReadonlySignal<AdminRow[]>;
  load(): Promise<void>;
  sendInvite(email: string, role: InvitationRequest['role']): Promise<void>;
  resetInvite(): void;
  apply(userId: string, action: UserAction): Promise<void>;
}

// Трактовка: 403 — код forbidden независимо от тела ответа (4.6); остальное — код из error.code.
function failureCode(failure: unknown): string {
  const { status } = (failure ?? {}) as { status?: unknown };
  return status === 403 ? 'forbidden' : errorCode(failure);
}

const initialInvite = (): AdminInvite => ({ busy: false, issues: [], error: null, sent: null });

export function createAdminStore({ session, users: api }: AdminStoreDeps): AdminStore {
  const users = signal<ManagedUser[]>([]);
  const loaded = signal(false);
  const error = signal<string | null>(null);
  const invite = signal<AdminInvite>(initialInvite());
  const rows = computed<AdminRow[]>(() => {
    const me = session.me.value;
    return users.value.map((user) => ({ user, actions: me ? userActions(me, user) : [] }));
  });

  const patchInvite = (change: Partial<AdminInvite>): void => {
    invite.value = { ...invite.value, ...change };
  };

  // Номер последнего load: ответ от устаревшего вызова не записывается.
  let generation = 0;

  async function load(): Promise<void> {
    const current = ++generation;
    users.value = [];
    loaded.value = false;
    error.value = null;
    try {
      const list = await api.list(null);
      if (current === generation) users.value = list.users;
    } catch (failure) {
      if (current === generation) error.value = authErrorText(failureCode(failure));
    } finally {
      if (current === generation) loaded.value = true;
    }
  }

  return {
    users,
    loaded,
    error,
    invite,
    rows,
    load,

    async sendInvite(email, role) {
      if (invite.value.busy) return;
      const checked = validateEmailForm({ email });
      if (!checked.ok) {
        patchInvite({ issues: checked.issues, error: null, sent: null });
        return;
      }
      patchInvite({ busy: true, issues: [], error: null, sent: null });
      try {
        await api.invite({ email: checked.email, role });
        patchInvite({ sent: invitationSentText(checked.email) });
      } catch (failure) {
        patchInvite({ error: authErrorText(failureCode(failure)) });
      } finally {
        patchInvite({ busy: false });
      }
    },

    resetInvite() {
      invite.value = initialInvite();
    },

    async apply(userId, action) {
      error.value = null;
      try {
        await api.update(userId, userActionBody(action));
      } catch (failure) {
        error.value = authErrorText(failureCode(failure));
        return;
      }
      await load();
    },
  };
}
