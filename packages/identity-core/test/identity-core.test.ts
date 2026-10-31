import { describe, expect, it } from 'vitest';
import { ServiceInfo } from '@swag/contracts';
import { createIdentityCore, type IdentityCoreDeps } from '../src/index.ts';

const deps = { version: 'test' } as IdentityCoreDeps;

describe('identity-core — каркас (спека 012, T-4)', () => {
  it('REQ-012-1: info() возвращает service identity и версию из deps', () => {
    const info = createIdentityCore(deps).info();
    expect(ServiceInfo.parse(info)).toEqual({ service: 'identity', version: 'test' });
  });
});
