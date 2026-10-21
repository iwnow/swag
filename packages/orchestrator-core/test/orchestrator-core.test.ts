import { ServiceInfo } from '@swag/contracts';
import { describe, expect, it } from 'vitest';
import { createOrchestratorCore } from '../src/index.ts';

describe('createOrchestratorCore', () => {
  it('AC-000-16: info() проходит ServiceInfo.parse и возвращает переданную версию', () => {
    const info = createOrchestratorCore({ version: 'test' }).info();
    expect(ServiceInfo.parse(info)).toEqual({ service: 'orchestrator', version: 'test' });
  });

  it('два вызова фабрики дают независимые ядра', () => {
    const a = createOrchestratorCore({ version: 'a' });
    const b = createOrchestratorCore({ version: 'b' });
    expect(a).not.toBe(b);
    expect([a.info().version, b.info().version]).toEqual(['a', 'b']);
  });
});
