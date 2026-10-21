import { ServiceInfo } from '@swag/contracts';
import { describe, expect, it } from 'vitest';
import { createAgentCore } from '../src/index.ts';

describe('createAgentCore', () => {
  it('AC-000-16: info() проходит ServiceInfo.parse и возвращает переданную версию', () => {
    const info = createAgentCore({ version: 'test' }).info();
    expect(ServiceInfo.parse(info)).toEqual({ service: 'agent', version: 'test' });
  });

  it('два вызова фабрики дают независимые ядра', () => {
    const a = createAgentCore({ version: 'a' });
    const b = createAgentCore({ version: 'b' });
    expect(a).not.toBe(b);
    expect([a.info().version, b.info().version]).toEqual(['a', 'b']);
  });
});
