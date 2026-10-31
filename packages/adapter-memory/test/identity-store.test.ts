import { describe, expect, it } from 'vitest';
import { createMemoryIdentityStore } from '../src/index.ts';
import { identityStoreContract } from './identity-store.contract.ts';

identityStoreContract('memory', () => createMemoryIdentityStore());

describe('createMemoryIdentityStore: пустое хранилище', () => {
  it('AC-012-30: hasSupervisor — false, пока нет супервизора', async () => {
    const store = createMemoryIdentityStore();

    expect(await store.hasSupervisor()).toBe(false);
  });
});

describe('createMemoryIdentityStore: пустое хранилище доступа (спека 024)', () => {
  it('AC-024-4: listUsers, listOrganizations и tokenRevocations пусты, purge возвращает нули', async () => {
    const store = createMemoryIdentityStore();

    expect(await store.listUsers({})).toEqual([]);
    expect(await store.listOrganizations()).toEqual([]);
    expect(await store.tokenRevocations(0)).toEqual([]);
    expect(await store.purge(Date.now())).toEqual({
      confirmations: 0,
      invitations: 0,
      sessions: 0,
    });
  });
});
