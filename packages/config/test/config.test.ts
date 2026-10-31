import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AgentConfig,
  ApiConfig,
  BaseConfig,
  ConfigError,
  IdentityConfig,
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
const serviceToken = 'swag-local-service-token-not-secret-0000';

// Спека 002, 4.8 и 4.9: примеры окружения шлюза; `.env.example` и `.env.llm.example` вместе проходят разбор.
const gatewayExamples = (): Record<string, string> => ({
  ...parseEnv(readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')),
  ...parseEnv(readFileSync(new URL('../../../.env.llm.example', import.meta.url), 'utf8')),
  // Спека 002, 4.8: задаёт compose; в 4.9 `.env.example` его не включает (D-63).
  LLM_CATALOG_PATH: '/etc/swag/models.json',
});

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
  ORCHESTRATOR_TOKEN: serviceToken,
};

// Спека 024, 4.14: env api с новыми переменными доступа; ключ проверки — фейк, в .env.example он пустой.
const apiEnv = {
  ...validEnv,
  API_PORT: '3000',
  ORCHESTRATOR_URL: 'http://orchestrator:3001',
  MAX_ACTIVE_SWARMS: '3',
  SWARM_MAX_BUDGET_MICRO_USD: '5000000',
  AGENT_MAX_TOKENS_LIMIT: '65536',
  IDENTITY_URL: 'http://identity:3003',
  IDENTITY_INTERNAL_TOKEN: serviceToken,
  IDENTITY_JWT_PUBLIC_KEY: 'fake-ed25519-public-key-for-tests',
  IDENTITY_JWT_KID: 'dev-1',
  ORCHESTRATOR_TOKEN: serviceToken,
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
    expect(loadConfig(ApiConfig, { ...apiEnv, API_PORT: '3000' }).API_PORT).toBe(3000);
    expect(() => loadConfig(ApiConfig, { ...apiEnv, API_PORT: 'abc' })).toThrow(/API_PORT/);
  });

  it('спека 004, 4.11: SWARM_MAX_BUDGET_MICRO_USD — целое не меньше 1', () => {
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

  it('AC-032-2: LlmGatewayConfig принимает LLM_PROFILE=test-pay и отклоняет dev-paid', () => {
    const examples = gatewayExamples();
    const profileOf = (LLM_PROFILE: string) =>
      LlmGatewayConfig.safeParse({ ...examples, LLM_PROFILE }).success;
    expect(profileOf('test-pay')).toBe(true);
    expect(profileOf('dev-paid')).toBe(false);
  });

  it('AC-002-27: LlmGatewayConfig — токен от 32 символов, LITELLM_MASTER_KEY с sk-; примеры окружения проходят', () => {
    const examples = gatewayExamples();
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

  it('спека 013, 4.10: LLM_GATEWAY_CLOSE_WAIT_MS — целое 0…8000, по умолчанию 5000', () => {
    const examples = gatewayExamples();
    const closeWait = (LLM_GATEWAY_CLOSE_WAIT_MS: string | undefined) =>
      LlmGatewayConfig.safeParse({ ...examples, LLM_GATEWAY_CLOSE_WAIT_MS }).success;
    const { LLM_GATEWAY_CLOSE_WAIT_MS: _omitted, ...withoutWait } = examples;
    expect(LlmGatewayConfig.parse(withoutWait).LLM_GATEWAY_CLOSE_WAIT_MS).toBe(5000);
    expect(closeWait('0')).toBe(true);
    expect(closeWait('8000')).toBe(true);
    expect(closeWait('8001')).toBe(false);
    expect(closeWait('-1')).toBe(false);
    expect(closeWait('1.5')).toBe(false);
  });
});

// Спека 012, 4.10: примеры окружения identity. Ключ подписи в .env.example пустой (Q-2), здесь — фейк.
describe('IdentityConfig', () => {
  const identityExample = (): Record<string, string | undefined> => ({
    ...parseEnv(readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')),
    IDENTITY_JWT_PRIVATE_KEY: 'fake-ed25519-key-for-tests',
  });

  it('AC-012-2: значения .env.example с ключом разбираются; без ключа и только с супервизором по email — ошибка', () => {
    expect(loadConfig(IdentityConfig, identityExample()).IDENTITY_PORT).toBe(3003);
    expect(loadConfig(IdentityConfig, identityExample()).IDENTITY_COOKIE_SECURE).toBe(false);

    const { IDENTITY_JWT_PRIVATE_KEY: _omitted, ...withoutKey } = identityExample();
    expect(() => loadConfig(IdentityConfig, withoutKey)).toThrow(/IDENTITY_JWT_PRIVATE_KEY/);
    expect(() =>
      loadConfig(IdentityConfig, { ...identityExample(), IDENTITY_JWT_PRIVATE_KEY: '' }),
    ).toThrow(/IDENTITY_JWT_PRIVATE_KEY/);
    expect(() =>
      loadConfig(IdentityConfig, {
        ...identityExample(),
        IDENTITY_SUPERVISOR_EMAIL: 'supervisor@swag.local',
      }),
    ).toThrow(/IDENTITY_SUPERVISOR_PASSWORD/);
  });

  it('AC-012-2: ключ, который выпускает npm run identity:keys, разбирается конфигом', () => {
    const output = execFileSync(
      process.execPath,
      [fileURLToPath(new URL('../../../scripts/identity-keys.ts', import.meta.url))],
      { encoding: 'utf8' },
    );
    const key = output.match(/^IDENTITY_JWT_PRIVATE_KEY=(.+)$/m)?.[1]?.trim() ?? '';
    expect(
      loadConfig(IdentityConfig, { ...identityExample(), IDENTITY_JWT_PRIVATE_KEY: key })
        .IDENTITY_JWT_KID,
    ).toBe('dev-1');
  });
});

// Спека 024, 4.14: токены сервисов, ключ проверки и приглашения.
describe('AC-024-2: конфиг доступа', () => {
  const withoutKey = (env: Record<string, string | undefined>, name: string) =>
    Object.fromEntries(Object.entries(env).filter(([key]) => key !== name));
  const missingOf = (schema: z.ZodType, env: Record<string, string | undefined>, name: string) =>
    expect(() => loadConfig(schema, env)).toThrow(`  ${name}: `);

  it('AC-024-2: без каждой новой обязательной переменной ApiConfig, OrchestratorConfig, IdentityConfig падает с её именем', () => {
    const apiRequired = [
      'IDENTITY_URL',
      'IDENTITY_INTERNAL_TOKEN',
      'IDENTITY_JWT_PUBLIC_KEY',
      'IDENTITY_JWT_KID',
      'ORCHESTRATOR_TOKEN',
    ];
    for (const name of apiRequired) {
      const env = withoutKey(apiEnv, name);
      missingOf(ApiConfig, env, name);
    }
    const { ORCHESTRATOR_TOKEN: _orchestrator, ...withoutOrchestratorToken } = orchestratorEnv;
    missingOf(OrchestratorConfig, withoutOrchestratorToken, 'ORCHESTRATOR_TOKEN');

    const identityEnv: Record<string, string | undefined> = {
      ...parseEnv(readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')),
      IDENTITY_JWT_PRIVATE_KEY: 'fake-ed25519-key-for-tests',
    };
    for (const name of ['IDENTITY_INTERNAL_TOKEN', 'IDENTITY_INVITE_URL']) {
      const env = withoutKey(identityEnv, name);
      missingOf(IdentityConfig, env, name);
    }
  });

  it('AC-024-2: токен сервиса короче 32 символов падает с именем переменной', () => {
    const short = 'x'.repeat(31);
    expect(() => loadConfig(ApiConfig, { ...apiEnv, IDENTITY_INTERNAL_TOKEN: short })).toThrow(
      '  IDENTITY_INTERNAL_TOKEN: ',
    );
    expect(() => loadConfig(ApiConfig, { ...apiEnv, ORCHESTRATOR_TOKEN: short })).toThrow(
      '  ORCHESTRATOR_TOKEN: ',
    );
    expect(() =>
      loadConfig(OrchestratorConfig, { ...orchestratorEnv, ORCHESTRATOR_TOKEN: short }),
    ).toThrow('  ORCHESTRATOR_TOKEN: ');
  });

  it('AC-024-2: умолчания и границы API_REVOCATION_*, IDENTITY_INVITE_TTL_S, URL', () => {
    const config = loadConfig(ApiConfig, apiEnv);
    expect(config).toMatchObject({
      IDENTITY_URL: 'http://identity:3003',
      API_REVOCATION_POLL_MS: 5000,
      API_REVOCATION_MAX_STALE_MS: 30000,
    });
    expect(() => loadConfig(ApiConfig, { ...apiEnv, API_REVOCATION_POLL_MS: '999' })).toThrow(
      '  API_REVOCATION_POLL_MS: ',
    );
    expect(() => loadConfig(ApiConfig, { ...apiEnv, API_REVOCATION_MAX_STALE_MS: '999' })).toThrow(
      '  API_REVOCATION_MAX_STALE_MS: ',
    );
    expect(() => loadConfig(ApiConfig, { ...apiEnv, IDENTITY_URL: 'нет' })).toThrow(
      '  IDENTITY_URL: ',
    );
    expect(() => loadConfig(ApiConfig, { ...apiEnv, IDENTITY_JWT_PUBLIC_KEY: '' })).toThrow(
      '  IDENTITY_JWT_PUBLIC_KEY: ',
    );

    const identityEnv = {
      ...parseEnv(readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')),
      IDENTITY_JWT_PRIVATE_KEY: 'fake-ed25519-key-for-tests',
    };
    expect(loadConfig(IdentityConfig, identityEnv).IDENTITY_INVITE_TTL_S).toBe(604800);
    expect(() =>
      loadConfig(IdentityConfig, { ...identityEnv, IDENTITY_INVITE_TTL_S: '599' }),
    ).toThrow('  IDENTITY_INVITE_TTL_S: ');
    expect(() =>
      loadConfig(IdentityConfig, { ...identityEnv, IDENTITY_INVITE_URL: 'нет' }),
    ).toThrow('  IDENTITY_INVITE_URL: ');
  });

  it('AC-024-2: .env.example проходит ApiConfig с ключом проверки; пустой IDENTITY_JWT_PUBLIC_KEY в примере — ошибка', () => {
    const example = parseEnv(
      readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8'),
    );
    expect(() =>
      loadConfig(ApiConfig, { ...example, IDENTITY_JWT_PUBLIC_KEY: 'fake-key' }),
    ).not.toThrow();
    expect(() => loadConfig(ApiConfig, example)).toThrow('  IDENTITY_JWT_PUBLIC_KEY: ');
  });
});
