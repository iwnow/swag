import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PlatformEventInput } from '@swag/contracts';
import { buildApp } from '../src/app.ts';
import { actorOf, body, bearer, makeCore, makeStartedAuth, T, WHO } from './support.ts';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const ev = (
  swarmId: string,
  n: number,
  input: Omit<PlatformEventInput, 'id' | 'swarmId' | 'ts' | 'traceId'>,
): PlatformEventInput =>
  ({
    ...input,
    id: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`,
    swarmId,
    ts: '2026-10-22T10:00:01.000Z',
    traceId: null,
  }) as PlatformEventInput;

async function started(orchestrator?: Parameters<typeof makeCore>[0]) {
  const core = makeCore(orchestrator);
  const app = await buildApp(core, {}, (await makeStartedAuth({ core })).app);
  apps.push(app);
  return { core, app };
}

describe('REST api', () => {
  it('AC-001-3: POST /swarms — 201, starting, агенты agent-1..3', async () => {
    const { app } = await started();
    const response = await app.inject({
      method: 'POST',
      url: '/swarms',
      headers: bearer(T.adminA),
      payload: body(3),
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: 'starting',
      agents: [{ id: 'agent-1' }, { id: 'agent-2' }, { id: 'agent-3' }],
    });
  });

  it('AC-001-4: невалидное тело — 400 validation_error с issues', async () => {
    const { app } = await started();
    const response = await app.inject({
      method: 'POST',
      url: '/swarms',
      headers: bearer(T.adminA),
      payload: { task: '', agents: [] },
    });
    expect(response.statusCode).toBe(400);
    const error = response.json().error;
    expect(error.code).toBe('validation_error');
    expect(error.issues.map((i: { path: string }) => i.path)).toContain('agents');
  });

  it('AC-001-10: POST /swarms/:id/stop — 202 и вызов оркестратора; completed — 409; неизвестный — 404', async () => {
    const stop = vi.fn(async () => undefined);
    const { core, app } = await started({ launch: async () => undefined, stop });
    const created = (
      await app.inject({
        method: 'POST',
        url: '/swarms',
        headers: bearer(T.adminA),
        payload: body(1),
      })
    ).json();
    await core.ingestEvent(
      ev(created.id, 1, { type: 'swarm.started', source: 'orchestrator', agentId: null, data: {} }),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/swarms/${created.id}/stop`,
      headers: bearer(T.adminA),
    });
    expect(response.statusCode).toBe(202);
    expect(stop).toHaveBeenCalledWith(created.id);

    await core.ingestEvent(
      ev(created.id, 2, {
        type: 'swarm.completed',
        source: 'orchestrator',
        agentId: null,
        data: { result: 'R' },
      }),
    );
    const finished = await app.inject({
      method: 'POST',
      url: `/swarms/${created.id}/stop`,
      headers: bearer(T.adminA),
    });
    expect(finished.statusCode).toBe(409);
    expect(finished.json().error.code).toBe('swarm_finished');

    const unknown = await app.inject({
      method: 'POST',
      url: '/swarms/00000000-0000-4000-8000-000000000999/stop',
      headers: bearer(T.adminA),
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('GET /swarms/:id/events?after=1 отдаёт события с seq больше 1', async () => {
    const { core, app } = await started();
    const created = (
      await app.inject({
        method: 'POST',
        url: '/swarms',
        headers: bearer(T.adminA),
        payload: body(1),
      })
    ).json();
    await core.ingestEvent(
      ev(created.id, 1, { type: 'swarm.started', source: 'orchestrator', agentId: null, data: {} }),
    );
    const response = await app.inject({
      method: 'GET',
      url: `/swarms/${created.id}/events?after=1`,
      headers: bearer(T.adminA),
    });
    expect(response.json().map((e: { seq: number }) => e.seq)).toEqual([2]);
  });
});

describe('WebSocket /swarms/:id/stream', () => {
  it('AC-001-9: после after=2 приходят 3..5, затем новые 6 и 7; неизвестный рой — закрытие 4404', async () => {
    const { core, app } = await started();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const swarm = await core.createSwarm(actorOf(WHO.adminA), body(1));
    if (!swarm.ok) throw new Error('не создан');
    const id = swarm.value.id;
    for (let n = 1; n <= 4; n += 1) {
      await core.ingestEvent(
        ev(id, n, { type: 'swarm.started', source: 'orchestrator', agentId: null, data: {} }),
      );
    }

    const received: number[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/swarms/${id}/stream?after=2`, [
      'swag.v1',
      `swag.bearer.${T.adminA}`,
    ]);
    socket.addEventListener('message', (message) => {
      received.push((JSON.parse(String(message.data)) as { seq: number }).seq);
    });
    await vi.waitFor(() => expect(received).toEqual([3, 4, 5]));
    await core.ingestEvent(
      ev(id, 10, {
        type: 'swarm.stopped',
        source: 'orchestrator',
        agentId: null,
        data: { reason: 'user' },
      }),
    );
    await core.ingestEvent(
      ev(id, 11, {
        type: 'swarm.failed',
        source: 'orchestrator',
        agentId: null,
        data: { reason: 'swarm_timeout' },
      }),
    );
    await vi.waitFor(() => expect(received).toEqual([3, 4, 5, 6, 7]));
    socket.close();

    const closed = await new Promise<number>((resolve) => {
      const other = new WebSocket(
        `ws://127.0.0.1:${port}/swarms/00000000-0000-4000-8000-000000000999/stream`,
        ['swag.v1', `swag.bearer.${T.adminA}`],
      );
      other.addEventListener('close', (event) => resolve(event.code));
    });
    expect(closed).toBe(4404);
  });
});
