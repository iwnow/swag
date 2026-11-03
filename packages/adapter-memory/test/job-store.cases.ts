import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobRecord, JobStore, RunRecord, TickRecord } from '@swag/scheduler-core';

// Спека 033, 4.7, 4.8 и AC-033-11: общий набор сценариев хранилища заданий и запусков. Вызывают его тест памяти
// (job-store.test.ts здесь) и тест Postgres (adapter-postgres/test/job-store.test.ts, T-11).
// Задания и запуски — свои uuid. На общей базе чужие записи могут попасть в выборку, поэтому проверки
// идут по своим id, а лимит проверяется по длине выборки, когда своих записей хватает на лимит.
// Каждое задание, созданное через putJob, удаляется в afterEach (запуски уходят каскадом), чтобы база не копила мусор.
// makeSecond даёт второе соединение к тем же данным (для памяти — тот же объект).

const at = (second: number): string => new Date(Date.UTC(2026, 10, 3, 10, 0, second)).toISOString();

const job = (processId = randomUUID(), overrides: Partial<JobRecord> = {}): JobRecord => ({
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
  nextRunAt: at(0),
  lastPollAt: null,
  lastError: null,
  consecutiveFailures: 0,
  updatedAt: at(0),
  ...overrides,
});

const run = (processId: string, overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: randomUUID(),
  processId,
  orgId: randomUUID(),
  status: 'queued',
  reason: null,
  source: 'trigger',
  event: { n: 1 },
  createdAt: at(0),
  launchedAt: null,
  finishedAt: null,
  ...overrides,
});

const tick = (overrides: Partial<TickRecord> = {}): TickRecord => ({
  cursor: null,
  nextRunAt: at(60),
  lastPollAt: at(0),
  lastError: null,
  consecutiveFailures: 0,
  enabled: true,
  disabledReason: null,
  enqueue: [],
  ...overrides,
});

const ours = (items: { processId: string }[], ids: readonly string[]): string[] =>
  items.filter((item) => ids.includes(item.processId)).map((item) => item.processId);

const oneRun = async (store: JobStore, processId: string, runId: string) =>
  (await store.runs(processId, 1000)).find((item) => item.id === runId);

// Контракт порядка выдачи для адаптера: claimDue — по nextRunAt; takeQueued, byStatus — по createdAt;
// runs — по createdAt по убыванию. RETURNING в Postgres порядок не гарантирует, адаптер Postgres сортирует сам (T-11).
// Контракт записей: counts содержит запись для каждого запрошенного id (нули для пустых); даты в записях — ISO-строки
// toISOString(). Тест двух соединений на Postgres идёт через makeSecond на втором соединении пула.
export function jobStoreCases(
  name: string,
  makeStore: () => JobStore | Promise<JobStore>,
  makeSecond: (first: JobStore) => JobStore = (first) => first,
): void {
  describe(`${name}: хранилище заданий и запусков`, () => {
    const created: { store: JobStore; processId: string }[] = [];
    const putJob = async (store: JobStore, record: JobRecord): Promise<void> => {
      await store.put(record);
      created.push({ store, processId: record.processId });
    };

    afterEach(async () => {
      for (const { store, processId } of created.splice(0)) await store.delete(processId);
    });

    it('AC-033-11: put создаёт задание, get и getMany отдают копию, put заменяет запись целиком', async () => {
      const store = await makeStore();
      const id = randomUUID();
      const record = job(id, { cursor: 'c1', consecutiveFailures: 2 });
      await putJob(store, record);

      expect(await store.get(id)).toEqual(record);
      expect(await store.get(randomUUID())).toBeNull();
      expect(await store.getMany([id, randomUUID()])).toEqual([record]);

      const got = await store.get(id);
      if (got) got.cursor = 'changed';
      expect((await store.get(id))?.cursor).toBe('c1');

      const replaced = job(id, { cursor: null, enabled: false, disabledReason: 'user' });
      await putJob(store, replaced);
      expect(await store.get(id)).toEqual(replaced);
    });

    it('AC-033-11: delete удаляет задание и его запуски каскадом, повторный delete — false', async () => {
      const store = await makeStore();
      const id = randomUUID();
      const sibling = randomUUID();
      await putJob(store, job(id));
      await putJob(store, job(sibling));
      await store.enqueue(run(id));
      const kept = run(sibling);
      await store.enqueue(kept);

      expect(await store.delete(id)).toBe(true);
      expect(await store.get(id)).toBeNull();
      expect(await store.runs(id, 10)).toEqual([]);
      expect(await store.delete(id)).toBe(false);
      expect(await store.runs(sibling, 10)).toEqual([kept]);
    });

    it('AC-033-11: claimDue отдаёт только включённые готовые задания по nextRunAt', async () => {
      const store = await makeStore();
      const late = randomUUID();
      const early = randomUUID();
      const notYet = randomUUID();
      const disabled = randomUUID();
      const unscheduled = randomUUID();
      const ids = [late, early, notYet, disabled, unscheduled];
      await putJob(store, job(late, { nextRunAt: at(20) }));
      await putJob(store, job(early, { nextRunAt: at(10) }));
      await putJob(store, job(notYet, { nextRunAt: at(40) }));
      await putJob(
        store,
        job(disabled, { enabled: false, disabledReason: 'user', nextRunAt: at(5) }),
      );
      await putJob(store, job(unscheduled, { nextRunAt: null }));

      const claimed = await store.claimDue(at(30), at(150), 1000);
      expect(ours(claimed, ids)).toEqual([early, late]);
    });

    it('AC-033-11: claimDue не отдаёт больше limit заданий', async () => {
      const store = await makeStore();
      for (let i = 0; i < 3; i++) await putJob(store, job(randomUUID(), { nextRunAt: at(i) }));

      expect(await store.claimDue(at(30), at(150), 1)).toHaveLength(1);
    });

    it('AC-033-11: claimDue ставит аренду — повтор до её истечения не отдаёт задание, после — отдаёт', async () => {
      const store = await makeStore();
      const id = randomUUID();
      await putJob(store, job(id));

      expect(ours(await store.claimDue(at(1), at(61), 1000), [id])).toEqual([id]);
      expect(ours(await store.claimDue(at(30), at(90), 1000), [id])).toEqual([]);
      expect(ours(await store.claimDue(at(61), at(121), 1000), [id])).toEqual([]);
      expect(ours(await store.claimDue(at(62), at(122), 1000), [id])).toEqual([id]);
    });

    it('AC-033-11: put под арендой аренду не снимает, delete и новый put того же id — снимают', async () => {
      const store = await makeStore();
      const id = randomUUID();
      const original = job(id);
      await putJob(store, original);
      expect(ours(await store.claimDue(at(1), at(61), 1000), [id])).toEqual([id]);

      await putJob(store, job(id, { spec: { ...original.spec, pollIntervalSec: 120 } }));
      expect((await store.get(id))?.spec.pollIntervalSec).toBe(120);
      expect(ours(await store.claimDue(at(30), at(90), 1000), [id])).toEqual([]);

      await store.delete(id);
      await putJob(store, job(id));
      expect(ours(await store.claimDue(at(30), at(90), 1000), [id])).toEqual([id]);
    });

    it('AC-033-11: два соединения claimDue не отдают задание дважды (skip locked)', async () => {
      const first = await makeStore();
      const second = makeSecond(first);
      const ids = Array.from({ length: 10 }, () => randomUUID());
      for (const id of ids) await putJob(first, job(id));

      const [a, b] = await Promise.all([
        first.claimDue(at(1), at(61), 1000),
        second.claimDue(at(1), at(61), 1000),
      ]);
      const got = [...ours(a, ids), ...ours(b, ids)];
      expect(new Set(got).size).toBe(got.length);
      expect([...got].sort()).toEqual([...ids].sort());
    });

    it('AC-033-11: recordTick пишет курсор и поля, снимает аренду и ставит запуски', async () => {
      const store = await makeStore();
      const id = randomUUID();
      await putJob(store, job(id));
      expect(ours(await store.claimDue(at(1), at(61), 1000), [id])).toEqual([id]);

      const queued = run(id, { createdAt: at(2) });
      await store.recordTick(
        id,
        tick({
          cursor: 'c2',
          nextRunAt: at(1),
          lastPollAt: at(1),
          consecutiveFailures: 0,
          enqueue: [queued],
        }),
      );

      expect(await store.get(id)).toMatchObject({
        cursor: 'c2',
        nextRunAt: at(1),
        lastPollAt: at(1),
        lastError: null,
        consecutiveFailures: 0,
        enabled: true,
      });
      expect(await store.runs(id, 10)).toEqual([queued]);
      expect(ours(await store.claimDue(at(2), at(62), 1000), [id])).toEqual([id]); // аренда снята
    });

    it('AC-033-11: recordTick с занятым id запуска бросает и не меняет курсор и запуски', async () => {
      const store = await makeStore();
      const id = randomUUID();
      await putJob(store, job(id));
      const existing = run(id);
      await store.enqueue(existing);

      await expect(
        store.recordTick(id, tick({ cursor: 'c9', enqueue: [run(id, { id: existing.id })] })),
      ).rejects.toThrow();
      expect((await store.get(id))?.cursor).toBeNull();
      expect(await store.runs(id, 10)).toEqual([existing]);
    });

    it('AC-033-11: enqueue без задания бросает; counts считает queued вместе с launching и running отдельно', async () => {
      const store = await makeStore();
      const id = randomUUID();
      const empty = randomUUID();
      await putJob(store, job(id));
      await expect(store.enqueue(run(randomUUID()))).rejects.toThrow();

      const first = run(id, { createdAt: at(1) });
      const second = run(id, { createdAt: at(2) });
      const third = run(id, { createdAt: at(3) });
      for (const item of [first, second, third]) await store.enqueue(item);
      await store.setRun(first.id, { status: 'launching' });
      await store.setRun(second.id, { status: 'running', launchedAt: at(4) });

      const counts = await store.counts([id, empty]);
      expect(counts.get(id)).toEqual({ queued: 2, running: 1 });
      expect(counts.get(empty)).toEqual({ queued: 0, running: 0 });
    });

    it('AC-033-11: setRun без reason, launchedAt и finishedAt не затирает прежние значения; reason: null затирает', async () => {
      const store = await makeStore();
      const id = randomUUID();
      await putJob(store, job(id));
      const rejected = run(id, { createdAt: at(1) });
      const started = run(id, { createdAt: at(2) });
      await store.enqueue(rejected);
      await store.enqueue(started);

      await store.setRun(rejected.id, {
        status: 'rejected',
        reason: 'insufficient_balance',
        finishedAt: at(3),
      });
      await store.setRun(rejected.id, { status: 'rejected' });
      expect(await oneRun(store, id, rejected.id)).toMatchObject({
        reason: 'insufficient_balance',
        finishedAt: at(3),
      });
      await store.setRun(rejected.id, { status: 'rejected', reason: null });
      expect(await oneRun(store, id, rejected.id)).toMatchObject({
        reason: null,
        finishedAt: at(3),
      });

      await store.setRun(started.id, { status: 'running', launchedAt: at(4) });
      await store.setRun(started.id, { status: 'running' });
      expect(await oneRun(store, id, started.id)).toMatchObject({ launchedAt: at(4) });
    });

    it('AC-033-11: setRun неизвестного id не бросает и ничего не создаёт', async () => {
      const store = await makeStore();
      const missing = randomUUID();

      await expect(store.setRun(missing, { status: 'running' })).resolves.toBeUndefined();
      expect(await store.byStatus('running', 1000)).not.toContainEqual(
        expect.objectContaining({ id: missing }),
      );
    });

    it('AC-033-11: takeQueued переводит queued в launching по createdAt и не отдаёт запуск повторно', async () => {
      const store = await makeStore();
      const id = randomUUID();
      await putJob(store, job(id));
      const first = run(id, { createdAt: at(1) });
      const second = run(id, { createdAt: at(2) });
      const third = run(id, { createdAt: at(3) });
      for (const item of [third, first, second]) await store.enqueue(item);

      const taken = await store.takeQueued(1000);
      expect(taken.filter((item) => item.processId === id).map((item) => item.id)).toEqual([
        first.id,
        second.id,
        third.id,
      ]);
      expect(taken.find((item) => item.id === first.id)).toMatchObject({
        status: 'launching',
        event: { n: 1 },
      });
      expect(ours(await store.takeQueued(1000), [id])).toEqual([]);
    });

    it('AC-033-11: takeQueued не отдаёт больше limit запусков', async () => {
      const store = await makeStore();
      const id = randomUUID();
      await putJob(store, job(id));
      for (let i = 1; i <= 3; i++) await store.enqueue(run(id, { createdAt: at(i) }));

      expect(await store.takeQueued(2)).toHaveLength(2);
    });

    it('AC-033-11: два соединения takeQueued не отдают запуск дважды', async () => {
      const first = await makeStore();
      const second = makeSecond(first);
      const id = randomUUID();
      await putJob(first, job(id));
      const ids: string[] = Array.from({ length: 10 }, () => randomUUID());
      for (const runId of ids) await first.enqueue(run(id, { id: runId }));

      const [a, b] = await Promise.all([first.takeQueued(1000), second.takeQueued(1000)]);
      const got = [...a, ...b].map((item) => item.id).filter((runId) => ids.includes(runId));
      expect(new Set(got).size).toBe(got.length);
      expect([...got].sort()).toEqual([...ids].sort());
    });

    it('AC-033-11: setRun очищает event вне queued и launching и сохраняет его в launching', async () => {
      const store = await makeStore();
      const id = randomUUID();
      await putJob(store, job(id));
      const started = run(id, { createdAt: at(1) });
      const rejected = run(id, { createdAt: at(2) });
      await store.enqueue(started);
      await store.enqueue(rejected);

      await store.setRun(started.id, { status: 'launching' });
      expect(await oneRun(store, id, started.id)).toMatchObject({
        status: 'launching',
        event: { n: 1 },
      });

      await store.setRun(started.id, { status: 'running', launchedAt: at(3) });
      expect(await oneRun(store, id, started.id)).toMatchObject({
        status: 'running',
        launchedAt: at(3),
        event: null,
      });

      await store.setRun(rejected.id, {
        status: 'rejected',
        reason: 'insufficient_balance',
        finishedAt: at(4),
      });
      expect(await oneRun(store, id, rejected.id)).toMatchObject({
        status: 'rejected',
        reason: 'insufficient_balance',
        finishedAt: at(4),
        event: null,
      });
    });

    it('AC-033-11: cancelQueued отменяет только queued и очищает event', async () => {
      const store = await makeStore();
      const id = randomUUID();
      const other = randomUUID();
      await putJob(store, job(id));
      await putJob(store, job(other));
      const q1 = run(id, { createdAt: at(1) });
      const q2 = run(id, { createdAt: at(2) });
      const l1 = run(id, { createdAt: at(3) });
      const o1 = run(other);
      for (const item of [q1, q2, l1, o1]) await store.enqueue(item);
      await store.setRun(l1.id, { status: 'launching' });

      expect(await store.cancelQueued(id)).toBe(2);
      expect(await oneRun(store, id, q1.id)).toMatchObject({ status: 'cancelled', event: null });
      expect(await oneRun(store, id, q2.id)).toMatchObject({ status: 'cancelled', event: null });
      expect(await oneRun(store, id, l1.id)).toMatchObject({
        status: 'launching',
        event: { n: 1 },
      });
      expect(await oneRun(store, other, o1.id)).toMatchObject({ status: 'queued' });
      expect(await store.cancelQueued(id)).toBe(0);
    });

    it('AC-033-11: byStatus отдаёт запуски заданного статуса', async () => {
      const store = await makeStore();
      const id = randomUUID();
      await putJob(store, job(id));
      const r1 = run(id, { createdAt: at(1) });
      const r2 = run(id, { createdAt: at(2) });
      const r3 = run(id, { createdAt: at(3) });
      for (const item of [r1, r2, r3]) await store.enqueue(item);
      await store.setRun(r1.id, { status: 'running', launchedAt: at(4) });
      await store.setRun(r2.id, { status: 'launching' });

      const running = await store.byStatus('running', 1000);
      expect(running.filter((item) => item.processId === id).map((item) => item.id)).toEqual([
        r1.id,
      ]);
      expect(await store.byStatus('running', 1)).toHaveLength(1);
      const launching = await store.byStatus('launching', 1000);
      expect(launching.filter((item) => item.processId === id).map((item) => item.id)).toEqual([
        r2.id,
      ]);
    });

    it('AC-033-11: runs отдаёт запуски по createdAt по убыванию и не больше limit', async () => {
      const store = await makeStore();
      const id = randomUUID();
      await putJob(store, job(id));
      const r1 = run(id, { createdAt: at(1) });
      const r2 = run(id, { createdAt: at(3) });
      const r3 = run(id, { createdAt: at(2) });
      for (const item of [r1, r2, r3]) await store.enqueue(item);

      expect((await store.runs(id, 2)).map((item) => item.id)).toEqual([r2.id, r3.id]);
    });
  });
}
