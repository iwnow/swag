import { z } from 'zod';

// Спека 021, 4.1. Вид узла задаёт обработчики, которые реализует код узла (4.3).
export const NodeKind = z.enum([
  'trigger',
  'channel',
  'connector',
  'llm-agent',
  'program',
  'human',
]);
export type NodeKind = z.infer<typeof NodeKind>;

const NAME = '[a-z][a-z0-9-]{0,39}/[a-z][a-z0-9-]{0,39}';
const SEMVER = '(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})\\.(0|[1-9][0-9]{0,5})';

// <пространство>/<имя>: example/echo, swag/llm-agent. Пространство swag — только пакеты платформы (REQ-021-3).
export const NodeTypeName = z.string().regex(new RegExp(`^${NAME}$`));
export type NodeTypeName = z.infer<typeof NodeTypeName>;

// semver без пререлиза и сборки: 1.0.0
export const NodeTypeVersion = z.string().regex(new RegExp(`^${SEMVER}$`));
export type NodeTypeVersion = z.infer<typeof NodeTypeVersion>;

// type@version — так граф ссылается на тип (роадмап, раздел 4)
export const NodeTypeRef = z.string().regex(new RegExp(`^${NAME}@${SEMVER}$`));
export type NodeTypeRef = z.infer<typeof NodeTypeRef>;

export function nodeTypeRef(type: NodeTypeName, version: NodeTypeVersion): NodeTypeRef {
  return `${type}@${version}`;
}

export function parseNodeTypeRef(ref: NodeTypeRef): {
  type: NodeTypeName;
  version: NodeTypeVersion;
} {
  const at = ref.lastIndexOf('@');
  return { type: ref.slice(0, at), version: ref.slice(at + 1) };
}

// JSON Schema 2020-12 как данные. NodeManifest содержимое схем не проверяет — это делает реестр через z.fromJSONSchema (4.2).
export const JsonSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchema>;

// Схема настроек — объект: корень с type: 'object'.
export const SettingsSchema = JsonSchema.refine(
  (s) => s['type'] === 'object',
  'settings: type must be object',
);

export const OperationAccess = z.enum(['read', 'write', 'destructive']);
export type OperationAccess = z.infer<typeof OperationAccess>;

export const NodeOperation = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), // имя инструмента для LLM-агента
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(1000),
  access: OperationAccess,
  input: JsonSchema,
  output: JsonSchema,
});
export type NodeOperation = z.infer<typeof NodeOperation>;

export const CredentialKind = z.enum(['api-key', 'oauth2']);
export type CredentialKind = z.infer<typeof CredentialKind>;

// Значения секретов в манифесте нет: только имя и вид (Q-7, REQ-021-16).
export const NodeCredential = z.strictObject({
  name: z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/),
  title: z.string().trim().min(1).max(80),
  kind: CredentialKind,
});
export type NodeCredential = z.infer<typeof NodeCredential>;

// Хост выхода: имя в нижнем регистре, TLD — буквы или punycode (xn--), необязательный префикс "*." и порт 1–65535.
export const EgressHost = z
  .string()
  .regex(
    /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})(:[1-9][0-9]{0,4})?$/,
  )
  .refine((h) => !h.includes(':') || Number(h.split(':')[1]) <= 65535, 'egress: port out of range');
export type EgressHost = z.infer<typeof EgressHost>;

// Спека 026, 4.1 (REQ-026-13): единое правило сверки хоста с egress для SDK и прокси.
// Запись без порта — порт 443; "*.example.com" — любой хост, оканчивающийся на ".example.com".
// Допущение: hostname в нижнем регистре, без скобок IPv6 — вызывающий нормализует (4.1).
export function egressMatches(
  egress: readonly EgressHost[],
  hostname: string,
  port: number,
): boolean {
  return egress.some((entry) => {
    const colon = entry.indexOf(':');
    const host = colon === -1 ? entry : entry.slice(0, colon);
    const entryPort = colon === -1 ? 443 : Number(entry.slice(colon + 1));
    if (entryPort !== port) return false;
    return host.startsWith('*.') ? hostname.endsWith(host.slice(1)) : hostname === host;
  });
}

// Спека 026, 4.1: коды ошибок узла. Совпадают с NodeErrorCode SDK (021, 4.3).
export const NodeErrorCode = z.enum([
  'secret_not_declared',
  'egress_denied',
  'invalid_settings',
  'invalid_input',
  'invalid_output',
  'unknown_operation',
]);
export type NodeErrorCode = z.infer<typeof NodeErrorCode>;

const NodeManifestShape = z.strictObject({
  type: NodeTypeName,
  version: NodeTypeVersion,
  kind: NodeKind,
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(2000),
  settings: SettingsSchema,
  credentials: z.array(NodeCredential).max(8),
  inputs: JsonSchema.nullable(),
  outputs: JsonSchema.nullable(),
  operations: z.array(NodeOperation).max(32),
  egress: z.array(EgressHost).max(16),
});
type NodeManifestShape = z.infer<typeof NodeManifestShape>;

export const NodeManifest = NodeManifestShape.superRefine(checkKindRules);
export type NodeManifest = z.infer<typeof NodeManifest>;

type Slot = 'null' | 'required';

type KindRule = {
  inputs: Slot;
  outputs: Slot;
  operations: 'empty' | 'required';
  credentials: 'empty' | 'any';
  egress: 'empty' | 'any';
};

// Спека 021, 4.1.3: таблица правил вида.
const KIND_RULES: Record<NodeKind, KindRule> = {
  trigger: {
    inputs: 'null',
    outputs: 'required',
    operations: 'empty',
    credentials: 'any',
    egress: 'any',
  },
  channel: {
    inputs: 'required',
    outputs: 'required',
    operations: 'empty',
    credentials: 'any',
    egress: 'any',
  },
  connector: {
    inputs: 'null',
    outputs: 'null',
    operations: 'required',
    credentials: 'any',
    egress: 'any',
  },
  program: {
    inputs: 'required',
    outputs: 'required',
    operations: 'empty',
    credentials: 'any',
    egress: 'any',
  },
  'llm-agent': {
    inputs: 'null',
    outputs: 'null',
    operations: 'empty',
    credentials: 'empty',
    egress: 'empty',
  },
  human: {
    inputs: 'null',
    outputs: 'null',
    operations: 'empty',
    credentials: 'empty',
    egress: 'empty',
  },
};

// Спека 021, 4.1.2 и 4.1.3. Сообщения issue — из таблиц дословно.
function checkKindRules(manifest: NodeManifestShape, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  const repeated = (values: string[]) => [
    ...new Set(values.filter((value, i) => values.indexOf(value) !== i)),
  ];

  for (const name of repeated(manifest.operations.map((o) => o.name))) {
    issue('operations', `operations: duplicate name ${name}`);
  }
  for (const name of repeated(manifest.credentials.map((c) => c.name))) {
    issue('credentials', `credentials: duplicate name ${name}`);
  }
  for (const host of repeated(manifest.egress)) {
    issue('egress', `egress: duplicate host ${host}`);
  }

  const properties: unknown = manifest.settings['properties'];
  if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
    for (const { name } of manifest.credentials) {
      if (Object.hasOwn(properties, name)) {
        issue('settings', `settings: field ${name} is a credential`);
      }
    }
  }

  if (
    (manifest.kind === 'llm-agent' || manifest.kind === 'human') &&
    !manifest.type.startsWith('swag/')
  ) {
    issue('kind', `kind ${manifest.kind} is reserved for swag/*`);
  }

  const { kind } = manifest;
  const rule = KIND_RULES[kind];
  for (const field of ['inputs', 'outputs'] as const) {
    const value = manifest[field];
    if (rule[field] === 'null' && value !== null) issue(field, `${kind}: ${field} must be null`);
    if (rule[field] === 'required' && value === null) {
      issue(field, `${kind}: ${field} is required`);
    }
  }
  if (rule.operations === 'empty' && manifest.operations.length > 0) {
    issue('operations', `${kind}: operations must be empty`);
  }
  if (rule.operations === 'required' && manifest.operations.length === 0) {
    issue('operations', `${kind}: operations is required`);
  }
  for (const field of ['credentials', 'egress'] as const) {
    if (rule[field] === 'empty' && manifest[field].length > 0) {
      issue(field, `${kind}: ${field} must be empty`);
    }
  }
}

// Запись каталога: последняя версия типа и список всех версий (REQ-021-6).
export const NodeTypeSummary = z.strictObject({
  type: NodeTypeName,
  version: NodeTypeVersion,
  versions: z.array(NodeTypeVersion).min(1), // по убыванию semver
  kind: NodeKind,
  title: z.string(),
  description: z.string(),
});
export type NodeTypeSummary = z.infer<typeof NodeTypeSummary>;

export const NodeTypeList = z.strictObject({ items: z.array(NodeTypeSummary) });
export type NodeTypeList = z.infer<typeof NodeTypeList>;
