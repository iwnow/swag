import { describe, expect, it } from 'vitest';
import { AgentConfig, ApiConfig, BaseConfig, ConfigError, loadConfig } from '../src/index.ts';

const validEnv = {
  DATABASE_URL: 'postgres://swag:swag-local@postgres:5432/swag',
  NATS_URL: 'nats://nats:4222',
};

describe('loadConfig', () => {
  it('AC-000-2: валидный env даёт типизированный объект', () => {
    const config: BaseConfig = loadConfig(BaseConfig, { ...validEnv, UNRELATED: 'x' });
    expect(config).toEqual(validEnv);
  });

  it('AC-000-3: без DATABASE_URL — ошибка с именем переменной', () => {
    const { DATABASE_URL: _omitted, ...env } = validEnv;
    expect(() => loadConfig(BaseConfig, env)).toThrow(ConfigError);
    expect(() => loadConfig(BaseConfig, env)).toThrow(/DATABASE_URL/);
  });

  it('порт сервиса приводится к числу и проверяется', () => {
    const apiEnv = { ...validEnv, ORCHESTRATOR_URL: 'http://orchestrator:3001', MAX_ACTIVE_SWARMS: '3' };
    expect(loadConfig(ApiConfig, { ...apiEnv, API_PORT: '3000' }).API_PORT).toBe(3000);
    expect(() => loadConfig(ApiConfig, { ...apiEnv, API_PORT: 'abc' })).toThrow(/API_PORT/);
  });

  it('AC-001-agent: AGENT_NEXT пустой — последний агент (null); лишний agent-id — ошибка', () => {
    const agentEnv = {
      NATS_URL: 'nats://nats:4222',
      SWARM_ID: '0b6f6d2e-6a4c-4c3e-9f5e-111111111111',
      AGENT_ID: 'agent-2',
      AGENT_NAME: 'Редактор',
      AGENT_ROLE: 'Проверяет текст',
      AGENT_NEXT: '',
      AGENT_STEP_DELAY_MS: '1000',
    };
    expect(loadConfig(AgentConfig, agentEnv).AGENT_NEXT).toBeNull();
    expect(loadConfig(AgentConfig, { ...agentEnv, AGENT_NEXT: 'agent-3' }).AGENT_NEXT).toBe('agent-3');
    expect(() => loadConfig(AgentConfig, { ...agentEnv, AGENT_NEXT: 'bob' })).toThrow(/AGENT_NEXT/);
  });
});
