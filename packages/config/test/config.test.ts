import { describe, expect, it } from 'vitest';
import { ApiConfig, BaseConfig, ConfigError, loadConfig } from '../src/index.ts';

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
    expect(loadConfig(ApiConfig, { ...validEnv, API_PORT: '3000' }).API_PORT).toBe(3000);
    expect(() => loadConfig(ApiConfig, { ...validEnv, API_PORT: 'abc' })).toThrow(/API_PORT/);
  });
});
