import { describe, expect, it } from 'vitest';
import {
  EgressHost,
  NodeCredential,
  NodeKind,
  NodeManifest,
  NodeTypeName,
  NodeTypeRef,
  NodeTypeVersion,
  nodeTypeRef,
  parseNodeTypeRef,
} from '../src/index.ts';

const SCHEMA = { type: 'object' };
const CREDENTIAL = { name: 'apiKey', title: 'Ключ API', kind: 'api-key' };
const HOST = 'api.example.com';
const OPERATION = {
  name: 'list',
  title: 'Список',
  description: 'Возвращает список записей.',
  access: 'read',
  input: SCHEMA,
  output: SCHEMA,
};

// Спека 021, 4.4: манифест example/echo@1.0.0 в JSON.
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

// Верный набор полей для каждого вида: нарушения правил 4.1.3 получаются правкой одного поля.
const BASE: Record<NodeKind, Record<string, unknown>> = {
  trigger: {
    type: 'example/trigger',
    kind: 'trigger',
    inputs: null,
    outputs: SCHEMA,
    operations: [],
    credentials: [CREDENTIAL],
    egress: [HOST],
  },
  channel: {
    type: 'example/channel',
    kind: 'channel',
    inputs: SCHEMA,
    outputs: SCHEMA,
    operations: [],
    credentials: [CREDENTIAL],
    egress: [HOST],
  },
  connector: {
    type: 'example/connector',
    kind: 'connector',
    inputs: null,
    outputs: null,
    operations: [OPERATION],
    credentials: [CREDENTIAL],
    egress: [HOST],
  },
  program: {
    type: 'example/program',
    kind: 'program',
    inputs: SCHEMA,
    outputs: SCHEMA,
    operations: [],
    credentials: [CREDENTIAL],
    egress: [HOST],
  },
  'llm-agent': {
    type: 'swag/llm-agent',
    kind: 'llm-agent',
    inputs: null,
    outputs: null,
    operations: [],
    credentials: [],
    egress: [],
  },
  human: {
    type: 'swag/human',
    kind: 'human',
    inputs: null,
    outputs: null,
    operations: [],
    credentials: [],
    egress: [],
  },
};

const manifest = (kind: NodeKind, patch: Record<string, unknown> = {}) => ({
  version: '1.0.0',
  title: 'Узел',
  description: 'Описание узла.',
  settings: SCHEMA,
  ...BASE[kind],
  ...patch,
});

// [вид, поля-нарушения, path issue, сообщение issue] — таблица 4.1.3.
const RULE_VIOLATIONS: Array<[NodeKind, Record<string, unknown>, string, string]> = [
  ['trigger', { inputs: SCHEMA }, 'inputs', 'trigger: inputs must be null'],
  ['trigger', { outputs: null }, 'outputs', 'trigger: outputs is required'],
  ['trigger', { operations: [OPERATION] }, 'operations', 'trigger: operations must be empty'],
  ['channel', { inputs: null }, 'inputs', 'channel: inputs is required'],
  ['channel', { outputs: null }, 'outputs', 'channel: outputs is required'],
  ['channel', { operations: [OPERATION] }, 'operations', 'channel: operations must be empty'],
  ['connector', { inputs: SCHEMA }, 'inputs', 'connector: inputs must be null'],
  ['connector', { outputs: SCHEMA }, 'outputs', 'connector: outputs must be null'],
  ['connector', { operations: [] }, 'operations', 'connector: operations is required'],
  ['program', { inputs: null }, 'inputs', 'program: inputs is required'],
  ['program', { outputs: null }, 'outputs', 'program: outputs is required'],
  ['program', { operations: [OPERATION] }, 'operations', 'program: operations must be empty'],
  ['llm-agent', { inputs: SCHEMA }, 'inputs', 'llm-agent: inputs must be null'],
  ['llm-agent', { outputs: SCHEMA }, 'outputs', 'llm-agent: outputs must be null'],
  ['llm-agent', { operations: [OPERATION] }, 'operations', 'llm-agent: operations must be empty'],
  [
    'llm-agent',
    { credentials: [CREDENTIAL] },
    'credentials',
    'llm-agent: credentials must be empty',
  ],
  ['llm-agent', { egress: [HOST] }, 'egress', 'llm-agent: egress must be empty'],
  ['human', { inputs: SCHEMA }, 'inputs', 'human: inputs must be null'],
  ['human', { outputs: SCHEMA }, 'outputs', 'human: outputs must be null'],
  ['human', { operations: [OPERATION] }, 'operations', 'human: operations must be empty'],
  ['human', { credentials: [CREDENTIAL] }, 'credentials', 'human: credentials must be empty'],
  ['human', { egress: [HOST] }, 'egress', 'human: egress must be empty'],
];

describe('манифест узла', () => {
  it('AC-021-1: манифест echo проходит, лишнее поле image — ошибка', () => {
    expect(NodeManifest.safeParse(ECHO).success).toBe(true);
    expect(NodeManifest.safeParse({ ...ECHO, image: 'node:24' }).success).toBe(false);
  });

  it('AC-021-2: по верному манифесту на каждый вид — успех', () => {
    for (const kind of NodeKind.options) {
      expect(NodeManifest.safeParse(manifest(kind)).success, kind).toBe(true);
    }
  });

  it('AC-021-2: нарушение каждой клетки таблицы 4.1.3 — ошибка с path и сообщением', () => {
    for (const [kind, patch, path, message] of RULE_VIOLATIONS) {
      const result = NodeManifest.safeParse(manifest(kind, patch));
      expect(result.success, message).toBe(false);
      expect(result.error?.issues, message).toContainEqual(
        expect.objectContaining({ path: [path], message }),
      );
    }
  });

  it('AC-021-2: повтор операции, credential или хоста в egress — ошибка по таблице 4.1.2', () => {
    const duplicates: Array<[Record<string, unknown>, string, string]> = [
      [
        manifest('connector', { operations: [OPERATION, OPERATION] }),
        'operations',
        'operations: duplicate name list',
      ],
      [
        manifest('connector', { credentials: [CREDENTIAL, CREDENTIAL] }),
        'credentials',
        'credentials: duplicate name apiKey',
      ],
      [manifest('connector', { egress: [HOST, HOST] }), 'egress', `egress: duplicate host ${HOST}`],
    ];
    for (const [input, path, message] of duplicates) {
      const result = NodeManifest.safeParse(input);
      expect(result.success, message).toBe(false);
      expect(result.error?.issues, message).toContainEqual(
        expect.objectContaining({ path: [path], message }),
      );
    }
  });

  it('AC-021-3: llm-agent и human вне пространства swag — ошибка kind, другие виды — нет', () => {
    for (const kind of ['llm-agent', 'human'] as const) {
      const result = NodeManifest.safeParse(manifest(kind, { type: 'acme/agent' }));
      expect(result.success).toBe(false);
      expect(result.error?.issues).toContainEqual(
        expect.objectContaining({
          path: ['kind'],
          message: `kind ${kind} is reserved for swag/*`,
        }),
      );
    }
    expect(NodeManifest.safeParse(manifest('channel', { type: 'acme/chat' })).success).toBe(true);
  });

  it('AC-021-22: поле settings с именем credential — ошибка; без properties правило не срабатывает', () => {
    const clash = NodeManifest.safeParse(
      manifest('program', {
        settings: { type: 'object', properties: { apiKey: { type: 'string' } } },
        credentials: [CREDENTIAL],
      }),
    );
    expect(clash.success).toBe(false);
    expect(clash.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ['settings'],
        message: 'settings: field apiKey is a credential',
      }),
    );
    expect(
      NodeManifest.safeParse(manifest('program', { settings: SCHEMA, credentials: [CREDENTIAL] }))
        .success,
    ).toBe(true);
  });

  it('REQ-021-16: credential несёт имя и вид, значение в нём — ошибка', () => {
    expect(NodeCredential.safeParse(CREDENTIAL).success).toBe(true);
    expect(NodeCredential.safeParse({ ...CREDENTIAL, value: 'secret' }).success).toBe(false);
  });

  it('REQ-021-1: имя типа — пространство/имя, версия — semver без пререлиза', () => {
    expect(NodeTypeName.safeParse('example/echo').success).toBe(true);
    expect(NodeTypeName.safeParse('echo').success).toBe(false);
    expect(NodeTypeName.safeParse('Example/echo').success).toBe(false);
    expect(NodeTypeVersion.safeParse('1.0.0').success).toBe(true);
    expect(NodeTypeVersion.safeParse('1.0').success).toBe(false);
    expect(NodeTypeVersion.safeParse('1.0.0-beta').success).toBe(false);
    expect(NodeTypeVersion.safeParse('01.0.0').success).toBe(false);
  });

  it('REQ-021-1: nodeTypeRef и parseNodeTypeRef собирают и делят ссылку type@version', () => {
    const ref = nodeTypeRef('example/echo', '1.10.0');
    expect(ref).toBe('example/echo@1.10.0');
    expect(NodeTypeRef.safeParse(ref).success).toBe(true);
    expect(parseNodeTypeRef(ref)).toEqual({ type: 'example/echo', version: '1.10.0' });
    expect(NodeTypeRef.safeParse('example/echo').success).toBe(false);
  });

  it('REQ-021-1: хост выхода — без схемы, IP и localhost, порт до 65535', () => {
    for (const host of ['api.example.com', '*.cdn.example.com', 'api.example.com:8443']) {
      expect(EgressHost.safeParse(host).success, host).toBe(true);
    }
    for (const host of [
      'localhost',
      '127.0.0.1',
      'Api.example.com',
      'https://api.example.com',
      'api.example.com:70000',
    ]) {
      expect(EgressHost.safeParse(host).success, host).toBe(false);
    }
  });
});
