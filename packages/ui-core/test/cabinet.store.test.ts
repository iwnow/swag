import { afterEach, describe, expect, it, vi } from 'vitest';
import { signal } from '@preact/signals-core';
import type { AuthMe, BalanceView, PlatformEvent, SwarmSummary } from '@swag/contracts';
import { projectSwarm, type SwarmView } from '@swag/api-integration';
import {
  createCabinetStore,
  type BalanceApi,
  type EventStream,
  type StreamHandlers,
  type SessionUserStore,
  type SwarmsApi,
} from '../src/index.ts';

type Role = AuthMe['user']['role'];

const SWARM = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';
const traces = { urlTemplate: 'http://g/x?t={traceId}' };
const ev = (seq: number, input: Record<string, unknown>): PlatformEvent =>
  ({
    id: `00000000-0000-4000-9000-${String(seq).padStart(12, '0')}`,
    swarmId: SWARM,
    ts: '2026-10-22T10:00:00.000Z',
    source: 'orchestrator',
    agentId: null,
    traceId: null,
    seq,
    ...input,
  }) as PlatformEvent;

const created = ev(1, {
  type: 'swarm.created',
  source: 'api',
  data: {
    task: 'T',
    agents: [{ id: 'agent-1', name: 'A', role: 'r1', model: 'chat-small' }],
  },
});

const DRAFT = {
  task: 'T',
  budget: '0.50',
  maxTokens: '',
  agents: [{ name: 'A', role: 'r', model: 'chat-small' as const, budget: '', maxTokens: '' }],
};

const summary = { id: SWARM, task: 'T' } as SwarmSummary;

function fakeSession(role: Role | null, orgId: string | null = 'org-1') {
  return {
    role: signal<Role | null>(role),
    orgId: signal<string | null>(orgId),
  } as Pick<SessionUserStore, 'role' | 'orgId'>;
}

function fakeSwarms(overrides: Partial<SwarmsApi> = {}) {
  const api = {
    list: vi.fn(async (): Promise<SwarmSummary[]> => [summary]),
    create: vi.fn(async (): Promise<SwarmView> => projectSwarm([created])),
    get: vi.fn(async (): Promise<SwarmView> => projectSwarm([created])),
    stop: vi.fn(async () => undefined),
    ...overrides,
  };
  return api as typeof api & SwarmsApi;
}

function fakeStream() {
  const opened: { after: number; handlers: StreamHandlers; closed: boolean }[] = [];
  const stream: EventStream = {
    open: (_swarmId, after, handlers) => {
      const entry = { after, handlers, closed: false };
      opened.push(entry);
      return {
        close: () => {
          entry.closed = true;
        },
      };
    },
  };
  return { stream, opened };
}

function fakeTimers() {
  const pending: { fn: () => void; active: boolean }[] = [];
  return {
    timers: {
      setTimeout: (fn: () => void) => {
        const timer = { fn, active: true };
        pending.push(timer);
        return timer;
      },
      clearTimeout: (id: unknown) => {
        (id as { active: boolean }).active = false;
      },
    },
    fireAll: () => {
      for (const timer of pending.splice(0)) if (timer.active) timer.fn();
    },
    activeCount: () => pending.filter((timer) => timer.active).length,
  };
}

function fakeBalance(availableMicroUsd = 1234500) {
  return {
    getBalance: vi.fn(
      async (orgId: string) => ({ orgId, availableMicroUsd }) as unknown as BalanceView,
    ),
    listBalanceEntries: vi.fn(async () => ({ entries: [], nextBefore: null })),
    topup: vi.fn(async () => {
      throw new Error('not used');
    }),
  } satisfies BalanceApi;
}

function setup(
  options: {
    role?: Role | null;
    swarms?: ReturnType<typeof fakeSwarms>;
    balance?: ReturnType<typeof fakeBalance>;
  } = {},
) {
  const swarms = options.swarms ?? fakeSwarms();
  const balance = options.balance ?? fakeBalance();
  const { stream, opened } = fakeStream();
  const clock = fakeTimers();
  const store = createCabinetStore({
    session: fakeSession(options.role === undefined ? 'user' : options.role),
    swarms,
    stream,
    timers: clock.timers,
    traces,
    balance,
  });
  return { store, swarms, balance, opened, clock };
}

describe('cabinet store', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('AC-014-23: createSwarm с неверной формой — form.issues не пуст, SwarmsApi.create не вызван', async () => {
    const { store, swarms } = setup();

    const id = await store.createSwarm({ ...DRAFT, task: '' });

    expect(id).toBeNull();
    expect(store.form.value.issues.length).toBeGreaterThan(0);
    expect(swarms.create).not.toHaveBeenCalled();
  });

  it('AC-014-23: create отклонён 402 insufficient_balance — null, form.error с остатком как в кабинете', async () => {
    const swarms = fakeSwarms({
      create: vi.fn(async () => {
        throw Object.assign(new Error('insufficient'), {
          status: 402,
          code: 'insufficient_balance',
        });
      }),
    });
    const balance = fakeBalance(1234500);
    const { store } = setup({ swarms, balance });

    const id = await store.createSwarm(DRAFT);

    expect(id).toBeNull();
    expect(balance.getBalance).toHaveBeenCalledWith('org-1');
    expect(store.form.value.error).toBe('Недостаточно средств: доступно $1.2345');
    expect(store.form.value.busy).toBe(false);
  });

  it('AC-014-23: create успешен — id нового роя', async () => {
    const { store, swarms } = setup();

    const id = await store.createSwarm(DRAFT);

    expect(id).toBe(SWARM);
    expect(swarms.create).toHaveBeenCalledTimes(1);
  });

  it('AC-014-23: traceUrl у роли user — null, у supervisor — адрес по шаблону', () => {
    expect(setup({ role: 'user' }).store.traceUrl('t1')).toBeNull();
    expect(setup({ role: 'supervisor' }).store.traceUrl('t1')).toBe('http://g/x?t=t1');
  });

  it('AC-014-23: openSwarm и событие потока — swarm.feed содержит событие', () => {
    const { store, opened } = setup();

    store.openSwarm(SWARM);
    opened[0]!.handlers.onEvent(created);

    expect(store.swarm.value?.feed.map((event) => event.seq)).toEqual([1]);
    expect(store.swarm.value?.view?.status).toBe('starting');
  });

  it('AC-014-23: closeSwarm — поток закрыт, тик денег снят', () => {
    const { store, opened, clock } = setup();

    store.openSwarm(SWARM);
    store.closeSwarm();

    expect(opened[0]!.closed).toBe(true);
    expect(clock.activeCount()).toBe(0);
    expect(store.swarm.value).toBeNull();
  });

  it('AC-014-23: closeSwarm при обрыве потока — таймер переподключения снят, нового потока нет', () => {
    const { store, opened, clock } = setup();

    store.openSwarm(SWARM);
    opened[0]!.handlers.onError();
    expect(clock.activeCount()).toBe(2);
    store.closeSwarm();

    expect(clock.activeCount()).toBe(0);
    clock.fireAll();
    expect(opened).toHaveLength(1);
  });

  it('AC-014-23: loadSwarms с ошибкой — swarmsError, swarmsLoaded', async () => {
    const swarms = fakeSwarms({
      list: vi.fn(async () => {
        throw new Error('сеть');
      }),
    });
    const { store } = setup({ swarms });

    await store.loadSwarms();

    expect(store.swarmsError.value).toBe('сеть');
    expect(store.swarmsLoaded.value).toBe(true);
    expect(store.swarms.value).toEqual([]);
  });

  it('AC-014-23: stopSwarm с ошибкой — swarmError, stopping сброшен', async () => {
    const swarms = fakeSwarms({
      stop: vi.fn(async () => {
        throw new Error('отказ');
      }),
    });
    const { store } = setup({ swarms });
    store.openSwarm(SWARM);

    await store.stopSwarm();

    expect(store.swarmError.value).toBe('отказ');
    expect(store.stopping.value).toBe(false);
  });

  it('AC-014-23: money пересчитывается по тику таймера', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-22T10:00:30.000Z'));
    const { store, opened, clock } = setup();
    store.openSwarm(SWARM);
    opened[0]!.handlers.onEvent(created);
    opened[0]!.handlers.onEvent(
      ev(2, {
        type: 'llm.call',
        source: 'agent',
        agentId: 'agent-1',
        ts: '2026-10-22T10:00:00.000Z',
        data: { costMicroUsd: 200 },
      }),
    );
    expect(store.money.value).toContain('$0.0002 за минуту');

    vi.setSystemTime(new Date('2026-10-22T10:02:00.000Z'));
    clock.fireAll();

    expect(store.money.value).toContain('$0.0000 за минуту');
  });
});
