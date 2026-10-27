import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  ApiConfig,
  BaseConfig,
  ConfigError,
  LlmGatewayConfig,
  ObservabilityConfig,
  OrchestratorConfig,
  loadConfig,
} from '../src/index.ts';

const validEnv = {
  DATABASE_URL: 'postgres://swag:swag-local@postgres:5432/swag',
  NATS_URL: 'nats://nats:4222',
};

describe('loadConfig', () => {
  it('AC-000-2: валидный env даёт типизированный объект', () => {
    const config: BaseConfig = loadConfig(BaseConfig, { ...validEnv, UNRELATED: 'x' });
    // Спека 016, 4.11: значения телеметрии по умолчанию.
    expect(config).toEqual({
      ...validEnv,
      OTEL_EXPORTER_OTLP_ENDPOINT: null,
      LOG_LEVEL: 'info',
      TELEMETRY_FLUSH_TIMEOUT_MS: 2000,
    });
  });

  it('AC-000-3: без DATABASE_URL — ошибка с именем переменной', () => {
    const { DATABASE_URL: _omitted, ...env } = validEnv;
    expect(() => loadConfig(BaseConfig, env)).toThrow(ConfigError);
    expect(() => loadConfig(BaseConfig, env)).toThrow(/DATABASE_URL/);
  });

  it('порт сервиса приводится к числу и проверяется', () => {
    const apiEnv = {
      ...validEnv,
      ORCHESTRATOR_URL: 'http://orchestrator:3001',
      MAX_ACTIVE_SWARMS: '3',
    };
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
    expect(loadConfig(AgentConfig, { ...agentEnv, AGENT_NEXT: 'agent-3' }).AGENT_NEXT).toBe(
      'agent-3',
    );
    expect(() => loadConfig(AgentConfig, { ...agentEnv, AGENT_NEXT: 'bob' })).toThrow(/AGENT_NEXT/);
  });

  it('телеметрия: LOG_LEVEL из LogLevel, OTLP-адрес, TRACEPARENT агента; пустые строки — null', () => {
    const base = loadConfig(BaseConfig, {
      ...validEnv,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318',
      LOG_LEVEL: 'debug',
      TELEMETRY_FLUSH_TIMEOUT_MS: '500',
    });
    expect(base).toMatchObject({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318',
      LOG_LEVEL: 'debug',
      TELEMETRY_FLUSH_TIMEOUT_MS: 500,
    });
    expect(() => loadConfig(BaseConfig, { ...validEnv, LOG_LEVEL: 'trace' })).toThrow(/LOG_LEVEL/);
    expect(loadConfig(ObservabilityConfig, { GRAFANA_PORT: '3300' }).GRAFANA_PORT).toBe(3300);

    const agent = loadConfig(AgentConfig, {
      NATS_URL: 'nats://nats:4222',
      SWARM_ID: '0b6f6d2e-6a4c-4c3e-9f5e-111111111111',
      AGENT_ID: 'agent-1',
      AGENT_NAME: 'A',
      AGENT_ROLE: 'r',
      AGENT_NEXT: '',
      AGENT_STEP_DELAY_MS: '0',
      TRACEPARENT: '',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
    });
    expect(agent).toMatchObject({
      TRACEPARENT: null,
      OTEL_EXPORTER_OTLP_ENDPOINT: null,
      TELEMETRY_FLUSH_TIMEOUT_MS: 2000,
    });
  });

  it('DOCKER_AGENT_OTLP_ENDPOINT необязательный: пусто или нет — null, иначе адрес', () => {
    const orchestratorEnv = {
      ...validEnv,
      ORCHESTRATOR_PORT: '3001',
      AGENT_TEMPLATE: 'swag-agent:dev',
      DOCKER_AGENT_NETWORK: 'swag_default',
      DOCKER_AGENT_NATS_URL: 'nats://nats:4222',
      AGENT_STEP_DELAY_MS: '0',
      AGENT_START_TIMEOUT_MS: '30000',
      SWARM_TIMEOUT_MS: '300000',
    };
    expect(loadConfig(OrchestratorConfig, orchestratorEnv).DOCKER_AGENT_OTLP_ENDPOINT).toBeNull();
    expect(
      loadConfig(OrchestratorConfig, { ...orchestratorEnv, DOCKER_AGENT_OTLP_ENDPOINT: '' })
        .DOCKER_AGENT_OTLP_ENDPOINT,
    ).toBeNull();
    expect(
      loadConfig(OrchestratorConfig, {
        ...orchestratorEnv,
        DOCKER_AGENT_OTLP_ENDPOINT: 'http://otel-collector:4318',
      }).DOCKER_AGENT_OTLP_ENDPOINT,
    ).toBe('http://otel-collector:4318');
    expect(() =>
      loadConfig(OrchestratorConfig, { ...orchestratorEnv, DOCKER_AGENT_OTLP_ENDPOINT: 'нет' }),
    ).toThrow(/DOCKER_AGENT_OTLP_ENDPOINT/);
  });

  it('AC-002-27: LlmGatewayConfig — токен от 32 символов, LITELLM_MASTER_KEY с sk-; примеры окружения проходят', () => {
    const examples: Record<string, string> = {
      ...parseEnv(readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')),
      ...parseEnv(readFileSync(new URL('../../../.env.llm.example', import.meta.url), 'utf8')),
      // Спека 002, 4.8: задаёт compose; в 4.9 `.env.example` его не включает (D-63).
      LLM_CATALOG_PATH: '/etc/swag/models.json',
    };
    const { LLM_GATEWAY_TOKEN: _omitted, ...withoutToken } = examples;
    const failures = (env: Record<string, string | undefined>) =>
      LlmGatewayConfig.safeParse(env).error?.issues.map((issue) => issue.path.join('.')) ?? [];

    expect(failures(withoutToken)).toEqual(['LLM_GATEWAY_TOKEN']);
    expect(failures({ ...examples, LLM_GATEWAY_TOKEN: 'x'.repeat(31) })).toEqual([
      'LLM_GATEWAY_TOKEN',
    ]);
    expect(failures({ ...examples, LITELLM_MASTER_KEY: 'key-swag-local-not-secret' })).toEqual([
      'LITELLM_MASTER_KEY',
    ]);
    expect(LlmGatewayConfig.safeParse(examples).success).toBe(true);
  });
});
