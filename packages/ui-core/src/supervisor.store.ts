import { batch, computed, signal, type ReadonlySignal } from '@preact/signals-core';
import type { ManagedUser, OrganizationSummary } from '@swag/contracts';
import { userActionBody, userRows, type UserAction, type UserRow } from './access-ui.ts';
import { authErrorText } from './auth-forms.ts';
import { createBalanceState, type BalanceState } from './balance.state.ts';
import { failureCode } from './error-code.ts';
import type { BalanceApi } from './ports.ts';
import type { SessionUserStore } from './session-user.store.ts';
import type { OrganizationsApi, UsersApi } from './swarm-ui.ts';

// Спека 014, 4.12 (SupervisorStore, REQ-014-13, REQ-014-23): организации и их пользователи для супервизора поверх портов.

export interface SupervisorStoreDeps {
  session: Pick<SessionUserStore, 'me' | 'role'>;
  users: UsersApi;
  organizations: OrganizationsApi;
  balance: BalanceApi;
}

export interface SupervisorStore {
  readonly organizations: ReadonlySignal<OrganizationSummary[]>;
  readonly loaded: ReadonlySignal<boolean>;
  readonly orgId: ReadonlySignal<string | null>;
  readonly organization: ReadonlySignal<OrganizationSummary | null>;
  readonly notFound: ReadonlySignal<boolean>;
  readonly users: ReadonlySignal<ManagedUser[]>;
  readonly usersLoaded: ReadonlySignal<boolean>;
  readonly rows: ReadonlySignal<UserRow[]>;
  readonly error: ReadonlySignal<string | null>;
  readonly balance: BalanceState;
  loadOrganizations(): Promise<void>;
  openOrganization(orgId: string): Promise<void>;
  apply(userId: string, action: UserAction): Promise<void>;
  topup(input: { amountUsd: string; comment: string }): Promise<boolean>;
}

export function createSupervisorStore({
  session,
  users: usersApi,
  organizations: organizationsApi,
  balance: balanceApi,
}: SupervisorStoreDeps): SupervisorStore {
  const organizations = signal<OrganizationSummary[]>([]);
  const loaded = signal(false);
  const orgId = signal<string | null>(null);
  const users = signal<ManagedUser[]>([]);
  const usersLoaded = signal(false);
  // Ошибка загрузки списка организаций: держится до следующего loadOrganizations, не стирается заходом на страницу.
  const listError = signal<string | null>(null);
  // Ошибка действий над пользователями текущей организации.
  const userError = signal<string | null>(null);
  const error = computed(() => listError.value ?? userError.value);
  const organization = computed(
    () => organizations.value.find((item) => item.id === orgId.value) ?? null,
  );
  const notFound = computed(
    () =>
      loaded.value &&
      listError.value === null &&
      orgId.value !== null &&
      organization.value === null,
  );
  const rows = computed<UserRow[]>(() => userRows(session.me.value, users.value));
  const balance = createBalanceState({ session, balance: balanceApi });

  // Номер последнего запроса организаций: ответ от устаревшего вызова не записывается.
  let organizationsGeneration = 0;
  // Номер последней смены организации: ответ пользователей для сменившегося orgId не записывается.
  let generation = 0;

  // Перечитывание пользователей без сброса users: таблица не мигает между запросами.
  async function fetchUsers(id: string, current: number): Promise<void> {
    try {
      const list = await usersApi.list(id);
      if (current === generation) users.value = list.users;
    } catch (failure) {
      if (current === generation) userError.value = authErrorText(failureCode(failure));
    } finally {
      if (current === generation) usersLoaded.value = true;
    }
  }

  return {
    organizations,
    loaded,
    orgId,
    organization,
    notFound,
    users,
    usersLoaded,
    rows,
    error,
    balance,

    async loadOrganizations() {
      const current = ++organizationsGeneration;
      batch(() => {
        organizations.value = [];
        loaded.value = false;
        listError.value = null;
      });
      try {
        const list = await organizationsApi.list();
        if (current === organizationsGeneration) organizations.value = list.organizations;
      } catch (failure) {
        if (current === organizationsGeneration)
          listError.value = authErrorText(failureCode(failure));
      } finally {
        if (current === organizationsGeneration) loaded.value = true;
      }
    },

    // Заход на страницу организации: пользователи сбрасываются и грузятся заново вместе с балансом.
    async openOrganization(next) {
      const current = ++generation;
      batch(() => {
        orgId.value = next;
        users.value = [];
        usersLoaded.value = false;
        userError.value = null;
      });
      await Promise.all([balance.open(next), fetchUsers(next, current)]);
    },

    async apply(userId, action) {
      const id = orgId.value;
      const current = generation;
      userError.value = null;
      try {
        await usersApi.update(userId, userActionBody(action));
      } catch (failure) {
        if (current === generation) userError.value = authErrorText(failureCode(failure));
        return;
      }
      if (id !== null) await fetchUsers(id, current);
    },

    // Пополнение супервизора всегда с обязательным комментарием (014, 4.12).
    topup(input) {
      return balance.topup(input, true);
    },
  };
}
