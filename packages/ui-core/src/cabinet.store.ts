import { computed, signal, type ReadonlySignal } from '@preact/signals-core';
import type { PlatformEvent, SwarmSummary } from '@swag/contracts';
import type { SwarmView } from '@swag/api-integration';
import { createBalanceState, errorText, type BalanceState } from './balance.state.ts';
import { formatUsd } from './money.ts';
import type { BalanceApi } from './ports.ts';
import type { SessionUserStore } from './session-user.store.ts';
import {
  createUiCore,
  formatSwarmMoney,
  spentLastMinute,
  swarmFormInput,
  unreadMessageIds,
  type AgentInput,
  type EventStream,
  type FormIssue,
  type SwarmPage,
  type SwarmsApi,
  type Timers,
} from './swarm-ui.ts';

// Спека 014, 4.12 (CabinetStore, REQ-014-11, REQ-014-18, REQ-014-23): состояние кабинета поверх createUiCore.

// Спека 004, 4.8: строка денег и «за минуту» обновляются раз в 5 с.
const MONEY_TICK_MS = 5000;

export interface SwarmDraft {
  task: string;
  budget: string;
  maxTokens: string;
  agents: AgentInput[];
}

export interface CabinetSwarm {
  view: SwarmView | null;
  feed: readonly PlatformEvent[];
  connected: boolean;
}

export interface CabinetForm {
  busy: boolean;
  issues: FormIssue[];
  error: string | null;
}

export interface CabinetStoreDeps {
  session: Pick<SessionUserStore, 'role' | 'orgId'>;
  swarms: SwarmsApi;
  stream: EventStream;
  timers: Timers;
  traces: { urlTemplate: string };
  balance: BalanceApi;
}

export interface CabinetStore {
  readonly swarms: ReadonlySignal<SwarmSummary[]>;
  readonly swarmsLoaded: ReadonlySignal<boolean>;
  readonly swarmsError: ReadonlySignal<string | null>;
  readonly swarm: ReadonlySignal<CabinetSwarm | null>;
  readonly stopping: ReadonlySignal<boolean>;
  readonly swarmError: ReadonlySignal<string | null>;
  readonly stoppable: ReadonlySignal<boolean>;
  readonly unread: ReadonlySignal<ReadonlySet<string>>;
  readonly money: ReadonlySignal<string | null>;
  readonly form: ReadonlySignal<CabinetForm>;
  readonly balance: BalanceState;
  loadSwarms(): Promise<void>;
  createSwarm(input: SwarmDraft): Promise<string | null>;
  openSwarm(id: string): void;
  closeSwarm(): void;
  stopSwarm(): Promise<void>;
  traceUrl(traceId: string | null): string | null;
  dispose(): void;
}

// Спека 013, 4.11: 402 с кодом insufficient_balance — структурная проверка (HttpError живёт в ui-angular).
function isInsufficientBalance(failure: unknown): boolean {
  const { status, code } = (failure ?? {}) as { status?: unknown; code?: unknown };
  return status === 402 && code === 'insufficient_balance';
}

export function createCabinetStore(deps: CabinetStoreDeps): CabinetStore {
  const { session, timers } = deps;
  const ui = createUiCore({ api: deps.swarms, stream: deps.stream, timers, traces: deps.traces });
  const balance = createBalanceState({ session, balance: deps.balance });

  const swarms = signal<SwarmSummary[]>([]);
  const swarmsLoaded = signal(false);
  const swarmsError = signal<string | null>(null);
  const swarm = signal<CabinetSwarm | null>(null);
  const stopping = signal(false);
  const swarmError = signal<string | null>(null);
  const form = signal<CabinetForm>({ busy: false, issues: [], error: null });
  const now = signal(Date.now());

  const stoppable = computed(() => {
    const status = swarm.value?.view?.status;
    return status === 'starting' || status === 'running';
  });
  const unread = computed(() => {
    const state = swarm.value;
    return state?.view ? unreadMessageIds(state.feed, state.view.status) : new Set<string>();
  });
  const money = computed(() => {
    const state = swarm.value;
    if (!state?.view) return null;
    return formatSwarmMoney(state.view, spentLastMinute(state.feed, now.value));
  });

  const patchForm = (change: Partial<CabinetForm>): void => {
    form.value = { ...form.value, ...change };
  };

  let page: SwarmPage | null = null;
  let unsubscribe: (() => void) | null = null;
  let tick: unknown = null;

  function scheduleTick(): void {
    tick = timers.setTimeout(() => {
      now.value = Date.now();
      scheduleTick();
    }, MONEY_TICK_MS);
  }

  function stopTick(): void {
    if (tick !== null) timers.clearTimeout(tick);
    tick = null;
  }

  function closeSwarm(): void {
    unsubscribe?.();
    unsubscribe = null;
    page?.close();
    page = null;
    stopTick();
    swarm.value = null;
    stopping.value = false;
    swarmError.value = null;
  }

  async function submitErrorText(failure: unknown): Promise<string> {
    const orgId = session.orgId.value;
    if (!isInsufficientBalance(failure) || orgId === null) return errorText(failure);
    try {
      const view = await deps.balance.getBalance(orgId);
      return `Недостаточно средств: доступно ${formatUsd(view.availableMicroUsd)}`;
    } catch {
      return errorText(failure);
    }
  }

  return {
    swarms,
    swarmsLoaded,
    swarmsError,
    swarm,
    stopping,
    swarmError,
    stoppable,
    unread,
    money,
    form,
    balance,
    closeSwarm,

    async loadSwarms() {
      swarmsError.value = null;
      try {
        swarms.value = await ui.listSwarms();
      } catch (failure) {
        swarmsError.value = errorText(failure);
      } finally {
        swarmsLoaded.value = true;
      }
    },

    async createSwarm(input) {
      if (form.value.busy) return null;
      const check = ui.validateForm(
        swarmFormInput(input.task, input.budget, input.maxTokens, input.agents),
      );
      if (!check.ok) {
        patchForm({ issues: check.issues, error: null });
        return null;
      }
      patchForm({ busy: true, issues: [], error: null });
      try {
        const created = await ui.createSwarm(check.value);
        return created.ok && created.view ? created.view.id : null;
      } catch (failure) {
        patchForm({ error: await submitErrorText(failure) });
        return null;
      } finally {
        patchForm({ busy: false });
      }
    },

    openSwarm(id) {
      closeSwarm();
      const current = ui.openSwarm(id);
      const sync = (): void => {
        now.value = Date.now();
        swarm.value = {
          view: current.view,
          feed: [...current.feed],
          connected: current.connected,
        };
      };
      page = current;
      unsubscribe = current.onChange(sync);
      sync();
      scheduleTick();
    },

    async stopSwarm() {
      const current = page;
      if (current === null) return;
      stopping.value = true;
      swarmError.value = null;
      try {
        await current.stop();
      } catch (failure) {
        swarmError.value = errorText(failure);
      } finally {
        stopping.value = false;
      }
    },

    traceUrl(traceId) {
      return session.role.value === 'supervisor' ? ui.traceUrl(traceId) : null;
    },

    dispose: closeSwarm,
  };
}
