import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiCore, OrchestratorClient } from '@swag/api-core';
import { buildApp } from '../src/app.ts';
import { startApiCore } from '../src/start.ts';
import { body, silentLog } from './support.ts';

// Нужен запущенный Postgres: POSTGRES_TEST_URL (compose или сервис в CI). Схема создаётся на время файла.
const url = process.env['POSTGRES_TEST_URL'];

describe.skipIf(!url)('история роёв на Postgres', () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const running = new Set<Run>();
  let admin: pg.Client;

  interface Run {
    core: ApiCore;
    app: FastifyInstance;
    pool: pg.Pool;
  }

  // Порядок старта — тот же, что в main.ts: startApiCore. Перезапуск — новый пул и новое ядро на той же схеме.
  async function start(orchestrator: OrchestratorClient): Promise<Run> {
    const { core, pool } = await startApiCore(
      { databaseUrl: url ?? '', schema },
      {
        version: 'test',
        orchestrator,
        clock: { now: () => new Date().toISOString() },
        ids: { uuid: () => randomUUID() },
        log: silentLog,
        trace: { currentTraceId: () => null },
        limits: { maxActiveSwarms: 3, maxBudgetMicroUsd: 5000000 },
      },
    );
    const run = { core, app: await buildApp(core), pool };
    running.add(run);
    return run;
  }

  async function stop(run: Run): Promise<void> {
    if (!running.delete(run)) return;
    await run.app.close();
    await run.pool.end();
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url ?? '' });
    await admin.connect();
    await admin.query(`create schema ${schema}`);
  });

  afterAll(async () => {
    await Promise.allSettled([...running].map(stop));
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });

  it('AC-003-8: после перезапуска рои и события на месте, бывший running — failed с api_restarted', async () => {
    const stopped: string[] = [];
    const orchestrator: OrchestratorClient = {
      launch: async () => undefined,
      stop: async (id) => {
        stopped.push(id);
      },
    };

    const first = await start(orchestrator);
    const created = await first.app.inject({ method: 'POST', url: '/swarms', payload: body(1) });
    expect(created.statusCode).toBe(201);
    const swarmId = created.json<{ id: string }>().id;
    // Оркестратор сообщает о запуске через шину: событие приходит в ядро (REQ-001-4).
    await first.core.ingestEvent({
      id: randomUUID(),
      swarmId,
      ts: '2026-10-29T10:00:00.000Z',
      source: 'orchestrator',
      agentId: null,
      traceId: null,
      type: 'swarm.started',
      data: {},
    });
    const beforeView = await first.app.inject({ method: 'GET', url: `/swarms/${swarmId}` });
    expect(beforeView.json()).toMatchObject({ status: 'running' });
    const eventsBefore = (
      await first.app.inject({ method: 'GET', url: `/swarms/${swarmId}/events` })
    ).json<unknown[]>();
    expect(eventsBefore).toHaveLength(2);
    await stop(first);

    const second = await start(orchestrator);

    const list = await second.app.inject({ method: 'GET', url: '/swarms' });
    expect(list.json()).toEqual([expect.objectContaining({ id: swarmId, status: 'failed' })]);
    const after = await second.app.inject({ method: 'GET', url: `/swarms/${swarmId}` });
    expect(after.json()).toMatchObject({
      id: swarmId,
      status: 'failed',
      failure: { reason: 'api_restarted' },
    });
    const eventsAfter = (
      await second.app.inject({ method: 'GET', url: `/swarms/${swarmId}/events` })
    ).json<{ type: string; data: unknown }[]>();
    expect(eventsAfter.slice(0, 2)).toEqual(eventsBefore);
    expect(eventsAfter[2]).toMatchObject({
      type: 'swarm.failed',
      data: { reason: 'api_restarted' },
    });
    expect(stopped).toEqual([swarmId]);
    await stop(second);
  });
});
