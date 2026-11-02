import { z } from 'zod';
import {
  type NodeManifest,
  type NodeTypeRef,
  NodeTypeRef as NodeTypeRefSchema,
  type NodeTypeSummary,
  nodeTypeRef,
} from '@swag/contracts';

// Спека 021, 4.2. Реестр типов узлов в памяти: источник — манифесты, прошедшие NodeManifest.parse.

export interface SettingsIssue {
  path: string; // ключи через точку: "limits.maxSteps", корень — ""
  message: string;
}

export type NodeRegistryError =
  | { code: 'node_type_duplicate'; ref: NodeTypeRef }
  | { code: 'node_schema_unsupported'; ref: NodeTypeRef; schema: string; message: string };

export type SettingsResult =
  | { ok: true; settings: Record<string, unknown> }
  | {
      ok: false;
      error:
        { code: 'node_type_not_found' } | { code: 'invalid_settings'; issues: SettingsIssue[] };
    };

// Спека 026, 4.2: куда относится значение — вход, выход или вход/выход операции коннектора.
export type NodeSchemaTarget =
  | { place: 'inputs' }
  | { place: 'outputs' }
  | { place: 'operation'; name: string; io: 'input' | 'output' };

export type ValueResult =
  | { ok: true; value: unknown } // результат parse схемы
  | {
      ok: false;
      error:
        | { code: 'node_type_not_found' }
        | { code: 'schema_not_found' }
        | { code: 'invalid_value'; issues: SettingsIssue[] };
    };

export interface NodeRegistry {
  list(): NodeTypeSummary[];
  get(ref: string): NodeManifest | null;
  validateSettings(ref: string, settings: unknown): SettingsResult;
  validate(ref: string, target: NodeSchemaTarget, value: unknown): ValueResult;
}

// Схемы строятся один раз при создании реестра (021, 4.2; 026, 4.2). null в манифесте — схемы нет.
interface Schemas {
  settings: z.ZodType;
  inputs: z.ZodType | null;
  outputs: z.ZodType | null;
  operations: Map<string, { input: z.ZodType; output: z.ZodType }>;
}

interface Entry {
  manifest: NodeManifest;
  schemas: Schemas;
}

export function createNodeRegistry(
  manifests: readonly NodeManifest[],
): { ok: true; registry: NodeRegistry } | { ok: false; error: NodeRegistryError } {
  const refs = new Set<string>();
  for (const manifest of manifests) {
    const ref = nodeTypeRef(manifest.type, manifest.version);
    if (refs.has(ref)) return { ok: false, error: { code: 'node_type_duplicate', ref } };
    refs.add(ref);
  }

  const entries = new Map<string, Entry>();
  for (const manifest of manifests) {
    const ref = nodeTypeRef(manifest.type, manifest.version);
    const compiled = compileManifest(ref, manifest);
    if (!compiled.ok) return compiled;
    entries.set(ref, { manifest, schemas: compiled.schemas });
  }

  return { ok: true, registry: createRegistry(entries) };
}

type Compiled = { ok: true; schemas: Schemas } | { ok: false; error: NodeRegistryError };

// Порядок проверки поддержки: settings, inputs, outputs, затем входы и выходы операций по порядку манифеста.
function compileManifest(ref: NodeTypeRef, manifest: NodeManifest): Compiled {
  const settings = toZod(ref, 'settings', manifest.settings);
  if (!settings.ok) return settings;
  const inputs = compileOptional(ref, 'inputs', manifest.inputs);
  if (!inputs.ok) return inputs;
  const outputs = compileOptional(ref, 'outputs', manifest.outputs);
  if (!outputs.ok) return outputs;
  const operations = new Map<string, { input: z.ZodType; output: z.ZodType }>();
  for (const op of manifest.operations) {
    const input = toZod(ref, `operations.${op.name}.input`, op.input);
    if (!input.ok) return input;
    const output = toZod(ref, `operations.${op.name}.output`, op.output);
    if (!output.ok) return output;
    operations.set(op.name, { input: input.schema, output: output.schema });
  }
  return {
    ok: true,
    schemas: {
      settings: settings.schema,
      inputs: inputs.schema,
      outputs: outputs.schema,
      operations,
    },
  };
}

function compileOptional(
  ref: NodeTypeRef,
  schema: string,
  json: Record<string, unknown> | null,
): { ok: true; schema: z.ZodType | null } | { ok: false; error: NodeRegistryError } {
  if (json === null) return { ok: true, schema: null };
  return toZod(ref, schema, json);
}

function toZod(
  ref: NodeTypeRef,
  schema: string,
  json: Record<string, unknown>,
): { ok: true; schema: z.ZodType } | { ok: false; error: NodeRegistryError } {
  try {
    return { ok: true, schema: z.fromJSONSchema(json as never) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { code: 'node_schema_unsupported', ref, schema, message } };
  }
}

function createRegistry(entries: Map<string, Entry>): NodeRegistry {
  const summaries = summarize(entries);

  const lookup = (ref: string): Entry | null => {
    const parsed = NodeTypeRefSchema.safeParse(ref);
    return parsed.success ? (entries.get(parsed.data) ?? null) : null;
  };

  return {
    list: () => summaries.slice(),
    get: (ref) => lookup(ref)?.manifest ?? null,
    validateSettings(ref, settings) {
      const entry = lookup(ref);
      if (!entry) return { ok: false, error: { code: 'node_type_not_found' } };
      const result = checkValue(entry.schemas.settings, settings);
      if (result.ok) return { ok: true, settings: result.value as Record<string, unknown> };
      return { ok: false, error: { code: 'invalid_settings', issues: result.error.issues } };
    },
    validate(ref, target, value) {
      const entry = lookup(ref);
      if (!entry) return { ok: false, error: { code: 'node_type_not_found' } };
      const schema = schemaFor(entry.schemas, target);
      if (!schema) return { ok: false, error: { code: 'schema_not_found' } };
      const result = checkValue(schema, value);
      if (result.ok) return result;
      return { ok: false, error: { code: 'invalid_value', issues: result.error.issues } };
    },
  };
}

function schemaFor(schemas: Schemas, target: NodeSchemaTarget): z.ZodType | null {
  if (target.place === 'inputs') return schemas.inputs;
  if (target.place === 'outputs') return schemas.outputs;
  return schemas.operations.get(target.name)?.[target.io] ?? null;
}

// Один путь проверки для настроек и значений (026, 4.2): ошибки Zod — SettingsIssue.
function checkValue(
  schema: z.ZodType,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; error: { issues: SettingsIssue[] } } {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  return { ok: false, error: { issues } };
}

// REQ-021-6: одна запись на type — последняя версия; типы по возрастанию type.
function summarize(entries: Map<string, Entry>): NodeTypeSummary[] {
  const byType = new Map<string, NodeManifest[]>();
  for (const { manifest } of entries.values()) {
    byType.set(manifest.type, [...(byType.get(manifest.type) ?? []), manifest]);
  }
  return [...byType.keys()].sort(compareText).map((type) => {
    const sorted = (byType.get(type) ?? []).sort((a, b) => compareSemver(b.version, a.version));
    const latest = sorted[0]!;
    return {
      type,
      version: latest.version,
      versions: sorted.map((m) => m.version),
      kind: latest.kind,
      title: latest.title,
      description: latest.description,
    };
  });
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
