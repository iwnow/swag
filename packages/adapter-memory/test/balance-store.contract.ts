import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { BalanceStore } from '@swag/billing-core';

// Спека 013, 4.2 и T-3/T-4: общий набор сценариев хранилища баланса. Вызывают его тест памяти
// (balance-store.test.ts здесь) и тест Postgres (adapter-postgres/test/balance-store.test.ts).
// Только методы BalanceStore; организации и рои — свои uuid, поэтому набор не требует пустой базы.

const ts = (second: number): string => `2026-11-01T10:00:${String(second).padStart(2, '0')}.000Z`;
const topup = (store: BalanceStore, orgId: string, amountMicroUsd: number, second = 0) =>
  store.topup({ orgId, amountMicroUsd, actorId: randomUUID(), comment: null, ts: ts(second) });

export function balanceStoreContract(name: string, makeStore: () => BalanceStore): void {
  describe(`${name}: хранилище баланса`, () => {
    it('AC-013-1: три пополнения дают баланс 600 и три записи topup от новых к старым', async () => {
      const store = makeStore();
      const orgId = randomUUID();
      await topup(store, orgId, 100, 1);
      await topup(store, orgId, 200, 2);
      await topup(store, orgId, 300, 3);

      expect(await store.balance(orgId)).toEqual({ balanceMicroUsd: 600, heldMicroUsd: 0 });
      const page = await store.entries(orgId, null, 10);
      expect(page.hasMore).toBe(false);
      expect(page.entries.map((entry) => [entry.kind, entry.amountMicroUsd])).toEqual([
        ['topup', 300],
        ['topup', 200],
        ['topup', 100],
      ]);
      expect(page.entries[0]?.id).toBeGreaterThan(page.entries[1]?.id ?? Infinity);
    });

    it('AC-013-11: settle пишет запись swarm на сумму трат и возвращает остаток резерва', async () => {
      const store = makeStore();
      const orgId = randomUUID();
      const swarmId = randomUUID();
      await topup(store, orgId, 1_000_000);
      expect(await store.reserve({ orgId, swarmId, amountMicroUsd: 400_000, ts: ts(5) })).toBe(
        'ok',
      );

      const settled = await store.settle(swarmId, 123_456, ts(6));

      expect(settled).toEqual({ orgId, heldMicroUsd: 400_000, chargedMicroUsd: 123_456 });
      expect(await store.balance(orgId)).toEqual({
        balanceMicroUsd: 1_000_000 - 123_456,
        heldMicroUsd: 0,
      });
      const [last] = (await store.entries(orgId, null, 1)).entries;
      expect(last).toMatchObject({
        kind: 'swarm',
        amountMicroUsd: -123_456,
        swarmId,
        actorId: null,
      });
    });

    it('AC-013-11: траты больше резерва списываются в размере резерва', async () => {
      const store = makeStore();
      const orgId = randomUUID();
      const swarmId = randomUUID();
      await topup(store, orgId, 1_000_000);
      await store.reserve({ orgId, swarmId, amountMicroUsd: 400_000, ts: ts(5) });

      expect(await store.settle(swarmId, 500_000, ts(6))).toEqual({
        orgId,
        heldMicroUsd: 400_000,
        chargedMicroUsd: 400_000,
      });
      expect(await store.balance(orgId)).toEqual({ balanceMicroUsd: 600_000, heldMicroUsd: 0 });
    });

    it('AC-013-12: повторный settle возвращает null и ничего не меняет', async () => {
      const store = makeStore();
      const orgId = randomUUID();
      const swarmId = randomUUID();
      await topup(store, orgId, 1_000_000);
      await store.reserve({ orgId, swarmId, amountMicroUsd: 400_000, ts: ts(5) });
      await store.settle(swarmId, 123_456, ts(6));
      const entriesBefore = await store.entries(orgId, null, 10);
      const balanceBefore = await store.balance(orgId);

      expect(await store.settle(swarmId, 999, ts(7))).toBeNull();

      expect(await store.balance(orgId)).toEqual(balanceBefore);
      expect(await store.entries(orgId, null, 10)).toEqual(entriesBefore);
    });

    it('reserve без строки организации и сверх доступного остатка — insufficient, резерв не появляется', async () => {
      const store = makeStore();
      const orgId = randomUUID();

      expect(
        await store.reserve({ orgId, swarmId: randomUUID(), amountMicroUsd: 1, ts: ts(1) }),
      ).toBe('insufficient');
      expect(await store.balance(orgId)).toEqual({ balanceMicroUsd: 0, heldMicroUsd: 0 });

      await topup(store, orgId, 100);
      await store.reserve({ orgId, swarmId: randomUUID(), amountMicroUsd: 60, ts: ts(2) });
      expect(
        await store.reserve({ orgId, swarmId: randomUUID(), amountMicroUsd: 41, ts: ts(3) }),
      ).toBe('insufficient');
      expect(
        await store.reserve({ orgId, swarmId: randomUUID(), amountMicroUsd: 40, ts: ts(4) }),
      ).toBe('ok');
    });

    it('повтор swarmId в reserve бросает исключение и не меняет резерв', async () => {
      const store = makeStore();
      const orgId = randomUUID();
      const swarmId = randomUUID();
      await topup(store, orgId, 1_000);
      await store.reserve({ orgId, swarmId, amountMicroUsd: 100, ts: ts(1) });

      await expect(
        store.reserve({ orgId, swarmId, amountMicroUsd: 100, ts: ts(2) }),
      ).rejects.toThrow();
      expect(await store.balance(orgId)).toEqual({ balanceMicroUsd: 1_000, heldMicroUsd: 100 });
    });

    it('entries отдаёт страницы по before и hasMore', async () => {
      const store = makeStore();
      const orgId = randomUUID();
      for (let i = 1; i <= 5; i++) await topup(store, orgId, i, i);

      const first = await store.entries(orgId, null, 2);
      expect(first.hasMore).toBe(true);
      expect(first.entries.map((entry) => entry.amountMicroUsd)).toEqual([5, 4]);

      const second = await store.entries(orgId, first.entries.at(-1)?.id ?? 0, 2);
      expect(second.hasMore).toBe(true);
      expect(second.entries.map((entry) => entry.amountMicroUsd)).toEqual([3, 2]);

      const third = await store.entries(orgId, second.entries.at(-1)?.id ?? 0, 2);
      expect(third).toEqual({
        entries: [expect.objectContaining({ amountMicroUsd: 1 })],
        hasMore: false,
      });
    });

    it('entries не отдаёт записи другой организации', async () => {
      const store = makeStore();
      const orgId = randomUUID();
      await topup(store, randomUUID(), 50);
      await topup(store, orgId, 70);

      const page = await store.entries(orgId, null, 10);
      expect(page.entries.map((entry) => entry.amountMicroUsd)).toEqual([70]);
    });

    it('holds отдаёт открытые резервы и не отдаёт закрытые', async () => {
      const store = makeStore();
      const orgId = randomUUID();
      const closed = randomUUID();
      const open = randomUUID();
      await topup(store, orgId, 1_000);
      await store.reserve({ orgId, swarmId: closed, amountMicroUsd: 100, ts: ts(1) });
      await store.reserve({ orgId, swarmId: open, amountMicroUsd: 200, ts: ts(2) });
      await store.settle(closed, 10, ts(3));

      const mine = (await store.holds()).filter((hold) => hold.orgId === orgId);
      expect(mine).toEqual([{ swarmId: open, orgId, amountMicroUsd: 200 }]);
    });
  });
}
