import { describe, expect, it } from 'vitest';
import { ServiceInfo } from '@swag/contracts';
import { createIdentityCore, type IdentityCoreDeps } from '../src/index.ts';

const deps = { version: 'test' } as IdentityCoreDeps;

describe('identity-core — каркас (спека 012, T-4)', () => {
  it('REQ-012-1: info() возвращает service identity и версию из deps', () => {
    const info = createIdentityCore(deps).info();
    expect(ServiceInfo.parse(info)).toEqual({ service: 'identity', version: 'test' });
  });

  it('REQ-012-1: операции до T-9..T-10 отвечают internal_error, ensureSupervisor бросает', async () => {
    const core = createIdentityCore(deps);
    const stubs = [core.refresh(undefined), core.logout(undefined)];
    for (const result of await Promise.all(stubs)) {
      expect(result).toEqual({
        ok: false,
        error: { code: 'internal_error', message: 'not implemented' },
      });
    }
    await expect(core.ensureSupervisor()).rejects.toThrow('not implemented');
  });
});
