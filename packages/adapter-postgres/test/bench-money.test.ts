import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LedgerEntry } from '@swag/llm-gateway-core';
import { createPostgresBudgetStore, runMigrations } from '../src/index.ts';

// Запуск: POSTGRES_TEST_URL и POSTGRES_BENCH=1. Порога нет: замер выводится в stdout (NFR-004-1, как NFR-003-2).
const url = process.env['POSTGRES_TEST_URL'];
const PAIRS = 1000;
const THREADS = 10;

const quantile = (sorted: number[], q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? NaN;

describe.skipIf(!url || process.env['POSTGRES_BENCH'] !== '1')(
  'adapter-postgres бенч денег',
  () => {
    const schema = `test_${randomUUID().replaceAll('-', '')}`;
    let admin: pg.Client;
    let pool: pg.Pool;

    beforeAll(async () => {
      admin = new pg.Client({ connectionString: url ?? '' });
      await admin.connect();
      await admin.query(`create schema ${schema}`);
      await runMigrations(url ?? '', { schema });
      pool = new pg.Pool({
        connectionString: url,
        max: THREADS,
        options: `-c search_path=${schema}`,
      });
    });

    afterAll(async () => {
      await pool?.end();
      await admin?.query(`drop schema if exists ${schema} cascade`);
      await admin?.end();
    });

    it('NFR-004-1: 1000 пар reserve+settle последовательно и 1000 пар в 10 потоках одного роя (p50, p95)', async () => {
      const store = createPostgresBudgetStore(pool);
      const swarmId = randomUUID();
      const agentId = 'agent-1';
      await store.register(
        {
          swarmId,
          budgetMicroUsd: 1_000_000_000,
          expiresAt: null,
          agents: [{ agentId, model: 'chat-small', budgetMicroUsd: null }],
        },
        new Date(),
      );

      const pair = async (): Promise<number> => {
        const callId = randomUUID();
        const started = performance.now();
        const reserved = await store.reserve(callId, { swarmId, agentId }, 1000, new Date());
        if (!reserved.ok) throw new Error(`reserve отказал: ${reserved.code}`);
        const settled: LedgerEntry = {
          callId,
          ts: new Date().toISOString(),
          swarmId,
          agentId,
          model: 'chat-small',
          kind: 'llm',
          amountMicroUsd: 700,
          basis: 'usage',
          providerCostMicroUsd: null,
        };
        await store.settle(settled);
        return performance.now() - started;
      };

      const sequential: number[] = [];
      for (let index = 0; index < PAIRS; index += 1) sequential.push(await pair());

      const concurrent: number[] = [];
      const perThread = PAIRS / THREADS;
      await Promise.all(
        Array.from({ length: THREADS }, async () => {
          for (let index = 0; index < perThread; index += 1) concurrent.push(await pair());
        }),
      );

      const report = (label: string, timings: number[]): void => {
        const sorted = [...timings].sort((a, b) => a - b);
        process.stdout.write(
          `NFR-004-1 ${label}: пар=${timings.length} p50=${quantile(sorted, 0.5).toFixed(2)} мс p95=${quantile(sorted, 0.95).toFixed(2)} мс\n`,
        );
      };
      report('последовательно', sequential);
      report(`${THREADS} потоков`, concurrent);
      expect(sequential).toHaveLength(PAIRS);
      expect(concurrent).toHaveLength(PAIRS);
    }, 600_000);
  },
);
