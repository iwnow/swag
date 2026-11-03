import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ProcessDraft } from '@swag/contracts';
import type { ProcessRecord, ProcessStore } from '@swag/api-core';

// Спека 033, 4.6, 4.8 и AC-033-11: общий набор сценариев CRUD хранилища процессов. Вызывают его тест памяти
// (process-store.test.ts здесь) и тест Postgres (adapter-postgres/test/process-store.test.ts, T-11).
// Процессы — свои uuid. На общей базе чужие процессы попадают в list(null), поэтому проверки идут по своим id.
// makeOwner даёт организацию и автора: в Postgres у processes внешние ключи на organizations и users.

type Owner = { orgId: string; createdBy: string };

const at = (second: number): string => new Date(Date.UTC(2026, 10, 3, 10, 0, second)).toISOString();

const defaultOwner = (): Owner => ({ orgId: randomUUID(), createdBy: randomUUID() });

const draft = (name: string): ProcessDraft => ({
  name,
  graph: {
    nodes: [{ id: 'echo', type: 'example/echo@1.0.0', settings: {}, credentials: {} }],
    edges: [],
    entry: 'echo',
    exit: 'echo',
  },
  budgetMicroUsd: 1_000,
  maxTokens: null,
  pollIntervalSec: 300,
  maxConcurrent: 1,
});

const record = (
  owner: Owner,
  overrides: Partial<Omit<ProcessRecord, 'orgId' | 'createdBy'>> = {},
): ProcessRecord => ({
  id: randomUUID(),
  orgId: owner.orgId,
  createdBy: owner.createdBy,
  definition: draft('Процесс'),
  createdAt: at(0),
  updatedAt: at(0),
  ...overrides,
});

export function processStoreCases(
  name: string,
  makeStore: () => ProcessStore | Promise<ProcessStore>,
  makeOwner: () => Owner | Promise<Owner> = defaultOwner,
): void {
  describe(`${name}: хранилище процессов`, () => {
    it('AC-033-11: create и get отдают копию определения; get неизвестного — null', async () => {
      const store = await makeStore();
      const owner = await makeOwner();
      const created = record(owner, { definition: draft('Сверка') });
      await store.create(created);

      expect(await store.get(created.id)).toEqual(created);
      expect(await store.get(randomUUID())).toBeNull();

      const got = await store.get(created.id);
      if (got) got.definition.name = 'изменено';
      expect((await store.get(created.id))?.definition.name).toBe('Сверка');
    });

    it('AC-033-11: update заменяет запись целиком; update неизвестного процесса бросает', async () => {
      const store = await makeStore();
      const owner = await makeOwner();
      const original = record(owner);
      await store.create(original);

      const updated = { ...original, definition: draft('Новое имя'), updatedAt: at(5) };
      await store.update(updated);
      expect(await store.get(original.id)).toEqual(updated);

      await expect(store.update(record(owner))).rejects.toThrow();
    });

    it('AC-033-11: list(orgId) отдаёт процессы только своей организации по updatedAt по убыванию', async () => {
      const store = await makeStore();
      const mine = await makeOwner();
      const other = await makeOwner();
      const older = record(mine, { updatedAt: at(1) });
      const newer = record(mine, { updatedAt: at(3) });
      const foreign = record(other, { updatedAt: at(2) });
      for (const item of [older, foreign, newer]) await store.create(item);

      const page = await store.list(mine.orgId);
      expect(page.map((item) => item.id)).toEqual([newer.id, older.id]);
    });

    it('AC-033-11: list(null) отдаёт процессы всех организаций', async () => {
      const store = await makeStore();
      const first = record(await makeOwner());
      const second = record(await makeOwner());
      await store.create(first);
      await store.create(second);

      const ids = (await store.list(null)).map((item) => item.id);
      expect(ids).toEqual(expect.arrayContaining([first.id, second.id]));
    });

    it('AC-033-11: count считает процессы организации', async () => {
      const store = await makeStore();
      const mine = await makeOwner();
      const other = await makeOwner();
      await store.create(record(mine));
      await store.create(record(mine));
      await store.create(record(other));

      expect(await store.count(mine.orgId)).toBe(2);
      expect(await store.count(other.orgId)).toBe(1);
    });

    it('AC-033-11: delete возвращает true один раз, потом false, запись пропадает', async () => {
      const store = await makeStore();
      const owner = await makeOwner();
      const item = record(owner);
      await store.create(item);

      expect(await store.delete(item.id)).toBe(true);
      expect(await store.get(item.id)).toBeNull();
      expect(await store.delete(item.id)).toBe(false);
    });
  });
}
