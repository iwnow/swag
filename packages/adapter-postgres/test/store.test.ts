import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectSwarm } from '@swag/api-integration';
import type { PlatformEvent, PlatformEventInput } from '@swag/contracts';
import { createPostgresSwarmStore, runMigrations } from '../src/index.ts';

// Нужен запущенный Postgres: POSTGRES_TEST_URL (compose или сервис в CI). Схема создаётся на время файла.
const url = process.env['POSTGRES_TEST_URL'];

const envelope = (swarmId: string) => ({
  id: randomUUID(),
  swarmId,
  ts: '2026-10-29T10:00:00.000Z',
  traceId: null,
});
const created = (swarmId: string): PlatformEventInput => ({
  ...envelope(swarmId),
  source: 'api',
  agentId: null,
  type: 'swarm.created',
  data: {
    task: 'T',
    agents: [{ id: 'agent-1', name: 'A', role: 'r1', model: 'chat-small' }],
  },
});
const started = (swarmId: string): PlatformEventInput => ({
  ...envelope(swarmId),
  source: 'orchestrator',
  agentId: null,
  type: 'swarm.started',
  data: {},
});
const message = (swarmId: string): PlatformEventInput => ({
  ...envelope(swarmId),
  source: 'api',
  agentId: null,
  type: 'bus.message',
  data: { messageId: randomUUID(), from: 'user', to: 'agent-1', text: 'привет' },
});
const withSeq = (input: PlatformEventInput, seq: number): PlatformEvent =>
  ({ ...input, seq }) as PlatformEvent;

describe.skipIf(!url)('adapter-postgres хранилище роёв', () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const pools: pg.Pool[] = [];
  const newPool = (): pg.Pool => {
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    pools.push(pool);
    return pool;
  };
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url ?? '' });
    await admin.connect();
    await admin.query(`create schema ${schema}`);
    await runMigrations(url ?? '', { schema });
  });

  afterAll(async () => {
    await Promise.allSettled(pools.map((pool) => pool.end()));
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });

  it('AC-003-2: события по порядку, проекция совпадает, повтор seq ничего не меняет', async () => {
    const store = createPostgresSwarmStore(newPool());
    const swarmId = randomUUID();
    const events = [
      withSeq(created(swarmId), 1),
      withSeq(started(swarmId), 2),
      withSeq(message(swarmId), 3),
    ];
    for (const event of events) await store.appendEvent(event);

    expect(await store.events(swarmId, 0)).toEqual(events);
    expect(await store.events(swarmId, 2)).toEqual([events[2]]);
    expect(await store.view(swarmId)).toEqual(projectSwarm(events));
    expect((await store.views()).map((view) => view.id)).toContain(swarmId);

    await store.appendEvent(withSeq(started(swarmId), 2));

    expect(await store.events(swarmId, 0)).toEqual(events);
    expect(await store.view(swarmId)).toEqual(projectSwarm(events));
  });

  it('AC-003-2: событие до swarm.created — reject, в таблицах для роя нет строк', async () => {
    const store = createPostgresSwarmStore(newPool());
    const swarmId = randomUUID();

    await expect(store.appendEvent(withSeq(started(swarmId), 1))).rejects.toThrow();

    const counts = await admin.query<{ swarms: number; events: number }>(
      `select (select count(*) from ${schema}.swarms where id = $1)::int as swarms,
              (select count(*) from ${schema}.swarm_events where swarm_id = $1)::int as events`,
      [swarmId],
    );
    expect(counts.rows[0]).toEqual({ swarms: 0, events: 0 });
    expect(await store.view(swarmId)).toBeNull();
  });

  it('AC-003-2: swarmId не UUID — view null, events пустой список', async () => {
    const store = createPostgresSwarmStore(newPool());

    expect(await store.view('не-uuid')).toBeNull();
    expect(await store.events('не-uuid', 0)).toEqual([]);
  });

  it('AC-003-3: данные читаются через новый пул и новый store после закрытия старого', async () => {
    const swarmId = randomUUID();
    const events = [withSeq(created(swarmId), 1), withSeq(started(swarmId), 2)];

    const first = newPool();
    const writer = createPostgresSwarmStore(first);
    for (const event of events) await writer.appendEvent(event);
    await first.end();

    const reader = createPostgresSwarmStore(newPool());
    expect(await reader.view(swarmId)).toEqual(projectSwarm(events));
    expect((await reader.views()).map((view) => view.id)).toContain(swarmId);
    expect(await reader.events(swarmId, 0)).toEqual(events);
  });
});
