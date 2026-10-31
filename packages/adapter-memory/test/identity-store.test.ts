import { createMemoryIdentityStore } from '../src/index.ts';
import { identityStoreContract } from './identity-store.contract.ts';

identityStoreContract('memory', () => createMemoryIdentityStore());
