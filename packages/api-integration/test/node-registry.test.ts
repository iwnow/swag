import { describe, expect, it } from 'vitest';
import { NodeManifest } from '@swag/contracts';
import { createNodeRegistry } from '../src/index.ts';

// Спека 021, 4.4: манифест example/echo@1.0.0 (литерал, как в swag-node.json).
const ECHO = {
  type: 'example/echo',
  version: '1.0.0',
  kind: 'program',
  title: 'Эхо',
  description: 'Пример программы: возвращает входной текст с префиксом из настроек.',
  settings: {
    type: 'object',
    properties: { prefix: { type: 'string', maxLength: 40, default: '' } },
    additionalProperties: false,
  },
  credentials: [],
  inputs: {
    type: 'object',
    properties: { text: { type: 'string', maxLength: 4000 } },
    required: ['text'],
    additionalProperties: false,
  },
  outputs: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  operations: [],
  egress: [],
};

const LLM_AGENT = {
  type: 'swag/llm-agent',
  version: '1.0.0',
  kind: 'llm-agent',
  title: 'LLM-агент',
  description: 'Агент на модели платформы.',
  settings: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  },
  credentials: [],
  inputs: null,
  outputs: null,
  operations: [],
  egress: [],
};

// JSON Schema, которую fromJSONSchema не поддерживает (not).
const UNSUPPORTED = { type: 'object', not: { type: 'string' } };

const CONNECTOR = {
  type: 'example/connector',
  version: '1.0.0',
  kind: 'connector',
  title: 'Коннектор',
  description: 'Пример коннектора с одной операцией.',
  settings: { type: 'object', properties: {}, additionalProperties: false },
  credentials: [],
  inputs: null,
  outputs: null,
  operations: [],
  egress: [],
};

const operation = (overrides: Record<string, unknown>) => ({
  name: 'run',
  title: 'Запуск',
  description: 'Операция с одной схемой на проверку.',
  access: 'read',
  input: { type: 'object' },
  output: { type: 'object' },
  ...overrides,
});

const manifest = (overrides: Record<string, unknown>, base: Record<string, unknown> = ECHO) =>
  NodeManifest.parse({ ...base, ...overrides });

describe('реестр типов узлов', () => {
  it('AC-021-5: два манифеста с одним type@version — node_type_duplicate', () => {
    const result = createNodeRegistry([manifest({}), manifest({ title: 'Копия' })]);

    expect(result).toEqual({
      ok: false,
      error: { code: 'node_type_duplicate', ref: 'example/echo@1.0.0' },
    });
  });

  it.each([
    ['внешний $ref', { type: 'object', properties: { a: { $ref: 'https://example.com/s.json' } } }],
    ['not', { type: 'object', not: { type: 'string' } }],
    [
      'if/then',
      { type: 'object', if: { properties: { a: { const: 1 } } }, then: { required: ['b'] } },
    ],
  ])('AC-021-6: схема настроек с %s — node_schema_unsupported', (_, settings) => {
    const result = createNodeRegistry([manifest({ settings })]);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'node_schema_unsupported',
        ref: 'example/echo@1.0.0',
        schema: 'settings',
        message: expect.any(String),
      },
    });
  });

  it.each([
    ['inputs', 'program', { inputs: UNSUPPORTED }, 'inputs'],
    ['outputs', 'program', { outputs: UNSUPPORTED }, 'outputs'],
    [
      'operations.<name>.input',
      'connector',
      { operations: [operation({ input: UNSUPPORTED })] },
      'operations.run.input',
    ],
    [
      'operations.<name>.output',
      'connector',
      { operations: [operation({ output: UNSUPPORTED })] },
      'operations.run.output',
    ],
  ])('AC-021-6: схема с not в %s — node_schema_unsupported', (_, kind, overrides, schema) => {
    const base = kind === 'program' ? ECHO : CONNECTOR;
    const result = createNodeRegistry([manifest(overrides, base)]);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'node_schema_unsupported',
        ref: `${base.type}@${base.version}`,
        schema,
        message: expect.any(String),
      },
    });
  });

  it('AC-021-6: при неподдерживаемых inputs и outputs ошибка указывает на inputs', () => {
    const result = createNodeRegistry([manifest({ inputs: UNSUPPORTED, outputs: UNSUPPORTED })]);

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'node_schema_unsupported', schema: 'inputs' },
    });
  });

  it('AC-021-7: validateSettings — значения по умолчанию, invalid_settings с путём, node_type_not_found', () => {
    const created = createNodeRegistry([manifest({})]);
    if (!created.ok) throw new Error('реестр не создан');
    const { registry } = created;

    expect(registry.validateSettings('example/echo@1.0.0', {})).toEqual({
      ok: true,
      settings: { prefix: '' },
    });

    const wrongType = registry.validateSettings('example/echo@1.0.0', { prefix: 1 });
    expect(wrongType.ok).toBe(false);
    if (wrongType.ok) throw new Error('ожидался отказ');
    expect(wrongType.error).toEqual({
      code: 'invalid_settings',
      issues: [expect.objectContaining({ path: 'prefix' })],
    });

    expect(registry.validateSettings('example/echo@1.0.0', { prefix: 'a', x: 1 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_settings' },
    });

    expect(registry.validateSettings('example/echo@2.0.0', {})).toEqual({
      ok: false,
      error: { code: 'node_type_not_found' },
    });
    expect(registry.validateSettings('не ссылка', {})).toEqual({
      ok: false,
      error: { code: 'node_type_not_found' },
    });
    expect(registry.get('example/echo@2.0.0')).toBeNull();
    expect(registry.get('не ссылка')).toBeNull();
    expect(registry.get('example/echo@1.0.0')).toEqual(manifest({}));
  });

  it('AC-021-8: list — по одной записи на type, последняя версия по semver, версии по убыванию', () => {
    const created = createNodeRegistry([
      manifest({ version: '1.0.0' }),
      manifest({ version: '1.10.0' }),
      manifest({ version: '1.2.0' }),
      manifest({}, LLM_AGENT),
    ]);
    if (!created.ok) throw new Error('реестр не создан');

    const items = created.registry.list();

    expect(items.map((item) => item.type)).toEqual(['example/echo', 'swag/llm-agent']);
    expect(items[0]).toMatchObject({
      type: 'example/echo',
      version: '1.10.0',
      versions: ['1.10.0', '1.2.0', '1.0.0'],
      kind: 'program',
      title: 'Эхо',
    });
    expect(items[1]).toMatchObject({ version: '1.0.0', versions: ['1.0.0'], kind: 'llm-agent' });
  });

  it('AC-026-2: validate — invalid_value с issues, schema_not_found, node_type_not_found, верное значение после parse', () => {
    const connector = manifest(
      {
        operations: [
          operation({
            name: 'list',
            input: {
              type: 'object',
              properties: { limit: { type: 'integer', default: 10 } },
              additionalProperties: false,
            },
            output: {
              type: 'object',
              properties: { ok: { type: 'boolean' } },
              required: ['ok'],
              additionalProperties: false,
            },
          }),
        ],
      },
      CONNECTOR,
    );
    const created = createNodeRegistry([manifest({}), connector]);
    if (!created.ok) throw new Error('реестр не создан');
    const { registry } = created;

    const badOutput = registry.validate('example/echo@1.0.0', { place: 'outputs' }, { text: 1 });
    expect(badOutput).toEqual({
      ok: false,
      error: { code: 'invalid_value', issues: [expect.objectContaining({ path: 'text' })] },
    });
    expect(
      registry.validate(
        'example/connector@1.0.0',
        { place: 'operation', name: 'list', io: 'output' },
        { ok: 'да' },
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid_value', issues: [expect.anything()] } });

    expect(
      registry.validate(
        'example/connector@1.0.0',
        { place: 'operation', name: 'missing', io: 'input' },
        {},
      ),
    ).toEqual({ ok: false, error: { code: 'schema_not_found' } });
    expect(registry.validate('example/connector@1.0.0', { place: 'inputs' }, {})).toEqual({
      ok: false,
      error: { code: 'schema_not_found' },
    });
    expect(
      registry.validate('example/echo@1.0.0', { place: 'operation', name: 'run', io: 'input' }, {}),
    ).toEqual({
      ok: false,
      error: { code: 'schema_not_found' },
    });

    expect(registry.validate('example/echo@2.0.0', { place: 'inputs' }, {})).toEqual({
      ok: false,
      error: { code: 'node_type_not_found' },
    });

    expect(
      registry.validate(
        'example/connector@1.0.0',
        { place: 'operation', name: 'list', io: 'input' },
        {},
      ),
    ).toEqual({ ok: true, value: { limit: 10 } });
    expect(registry.validate('example/echo@1.0.0', { place: 'outputs' }, { text: 'ok' })).toEqual({
      ok: true,
      value: { text: 'ok' },
    });
  });
});
