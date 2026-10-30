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

const gatewayToken = 'swag-local-gateway-token-not-secret-000';

// Спека 022, 4.8: env агента, который ставит ядро оркестратора.
const agentEnv = {
  NATS_URL: 'nats://nats:4222',
  SWARM_ID: '0b6f6d2e-6a4c-4c3e-9f5e-111111111111',
  AGENT_ID: 'agent-2',
  AGENT_NAME: 'Редактор',
  AGENT_ROLE: 'Проверяет текст',
  AGENT_MODEL: 'chat-small',
  AGENT_PEERS: '[{"id":"agent-1","name":"Автор","role":"Пишет текст"}]',
  AGENT_ENTRY: 'agent-1',
  AGENT_MAX_STEPS: '20',
  AGENT_MAX_TOKENS: '2048',
  LLM_GATEWAY_URL: 'http://llm-gateway:3002/v1',
  LLM_GATEWAY_TOKEN: gatewayToken,
};

// Спека 022, 4.8: env оркестратора; значения из .env.example.
const orchestratorEnv = {
  ...validEnv,
  ORCHESTRATOR_PORT: '3001',
  AGENT_TEMPLATE: 'swag-agent:dev',
  DOCKER_AGENT_NETWORK: 'swag_default',
  DOCKER_AGENT_NATS_URL: 'nats://nats:4222',
  AGENT_START_TIMEOUT_MS: '30000',
  SWARM_TIMEOUT_MS: '300000',
  AGENT_MAX_STEPS: '20',
  AGENT_MAX_TOKENS: '2048',
  LLM_GATEWAY_TOKEN: gatewayToken,
  DOCKER_AGENT_LLM_GATEWAY_URL: 'http://llm-gateway:3002/v1',
  LLM_GATEWAY_URL: 'http://llm-gateway:3002',
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
      SWARM_MAX_BUDGET_MICRO_USD: '5000000',
    };
    expect(loadConfig(ApiConfig, { ...apiEnv, API_PORT: '3000' }).API_PORT).toBe(3000);
    expect(() => loadConfig(ApiConfig, { ...apiEnv, API_PORT: 'abc' })).toThrow(/API_PORT/);
  });

  it('спека 004, 4.11: SWARM_MAX_BUDGET_MICRO_USD — целое не меньше 1', () => {
    const apiEnv = {
      ...validEnv,
      ORCHESTRATOR_URL: 'http://orchestrator:3001',
      MAX_ACTIVE_SWARMS: '3',
      API_PORT: '3000',
    };
    expect(
      loadConfig(ApiConfig, { ...apiEnv, SWARM_MAX_BUDGET_MICRO_USD: '5000000' })
        .SWARM_MAX_BUDGET_MICRO_USD,
    ).toBe(5000000);
    expect(() => loadConfig(ApiConfig, { ...apiEnv, SWARM_MAX_BUDGET_MICRO_USD: '0' })).toThrow(
      /SWARM_MAX_BUDGET_MICRO_USD/,
    );
    expect(() => loadConfig(ApiConfig, { ...apiEnv, SWARM_MAX_BUDGET_MICRO_USD: '1.5' })).toThrow(
      /SWARM_MAX_BUDGET_MICRO_USD/,
    );
  });

  it('спека 022, 4.8: AgentConfig разбирает AGENT_PEERS, умолчания и не знает AGENT_NEXT', () => {
    const config = loadConfig(AgentConfig, agentEnv);
    expect(config).toMatchObject({
      AGENT_MODEL: 'chat-small',
      AGENT_PEERS: [{ id: 'agent-1', name: 'Автор', role: 'Пишет текст' }],
      AGENT_ENTRY: 'agent-1',
      AGENT_MAX_STEPS: 20,
      AGENT_MAX_TOKENS: 2048,
      LLM_GATEWAY_URL: 'http://llm-gateway:3002/v1',
      AGENT_LLM_TIMEOUT_MS: 120000,
      AGENT_LLM_MAX_RETRIES: 2,
    });
    expect(config).not.toHaveProperty('AGENT_NEXT');
    expect(config).not.toHaveProperty('AGENT_STEP_DELAY_MS');
    expect(loadConfig(AgentConfig, { ...agentEnv, AGENT_PEERS: '[]' }).AGENT_PEERS).toEqual([]);
    expect(
      loadConfig(AgentConfig, {
        ...agentEnv,
        AGENT_LLM_TIMEOUT_MS: '5000',
        AGENT_LLM_MAX_RETRIES: '0',
      }),
    ).toMatchObject({ AGENT_LLM_TIMEOUT_MS: 5000, AGENT_LLM_MAX_RETRIES: 0 });
  });

  it('спека 022, 4.8: AgentConfig отвергает плохой AGENT_PEERS, AGENT_ENTRY и лимиты', () => {
    expect(() => loadConfig(AgentConfig, { ...agentEnv, AGENT_PEERS: 'не json' })).toThrow(
      /AGENT_PEERS/,
    );
    expect(() =>
      loadConfig(AgentConfig, { ...agentEnv, AGENT_PEERS: '[{"id":"bob","name":"x","role":"y"}]' }),
    ).toThrow(/AGENT_PEERS/);
    expect(() => loadConfig(AgentConfig, { ...agentEnv, AGENT_ENTRY: 'bob' })).toThrow(
      /AGENT_ENTRY/,
    );
    expect(() => loadConfig(AgentConfig, { ...agentEnv, AGENT_MAX_STEPS: '0' })).toThrow(
      /AGENT_MAX_STEPS/,
    );
    expect(() => loadConfig(AgentConfig, { ...agentEnv, AGENT_MAX_TOKENS: '0' })).toThrow(
      /AGENT_MAX_TOKENS/,
    );
    expect(() =>
      loadConfig(AgentConfig, { ...agentEnv, LLM_GATEWAY_TOKEN: 'x'.repeat(31) }),
    ).toThrow(/LLM_GATEWAY_TOKEN/);
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
    expect(
      loadConfig(ObservabilityConfig, { GRAFANA_PORT: '3300', TELEMETRY_RETENTION: '24h' })
        .GRAFANA_PORT,
    ).toBe(3300);

    const agent = loadConfig(AgentConfig, {
      ...agentEnv,
      AGENT_ID: 'agent-1',
      AGENT_PEERS: '[]',
      TRACEPARENT: '',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
    });
    expect(agent).toMatchObject({
      TRACEPARENT: null,
      OTEL_EXPORTER_OTLP_ENDPOINT: null,
      TELEMETRY_FLUSH_TIMEOUT_MS: 2000,
    });
  });

  it('AC-003-10: TELEMETRY_RETENTION — часы не меньше 24, без значения по умолчанию', () => {
    const observability = { GRAFANA_PORT: '3300' };
    for (const value of ['24h', '168h']) {
      expect(
        loadConfig(ObservabilityConfig, { ...observability, TELEMETRY_RETENTION: value })
          .TELEMETRY_RETENTION,
      ).toBe(value);
    }
    for (const value of ['12h', '1d', '24']) {
      expect(() =>
        loadConfig(ObservabilityConfig, { ...observability, TELEMETRY_RETENTION: value }),
      ).toThrow(/TELEMETRY_RETENTION/);
    }
    expect(() => loadConfig(ObservabilityConfig, observability)).toThrow(/TELEMETRY_RETENTION/);
  });

  it('DOCKER_AGENT_OTLP_ENDPOINT необязательный: пусто или нет — null, иначе адрес', () => {
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

  it('спека 022, 4.8: OrchestratorConfig требует лимиты агента и адрес gateway; AGENT_STEP_DELAY_MS удалён', () => {
    const config = loadConfig(OrchestratorConfig, orchestratorEnv);
    expect(config).toMatchObject({
      AGENT_MAX_STEPS: 20,
      AGENT_MAX_TOKENS: 2048,
      LLM_GATEWAY_TOKEN: gatewayToken,
      DOCKER_AGENT_LLM_GATEWAY_URL: 'http://llm-gateway:3002/v1',
      LLM_GATEWAY_URL: 'http://llm-gateway:3002',
    });
    expect(config).not.toHaveProperty('AGENT_STEP_DELAY_MS');
    expect(() =>
      loadConfig(OrchestratorConfig, { ...orchestratorEnv, AGENT_MAX_STEPS: '0' }),
    ).toThrow(/AGENT_MAX_STEPS/);
    expect(() =>
      loadConfig(OrchestratorConfig, { ...orchestratorEnv, AGENT_MAX_TOKENS: undefined }),
    ).toThrow(/AGENT_MAX_TOKENS/);
    expect(() =>
      loadConfig(OrchestratorConfig, { ...orchestratorEnv, DOCKER_AGENT_LLM_GATEWAY_URL: 'нет' }),
    ).toThrow(/DOCKER_AGENT_LLM_GATEWAY_URL/);
  });

  it('спека 004, 4.11: OrchestratorConfig.LLM_GATEWAY_URL — URL; без него или невалидный — ошибка', () => {
    const { LLM_GATEWAY_URL: _omitted, ...withoutUrl } = orchestratorEnv;
    expect(() => loadConfig(OrchestratorConfig, withoutUrl)).toThrow(/LLM_GATEWAY_URL/);
    expect(() =>
      loadConfig(OrchestratorConfig, { ...orchestratorEnv, LLM_GATEWAY_URL: 'нет' }),
    ).toThrow(/LLM_GATEWAY_URL/);
  });

  it('спека 022, 4.8: .env.example проходит OrchestratorConfig и содержит новые переменные', () => {
    const example = parseEnv(
      readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'),
    );
    expect(loadConfig(OrchestratorConfig, example).AGENT_MAX_STEPS).toBe(20);
    expect(example).not.toHaveProperty('AGENT_NEXT');
    expect(example).not.toHaveProperty('AGENT_STEP_DELAY_MS');
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
