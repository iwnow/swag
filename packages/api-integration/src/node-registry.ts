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

export interface NodeRegistry {
  list(): NodeTypeSummary[];
  get(ref: string): NodeManifest | null;
  validateSettings(ref: string, settings: unknown): SettingsResult;
}

interface Entry {
  manifest: NodeManifest;
  settings: z.ZodType;
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
    entries.set(ref, { manifest, settings: compiled.settings });
  }

  return { ok: true, registry: createRegistry(entries) };
}

type Compiled = { ok: true; settings: z.ZodType } | { ok: false; error: NodeRegistryError };

// Схемы inputs, outputs и операций проверяются на поддержку и не хранятся: в реестре нужна только проверка настроек.
function compileManifest(ref: NodeTypeRef, manifest: NodeManifest): Compiled {
  const settings = toZod(ref, 'settings', manifest.settings);
  if (!settings.ok) return settings;
  const schemas: [string, Record<string, unknown> | null][] = [
    ['inputs', manifest.inputs],
    ['outputs', manifest.outputs],
    ...manifest.operations.flatMap((op): [string, Record<string, unknown>][] => [
      [`operations.${op.name}.input`, op.input],
      [`operations.${op.name}.output`, op.output],
    ]),
  ];
  for (const [schema, json] of schemas) {
    if (json === null) continue;
    const compiled = toZod(ref, schema, json);
    if (!compiled.ok) return compiled;
  }
  return { ok: true, settings: settings.schema };
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
      const result = entry.settings.safeParse(settings);
      if (result.success) return { ok: true, settings: result.data as Record<string, unknown> };
      const issues = result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      }));
      return { ok: false, error: { code: 'invalid_settings', issues } };
    },
  };
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
