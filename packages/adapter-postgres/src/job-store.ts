import type { JobRecord, JobStore, RunRecord } from '@swag/scheduler-core';
import type { Pool } from 'pg';
import { transact } from './transact.ts';

// Спека 033, 4.7 и 4.8: задания и запуски планировщика. Аренда (lease_until) живёт только в таблице: в JobRecord её нет.
// RETURNING порядок не гарантирует, поэтому claimDue и takeQueued сортируют результат здесь (как память).
type JobRow = {
  process_id: string;
  spec: JobRecord['spec'];
  enabled: boolean;
  disabled_reason: JobRecord['disabledReason'];
  cursor: string | null;
  next_run_at: Date | null;
  last_poll_at: Date | null;
  last_error: JobRecord['lastError'];
  consecutive_failures: number;
  updated_at: Date;
};

type RunRow = {
  id: string;
  process_id: string;
  org_id: string;
  status: RunRecord['status'];
  reason: RunRecord['reason'];
  source: RunRecord['source'];
  event: unknown;
  created_at: Date;
  launched_at: Date | null;
  finished_at: Date | null;
};

const JOB_COLUMNS =
  'process_id, spec, enabled, disabled_reason, cursor, next_run_at, last_poll_at, last_error, consecutive_failures, updated_at';
const RUN_COLUMNS =
  'id, process_id, org_id, status, reason, source, event, created_at, launched_at, finished_at';
const INSERT_RUN = `insert into process_runs (${RUN_COLUMNS}) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;
const json = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value);
const byTime = (value: Date | null): number => value?.getTime() ?? Infinity;

const toJob = (row: JobRow): JobRecord => ({
  processId: row.process_id,
  spec: row.spec,
  enabled: row.enabled,
  disabledReason: row.disabled_reason,
  cursor: row.cursor,
  nextRunAt: iso(row.next_run_at),
  lastPollAt: iso(row.last_poll_at),
  lastError: row.last_error,
  consecutiveFailures: row.consecutive_failures,
  updatedAt: row.updated_at.toISOString(),
});

const toRun = (row: RunRow): RunRecord => ({
  id: row.id,
  processId: row.process_id,
  orgId: row.org_id,
  status: row.status,
  reason: row.reason,
  source: row.source,
  event: row.event,
  createdAt: row.created_at.toISOString(),
  launchedAt: iso(row.launched_at),
  finishedAt: iso(row.finished_at),
});

const runParams = (run: RunRecord): unknown[] => [
  run.id,
  run.processId,
  run.orgId,
  run.status,
  run.reason,
  run.source,
  json(run.event),
  run.createdAt,
  run.launchedAt,
  run.finishedAt,
];

export function createPostgresJobStore(pool: Pool): JobStore {
  return {
    async put(record) {
      await pool.query(
        `insert into scheduler_jobs (${JOB_COLUMNS}, lease_until)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, null)
         on conflict (process_id) do update set
           spec = excluded.spec, enabled = excluded.enabled, disabled_reason = excluded.disabled_reason,
           cursor = excluded.cursor, next_run_at = excluded.next_run_at, last_poll_at = excluded.last_poll_at,
           last_error = excluded.last_error, consecutive_failures = excluded.consecutive_failures,
           updated_at = excluded.updated_at`,
        [
          record.processId,
          json(record.spec),
          record.enabled,
          record.disabledReason,
          record.cursor,
          record.nextRunAt,
          record.lastPollAt,
          json(record.lastError),
          record.consecutiveFailures,
          record.updatedAt,
        ],
      );
    },

    async get(processId) {
      const { rows } = await pool.query<JobRow>(
        `select ${JOB_COLUMNS} from scheduler_jobs where process_id = $1`,
        [processId],
      );
      return rows[0] ? toJob(rows[0]) : null;
    },

    async getMany(processIds) {
      const { rows } = await pool.query<JobRow>(
        `select ${JOB_COLUMNS} from scheduler_jobs where process_id = any($1::uuid[])`,
        [processIds],
      );
      const byId = new Map(rows.map((row) => [row.process_id, toJob(row)]));
      return processIds.flatMap((id) => {
        const job = byId.get(id);
        return job ? [job] : [];
      });
    },

    async delete(processId) {
      const result = await pool.query('delete from scheduler_jobs where process_id = $1', [
        processId,
      ]);
      return (result.rowCount ?? 0) > 0;
    },

    async claimDue(now, leaseUntil, limit) {
      const { rows } = await pool.query<JobRow>(
        `update scheduler_jobs set lease_until = $2
         where process_id in (
           select process_id from scheduler_jobs
           where enabled and next_run_at <= $1 and (lease_until is null or lease_until < $1)
           order by next_run_at limit $3 for update skip locked)
         returning ${JOB_COLUMNS}`,
        [now, leaseUntil, limit],
      );
      return rows.sort((a, b) => byTime(a.next_run_at) - byTime(b.next_run_at)).map(toJob);
    },

    async recordTick(processId, tick) {
      await transact(pool, async (client) => {
        const result = await client.query(
          `update scheduler_jobs set cursor = $2, next_run_at = $3, last_poll_at = $4, last_error = $5,
             consecutive_failures = $6, enabled = $7, disabled_reason = $8, lease_until = null
           where process_id = $1`,
          [
            processId,
            tick.cursor,
            tick.nextRunAt,
            tick.lastPollAt,
            json(tick.lastError),
            tick.consecutiveFailures,
            tick.enabled,
            tick.disabledReason,
          ],
        );
        if (!result.rowCount) throw new Error('job not found');
        for (const run of tick.enqueue) await client.query(INSERT_RUN, runParams(run));
        return { commit: true, value: undefined };
      });
    },

    async enqueue(run) {
      await pool.query(INSERT_RUN, runParams(run));
    },

    async counts(processIds) {
      const { rows } = await pool.query<{ process_id: string; queued: number; running: number }>(
        `select process_id,
           count(*) filter (where status in ('queued', 'launching'))::int as queued,
           count(*) filter (where status = 'running')::int as running
         from process_runs where process_id = any($1::uuid[]) group by process_id`,
        [processIds],
      );
      const found = new Map(
        rows.map((row) => [row.process_id, { queued: row.queued, running: row.running }]),
      );
      return new Map(processIds.map((id) => [id, found.get(id) ?? { queued: 0, running: 0 }]));
    },

    async takeQueued(limit) {
      const { rows } = await pool.query<RunRow>(
        `update process_runs set status = 'launching'
         where id in (
           select id from process_runs where status = 'queued'
           order by created_at limit $1 for update skip locked)
         returning ${RUN_COLUMNS}`,
        [limit],
      );
      return rows.map(toRun).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    },

    async setRun(id, patch) {
      await pool.query(
        `update process_runs set
           status = $2::text,
           reason = case when $3::boolean then $4::text else reason end,
           launched_at = coalesce($5::timestamptz, launched_at),
           finished_at = coalesce($6::timestamptz, finished_at),
           event = case when $2::text in ('queued', 'launching') then event else null end
         where id = $1`,
        [
          id,
          patch.status,
          patch.reason !== undefined,
          patch.reason ?? null,
          patch.launchedAt ?? null,
          patch.finishedAt ?? null,
        ],
      );
    },

    async cancelQueued(processId) {
      const result = await pool.query(
        `update process_runs set status = 'cancelled', event = null where process_id = $1 and status = 'queued'`,
        [processId],
      );
      return result.rowCount ?? 0;
    },

    async byStatus(status, limit) {
      const { rows } = await pool.query<RunRow>(
        `select ${RUN_COLUMNS} from process_runs where status = $1 order by created_at limit $2`,
        [status, limit],
      );
      return rows.map(toRun);
    },

    async runs(processId, limit) {
      const { rows } = await pool.query<RunRow>(
        `select ${RUN_COLUMNS} from process_runs where process_id = $1 order by created_at desc limit $2`,
        [processId, limit],
      );
      return rows.map(toRun);
    },
  };
}
