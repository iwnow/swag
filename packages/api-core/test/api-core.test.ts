import { ServiceInfo } from '@swag/contracts';
import { describe, expect, it } from 'vitest';
import { createApiCore } from '../src/index.ts';

describe('createApiCore', () => {
  it('AC-000-16: info() проходит ServiceInfo.parse и возвращает переданную версию', () => {
    const info = createApiCore({ version: 'test' }).info();
    expect(ServiceInfo.parse(info)).toEqual({ service: 'api', version: 'test' });
  });

  it('два вызова фабрики дают независимые ядра', () => {
    const a = createApiCore({ version: 'a' });
    const b = createApiCore({ version: 'b' });
    expect(a).not.toBe(b);
    expect([a.info().version, b.info().version]).toEqual(['a', 'b']);
  });
});
