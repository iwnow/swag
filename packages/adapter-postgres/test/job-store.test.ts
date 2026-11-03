import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobRecord, RunRecord } from '@swag/scheduler-core';
import { jobStoreCases } from '../../adapter-memory/test/job-store.cases.ts';
import { createPostgresJobStore, runMigrations } from '../src/index.ts';

// Нужен запущенный Postgres: POSTGRES_TEST_URL из .env. Схема создаётся на время файла (спека 033, 4.7, 4.8).
// Второй пул — второе соединение к той же схеме для проверки skip locked (AC-033-11).
const url = process.env['POSTGRES_TEST_URL'];

const at = (second: number): string => new Date(Date.UTC(2026, 10, 3, 10, 0, second)).toISOString();

const jobOf = (processId: string, nextRunAt: string): JobRecord => ({
  processId,
  spec: {
    orgId: randomUUID(),
    createdBy: randomUUID(),
    trigger: null,
    pollIntervalSec: 60,
    maxConcurrent: 1,
  },
  enabled: true,
  disabledReason: null,
  cursor: null,
  nextRunAt,
  lastPollAt: null,
  lastError: null,
  consecutiveFailures: 0,
  updatedAt: at(0),
});

const runOf = (processId: string, id: string, createdAt: string): RunRecord => ({
  id,
  processId,
  orgId: randomUUID(),
  status: 'queued',
  reason: null,
  source: 'trigger',
  event: { n: 1 },
  createdAt,
  launchedAt: null,
  finishedAt: null,
});

describe.skipIf(!url)('adapter-postgres хранилище заданий', () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let second: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url ?? '' });
    await admin.connect();
    await admin.query(`create schema ${schema}`);
    await runMigrations(url ?? '', { schema });
    const options = `-c search_path=${schema}`;
    pool = new pg.Pool({ connectionString: url, max: 10, options });
    second = new pg.Pool({ connectionString: url, max: 10, options });
  });

  afterAll(async () => {
    await pool.end();
    await second.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });

  jobStoreCases(
    'postgres',
    () => createPostgresJobStore(pool),
    () => createPostgresJobStore(second),
  );

  // Детерминированная проверка skip locked: строка заблокирована открытой транзакцией второго соединения.
  // Без skip locked вызов ждал бы блокировку и не уложился бы в таймаут теста.
  it('AC-033-11: claimDue пропускает строку, заблокированную другим соединением (skip locked)', async () => {
    const store = createPostgresJobStore(pool);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const [locked, ...free] = ids;
    try {
      for (const [i, id] of ids.entries()) await store.put(jobOf(id, at(i + 1)));

      const holder = await second.connect();
      try {
        await holder.query('begin');
        await holder.query('select 1 from scheduler_jobs where process_id = $1 for update', [
          locked,
        ]);
        const claimed = await store.claimDue(at(30), at(150), 1000);
        expect(claimed.map((job) => job.processId).filter((id) => ids.includes(id))).toEqual(free);
      } finally {
        await holder.query('rollback');
        holder.release();
      }

      const again = await store.claimDue(at(30), at(150), 1000);
      expect(again.map((job) => job.processId).filter((id) => ids.includes(id))).toEqual([locked]);
    } finally {
      for (const id of ids) await store.delete(id);
    }
  }, 5000);

  it('AC-033-11: takeQueued пропускает запуск, заблокированный другим соединением (skip locked)', async () => {
    const store = createPostgresJobStore(pool);
    const processId = randomUUID();
    const runIds = [randomUUID(), randomUUID(), randomUUID()];
    const [locked, ...free] = runIds;
    try {
      await store.put(jobOf(processId, at(0)));
      for (const [i, id] of runIds.entries()) await store.enqueue(runOf(processId, id, at(i + 1)));

      const holder = await second.connect();
      try {
        await holder.query('begin');
        await holder.query('select 1 from process_runs where id = $1 for update', [locked]);
        const taken = await store.takeQueued(1000);
        expect(taken.map((run) => run.id).filter((id) => runIds.includes(id))).toEqual(free);
      } finally {
        await holder.query('rollback');
        holder.release();
      }

      const again = await store.takeQueued(1000);
      expect(again.map((run) => run.id).filter((id) => runIds.includes(id))).toEqual([locked]);
    } finally {
      await store.delete(processId);
    }
  }, 5000);
});
