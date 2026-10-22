import { describe, expect, it, vi } from 'vitest';
import type { PlatformEvent } from '@swag/contracts';
import { projectSwarm, type SwarmView } from '@swag/api-integration';
import {
  createUiCore,
  type EventStream,
  type StreamHandlers,
  type SwarmsApi,
} from '../src/index.ts';

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
    agents: [
      { id: 'agent-1', name: 'A', role: 'r1' },
      { id: 'agent-2', name: 'B', role: 'r2' },
    ],
  },
});
const started = ev(2, { type: 'swarm.started', data: {} });
const agentStarted = ev(3, {
  type: 'agent.started',
  source: 'agent',
  agentId: 'agent-1',
  data: {},
});

function fakeApi() {
  const api = {
    list: vi.fn(async () => []),
    create: vi.fn(async (): Promise<SwarmView> => projectSwarm([created])),
    get: vi.fn(async (): Promise<SwarmView> => projectSwarm([created])),
    stop: vi.fn(async () => undefined),
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
  };
}

describe('ui-core', () => {
  it('AC-001-23: пустая задача — ошибка формы; валидная форма — вызван SwarmsApi.create', async () => {
    const api = fakeApi();
    const { stream } = fakeStream();
    const core = createUiCore({ api, stream, timers: fakeTimers().timers, traces });

    const invalid = await core.createSwarm({ task: '', agents: [{ name: 'A', role: 'r' }] });
    expect(invalid.ok).toBe(false);
    expect(api.create).not.toHaveBeenCalled();

    const valid = await core.createSwarm({ task: 'T', agents: [{ name: 'A', role: 'r' }] });
    expect(valid.ok).toBe(true);
    expect(api.create).toHaveBeenCalledWith({ task: 'T', agents: [{ name: 'A', role: 'r' }] });
  });

  it('AC-001-23: поток отдаёт события — состояние страницы совпадает с projectSwarm', () => {
    const { stream, opened } = fakeStream();
    const core = createUiCore({ api: fakeApi(), stream, timers: fakeTimers().timers, traces });
    const page = core.openSwarm(SWARM);
    expect(opened[0]?.after).toBe(0);
    const events = [created, started, agentStarted];
    for (const event of events) opened[0]?.handlers.onEvent(event);
    expect(page.view).toEqual(projectSwarm(events));
    expect(page.feed).toHaveLength(3);
    expect(page.connected).toBe(true);
  });

  it('AC-001-23: поток рвётся — переподключение с after = lastSeq через паузу, без повторов в ленте', () => {
    const { stream, opened } = fakeStream();
    const fake = fakeTimers();
    const core = createUiCore({
      api: fakeApi(),
      stream,
      timers: fake.timers,
      reconnectMs: 1000,
      traces,
    });
    const page = core.openSwarm(SWARM);
    opened[0]?.handlers.onEvent(created);
    opened[0]?.handlers.onEvent(started);
    opened[0]?.handlers.onError();
    expect(page.connected).toBe(false);
    expect(opened).toHaveLength(1);

    fake.fireAll();
    expect(opened).toHaveLength(2);
    expect(opened[1]?.after).toBe(2);

    // сервер повторно присылает уже полученное событие и добавляет новое
    opened[1]?.handlers.onEvent(started);
    opened[1]?.handlers.onEvent(agentStarted);
    expect(page.feed.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(page.view).toEqual(projectSwarm([created, started, agentStarted]));
  });

  it('остановка вызывает SwarmsApi.stop; close закрывает поток и отменяет переподключение', async () => {
    const api = fakeApi();
    const { stream, opened } = fakeStream();
    const fake = fakeTimers();
    const core = createUiCore({ api, stream, timers: fake.timers, traces });
    const page = core.openSwarm(SWARM);
    await page.stop();
    expect(api.stop).toHaveBeenCalledWith(SWARM);

    opened[0]?.handlers.onError();
    page.close();
    fake.fireAll();
    expect(opened).toHaveLength(1);
    expect(opened[0]?.closed).toBe(false);
  });

  it('AC-016-14: traceUrl подставляет traceId в шаблон; без traceId — null', () => {
    const { stream } = fakeStream();
    const core = createUiCore({ api: fakeApi(), stream, timers: fakeTimers().timers, traces });
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    expect(core.traceUrl(traceId)).toBe(`http://g/x?t=${traceId}`);
    expect(core.traceUrl(null)).toBeNull();
  });
});
