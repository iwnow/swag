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
