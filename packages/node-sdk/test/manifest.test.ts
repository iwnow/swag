import { describe, expect, it } from 'vitest';
import { NodeManifest } from '@swag/contracts';
import { z, ZodError } from 'zod';
import { defineNode, toManifest } from '../src/index.ts';

const SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

// Спека 021, 5: AC-021-10. Коннектор с двумя операциями, credentials и egress.
const crm = defineNode({
  type: 'example/crm',
  version: '1.0.0',
  kind: 'connector',
  title: 'CRM',
  description: 'Коннектор к CRM для проверки манифеста.',
  settings: z.strictObject({ baseUrl: z.string().max(200) }),
  credentials: [{ name: 'apiKey', title: 'Ключ', kind: 'api-key' }],
  egress: ['api.example.com'],
  operations: {
    find: {
      title: 'Найти',
      description: 'Ищет контакт по строке.',
      access: 'read',
      input: z.strictObject({ q: z.string() }),
      output: z.strictObject({ id: z.string() }),
      execute: async (input) => ({ id: input.q }),
    },
    count: {
      title: 'Посчитать',
      description: 'Считает контакты.',
      access: 'read',
      input: z.strictObject({}),
      output: z.strictObject({ n: z.number().default(0) }),
      execute: async () => ({ n: 0 }),
    },
  },
});

const echo = defineNode({
  type: 'example/echo',
  version: '1.0.0',
  kind: 'program',
  title: 'Эхо',
  description: 'Пример программы.',
  settings: z.strictObject({ prefix: z.string().max(40).default('') }),
  inputs: z.strictObject({ text: z.string().max(4000) }),
  outputs: z.strictObject({ text: z.string() }),
  execute: async ({ text }, ctx) => ({ text: ctx.settings.prefix + text }),
});

describe('toManifest', () => {
  it('AC-021-10: манифест коннектора проходит NodeManifest.parse', () => {
    const manifest = toManifest(crm);
    expect(NodeManifest.parse(manifest)).toEqual(manifest);
    expect(manifest.inputs).toBeNull();
    expect(manifest.outputs).toBeNull();
    expect(manifest.credentials).toEqual([{ name: 'apiKey', title: 'Ключ', kind: 'api-key' }]);
    expect(manifest.egress).toEqual(['api.example.com']);
  });

  it('AC-021-10: operations в порядке ключей с name, access и JSON Schema 2020-12', () => {
    const manifest = toManifest(crm);
    expect(manifest.operations.map((op) => op.name)).toEqual(['find', 'count']);
    const [find, count] = manifest.operations;
    expect(find).toMatchObject({ name: 'find', access: 'read', title: 'Найти' });
    expect(find?.input.$schema).toBe(SCHEMA_2020_12);
    expect(find?.output.$schema).toBe(SCHEMA_2020_12);
    expect(count?.output.$schema).toBe(SCHEMA_2020_12);
  });

  it('AC-021-10: в output второй операции required содержит n', () => {
    const count = toManifest(crm).operations[1];
    expect(count?.output.required).toContain('n');
  });

  it('AC-021-10: программа без credentials и egress получает пустые массивы', () => {
    const manifest = toManifest(echo);
    expect(manifest.credentials).toEqual([]);
    expect(manifest.egress).toEqual([]);
    expect(manifest.operations).toEqual([]);
    expect(manifest.settings.$schema).toBe(SCHEMA_2020_12);
  });

  it('AC-021-10: коннектор без операций — toManifest бросает ZodError', () => {
    const empty = defineNode({
      type: 'example/empty',
      version: '1.0.0',
      kind: 'connector',
      title: 'Пустой',
      description: 'Без операций.',
      settings: z.strictObject({}),
      operations: {},
    });
    expect(() => toManifest(empty)).toThrow(ZodError);
  });
});
