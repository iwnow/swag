import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createTestEnv, seedOrganization } from './fakes.ts';

// Спека 013, 4.8: organizationExists (проверка организации для api).

describe('identity-core — организация существует (спека 013, T-7)', () => {
  it('AC-013-20: organizationExists — true для существующей, false для неизвестной и не UUID', async () => {
    const env = createTestEnv();
    const { orgId } = await seedOrganization(env, 'owner@example.test', 'Компания');

    expect(await env.core.organizationExists(orgId)).toBe(true);
    expect(await env.core.organizationExists(randomUUID())).toBe(false);
    expect(await env.core.organizationExists('не-uuid')).toBe(false);
  });

  it('AC-013-20: organizationExists для не UUID не обращается к хранилищу', async () => {
    const env = createTestEnv();
    const find = vi.spyOn(env.store, 'findOrganizationById');

    expect(await env.core.organizationExists('не-uuid')).toBe(false);
    expect(find).not.toHaveBeenCalled();
  });
});
