import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformEvent, PlatformEventInput } from '@swag/contracts';
import { createPostgresSwarmStore, runMigrations } from '../src/index.ts';

// Запуск: POSTGRES_TEST_URL и POSTGRES_BENCH=1. Порога нет: замер выводится в консоль (NFR-003-2).
const url = process.env['POSTGRES_TEST_URL'];

const quantile = (sorted: number[], q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? NaN;

describe.skipIf(!url || process.env['POSTGRES_BENCH'] !== '1')('adapter-postgres бенч', () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Client;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url ?? '' });
    await admin.connect();
    await admin.query(`create schema ${schema}`);
    await runMigrations(url ?? '', { schema });
    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });

  it('NFR-003-2: 1000 событий одного роя, замер appendEvent (p50, p95)', async () => {
    const store = createPostgresSwarmStore(pool);
    const swarmId = randomUUID();
    const envelope = () => ({
      id: randomUUID(),
      swarmId,
      ts: '2026-10-29T10:00:00.000Z',
      traceId: null,
    });
    const inputs: PlatformEventInput[] = [
      {
        ...envelope(),
        source: 'api',
        agentId: null,
        type: 'swarm.created',
        data: {
          task: 'T',
          agents: [{ id: 'agent-1', name: 'A', role: 'r1', model: 'chat-small' }],
        },
      },
      { ...envelope(), source: 'orchestrator', agentId: null, type: 'swarm.started', data: {} },
    ];
    while (inputs.length < 1000) {
      inputs.push({
        ...envelope(),
        source: 'api',
        agentId: null,
        type: 'bus.message',
        data: {
          messageId: randomUUID(),
          from: 'user',
          to: 'agent-1',
          text: `сообщение ${inputs.length}`,
        },
      });
    }

    const timings: number[] = [];
    for (const [index, input] of inputs.entries()) {
      const event = { ...input, seq: index + 1 } as PlatformEvent;
      const started = performance.now();
      await store.appendEvent(event);
      timings.push(performance.now() - started);
    }

    const sorted = [...timings].sort((a, b) => a - b);
    process.stdout.write(
      `NFR-003-2: событий=${timings.length} p50=${quantile(sorted, 0.5).toFixed(2)} мс p95=${quantile(sorted, 0.95).toFixed(2)} мс\n`,
    );
    expect(timings).toHaveLength(1000);
  }, 600_000);
});
