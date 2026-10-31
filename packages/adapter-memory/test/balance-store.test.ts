import { describe, expect, it } from 'vitest';
import { createMemoryBalanceStore } from '../src/index.ts';
import { balanceStoreContract } from './balance-store.contract.ts';

balanceStoreContract('memory', () => createMemoryBalanceStore());

describe('createMemoryBalanceStore: номера записей', () => {
  it('id общий на все организации и начинается с 1', async () => {
    const store = createMemoryBalanceStore();
    const actorId = '00000000-0000-4000-8000-0000000000aa';
    const first = await store.topup({
      orgId: '00000000-0000-4000-8000-000000000001',
      amountMicroUsd: 1,
      actorId,
      comment: null,
      ts: '2026-11-01T10:00:00.000Z',
    });
    const second = await store.topup({
      orgId: '00000000-0000-4000-8000-000000000002',
      amountMicroUsd: 1,
      actorId,
      comment: 'проверка',
      ts: '2026-11-01T10:00:01.000Z',
    });

    expect([first.id, second.id]).toEqual([1, 2]);
    expect(second.ts).toBe('2026-11-01T10:00:01.000Z');
  });
});
