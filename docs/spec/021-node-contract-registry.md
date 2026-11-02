---
id: "021"
title: Контракт и реестр узлов
status: in-progress
roadmap_stage: 8а
depends_on: ["001", "024", "031"]
superseded_by: null
updated: 2026-11-02
---

# 021. Контракт и реестр узлов

> **Коротко.**
>
> - **Что появится.** Публичный контракт типа узла — манифест `NodeManifest` в `@swag/contracts`, SDK `@swag/node-sdk` для авторов узлов, реестр типов узлов и каталог в `api`: `GET /node-types` и `GET /node-types/:namespace/:name/:version`.
> - **Как пишется узел.** Автор описывает узел в TypeScript через `defineNode` из SDK: схемы настроек, входа, выхода и операций — на Zod, настройки в обработчиках типизированы. SDK выгружает манифест в файл `swag-node.json` пакета, схемы в нём — JSON Schema 2020-12 (D-33 → Q-1).
> - **Как тип попадает в реестр.** Пакет узла ставится в `node_modules`, его имя дописывается в `NODE_PACKAGES` у `api`. При старте `api` читает только `swag-node.json` пакетов — код узла в процессе `api` не исполняется. Ядра, редактор и координатор не правятся.
> - **Что проверяет реестр.** Манифест по правилам вида узла, уникальность `type@version`, настройки узла — по схеме `settings` (`validateSettings`). Проверку графа целиком и вызов из оркестратора делает спека 009 (D-157).
> - **Какие типы будут сразу.** `swag/llm-agent@1.0.0` — LLM-агент, схема настроек выводится из `AgentDraft`; `example/echo@1.0.0` — пример программы из отдельного пакета, он же доказывает, что тип подключается без правки ядер.
> - **Что не входит.** Исполнение кода узла, песочница, исходящий прокси, хранение секретов и запись стоимости — спека 026; граф — 009; редактор — 017.
> - **Решения человека (2026-11-02).** Вопросы Q-1…Q-8 закрыты по рекомендациям: схемы — Zod в SDK, JSON Schema 2020-12 в манифесте (Q-1); секреты — только через `credentials` (Q-7); программа — пакет с кодом (Q-3).

## 1. Контекст и цель

Роадмап, раздел 4 «Граф процесса», абзац «Узел — плагин с общим контрактом», и этап 8а «Контракт узлов». Этап разбит на две спеки: 021 — контракт, реестр, каталог и SDK; 026 — исполнение кода узла в песочнице, контекст исполнения на платформе, исходящий прокси и секреты.

Сейчас узлов нет: рой — список агентов `AgentDraft` в `SwarmCreateRequest`, вид у всех один, настройки зашиты в схему `@swag/contracts`. Новый вид агента или программа требуют правки контрактов, `api-core`, оркестратора и UI.

После спеки у платформы есть один публичный контракт типа узла. Тип узла — npm-пакет с манифестом; платформа узнаёт о нём из `NODE_PACKAGES`, показывает его в каталоге и проверяет настройки экземпляра по схеме из манифеста. LLM-агент описан тем же манифестом, что и сторонний узел. Граф (009), редактор (017) и координатор (027) строятся поверх этого каталога.

## 2. Объём

**Входит:**

- схемы `NodeManifest`, `NodeKind`, `NodeTypeName`, `NodeTypeVersion`, `NodeTypeRef`, `NodeTypeSummary` и правила вида узла в `@swag/contracts` (4.1);
- реестр типов узлов `createNodeRegistry` в `@swag/api-integration`: список, получение, `validateSettings` (4.2);
- пакет `@swag/node-sdk`: `defineNode`, типы обработчиков по видам, тип `NodeContext`, `toManifest`, тестовая обвязка `createTestContext`, `runNode`, `runOperation`, `runPoll`, `runSend` (4.3);
- пакеты узлов `@swag/node-llm-agent` (`swag/llm-agent@1.0.0`) и `@swag/node-example` (`example/echo@1.0.0`) с `swag-node.json` (4.4);
- скрипт `npm run nodes:manifest` — выгрузка `swag-node.json` пакетов узлов из их определений (4.5);
- право `node.read`, операции `listNodeTypes` и `getNodeType` в `api-core`, зависимость `NodeRegistry` (4.6);
- загрузка манифестов из `NODE_PACKAGES` в оболочке `api`, маршруты каталога (4.7, 4.8, 4.9);
- README новых и затронутых пакетов, `docs/architecture.md`, глоссарий, корневой README.

**Не входит** (агент это не делает, даже если кажется логичным):

- исполнение кода узла: песочница, вызов `execute`, `poll`, `send`, исходящий прокси по `egress`, хранение секретов организации, реализация `NodeContext` на платформе — спека 026 (D-32, D-34);
- запись стоимости из кода узла и тариф compute — 026 и 005 (D-126); в `NodeContext` 021 этого поля нет;
- триггер с подпиской (`start` / `stop`, вебхуки) — решается в спеке канала Авито 020; в 021 у триггера и канала только `poll`;
- граф процесса, проверка рёбер «поток» по `inputs` / `outputs`, проверка настроек оркестратором при запуске и доставка реестра в оркестратор — спека 009 (D-157);
- замена `AgentDraft` и формы роя на узел `swag/llm-agent`: рой по-прежнему создаётся `SwarmCreateRequest` — 009 и 017;
- вид `human` и его манифест — спека 028; в 021 вид есть в `NodeKind`, типов этого вида нет;
- палитра и форма настроек в UI, подсказки виджетов — спека 017 (Q-2);
- каталог для координатора — спека 027;
- публикация сторонних пакетов, модерация, подпись, загрузка пакета в работающую платформу — D-32, 026;
- совместимость с узлами n8n — D-31, после MVP;
- MCP как способ исполнения контракта — этап 12;
- хранение реестра в Postgres: типы живут в памяти `api`, источник — установленные пакеты.

## 3. Требования

| ID | Требование | Приоритет |
|---|---|---|
| REQ-021-1 | `NodeManifest` MUST описывать тип узла полями `type`, `version`, `kind`, `title`, `description`, `settings`, `credentials`, `inputs`, `outputs`, `operations`, `egress` по схеме 4.1; лишнее поле — ошибка. | MUST |
| REQ-021-2 | `NodeManifest` MUST отклонять манифест, который нарушает правила 4.1.2 и 4.1.3, с сообщением issue из этих таблиц. | MUST |
| REQ-021-3 | Типы видов `llm-agent` и `human` MUST иметь пространство имён `swag`; тип любого вида в пространстве `swag` может объявить только пакет `@swag/*` (проверяет загрузчик 4.7). | MUST |
| REQ-021-4 | `createNodeRegistry` MUST отклонять набор манифестов с повтором `type@version` и манифест, схему которого нельзя превратить в проверку (`z.fromJSONSchema` бросает), с кодом ошибки и `type@version` в ответе. | MUST |
| REQ-021-5 | `NodeRegistry.validateSettings(ref, settings)` MUST проверять настройки по схеме `settings` манифеста и возвращать `invalid_settings` со списком `issues` (путь и сообщение) или `node_type_not_found`; верные настройки — `ok` с настройками после схемы (значения по умолчанию подставлены). | MUST |
| REQ-021-6 | `NodeRegistry.list()` MUST отдавать по одной записи на `type` — последнюю версию по semver — со списком всех версий, отсортировано по `type`. | MUST |
| REQ-021-7 | `@swag/node-sdk` MUST давать `defineNode` с перегрузкой на каждый вид (4.3): настройки, вход и выход в обработчиках типизированы схемами определения. | MUST |
| REQ-021-8 | `toManifest` MUST строить `NodeManifest` из определения по правилам 4.3 и возвращать результат `NodeManifest.parse`. | MUST |
| REQ-021-9 | `@swag/node-sdk/testing` MUST запускать обработчики узла без платформы с проверкой настроек, входа и выхода по схемам определения; секрет, не объявленный в `credentials` или не переданный, и HTTP к адресу вне правил `egress` 4.3 — `NodeError` без вызова сети. | MUST |
| REQ-021-10 | Пакет `@swag/node-llm-agent` MUST объявлять `swag/llm-agent@1.0.0`, схема `settings` которого выводится из `AgentDraft`: на наборе из 4.4 `AgentDraft.safeParse` и `validateSettings` дают одинаковый итог. | MUST |
| REQ-021-11 | Пакет `@swag/node-example` MUST объявлять программу `example/echo@1.0.0` и импортировать в `src` только `zod` и `@swag/node-sdk`. | MUST |
| REQ-021-12 | `swag-node.json` каждого пакета узла в репозитории MUST совпадать с `toManifest` его определения; `npm run nodes:manifest` перезаписывает файлы. | MUST |
| REQ-021-13 | `api` MUST при старте, сразу после чтения конфигурации, читать `swag-node.json` пакетов из `NODE_PACKAGES` и не импортировать код пакета; любая ошибка загрузки или реестра — лог `error` `node_manifest_invalid` с полями `package` и `err` и выход с кодом 1 до подключения к Postgres и NATS. | MUST |
| REQ-021-14 | `GET /node-types` MUST отдавать `NodeRegistry.list()`, `GET /node-types/:namespace/:name/:version` — манифест или `404 not_found`; оба — только с правом `node.read`, без токена — `401`. | MUST |
| REQ-021-15 | Подключение нового типа узла MUST требовать только установки пакета и строки в `NODE_PACKAGES`: без правки `packages/*-core`, `@swag/contracts`, `@swag/api-integration` и `apps/*/src`. | MUST |
| REQ-021-16 | Доступ узла к внешней системе MUST объявляться только в `credentials` (имя и вид, без значения); поле верхнего уровня `settings` с именем из `credentials` — ошибка манифеста (Q-7). | MUST |
| REQ-021-17 | `NODE_PACKAGES` MUST разбираться по 4.9: пустое значение — пустой список, пустой элемент или повтор имени — ошибка конфигурации. | MUST |

## 4. Контракты

### 4.1. `@swag/contracts`, `node.ts`

Новый файл `packages/contracts/src/node.ts`, экспорт через `index.ts`. Числа-пороги — предложение, решаются в Q-4.

```ts
import { z } from 'zod';

// Спека 021, 4.1. Вид узла задаёт обработчики, которые реализует код узла (4.3).
export const NodeKind = z.enum(['trigger', 'channel', 'connector', 'llm-agent', 'program', 'human']);
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

export function nodeTypeRef(type: NodeTypeName, version: NodeTypeVersion): NodeTypeRef; // `${type}@${version}`
export function parseNodeTypeRef(ref: NodeTypeRef): { type: NodeTypeName; version: NodeTypeVersion }; // делит по последнему '@'

// JSON Schema 2020-12 как данные. NodeManifest содержимое схем не проверяет — это делает реестр через z.fromJSONSchema (4.2).
export const JsonSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchema>;

// Схема настроек — объект: корень с type: 'object'.
export const SettingsSchema = JsonSchema.refine((s) => s.type === 'object', 'settings: type must be object');

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

export const NodeCredential = z.strictObject({
  name: z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/),
  title: z.string().trim().min(1).max(80),
  kind: CredentialKind,
});
export type NodeCredential = z.infer<typeof NodeCredential>;

// Хост выхода: имя в нижнем регистре, TLD — буквы или punycode (xn--), необязательный префикс "*." и порт 1–65535.
export const EgressHost = z
  .string()
  .regex(/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})(:[1-9][0-9]{0,4})?$/)
  .refine((h) => !h.includes(':') || Number(h.split(':')[1]) <= 65535, 'egress: port out of range');
export type EgressHost = z.infer<typeof EgressHost>;

export const NodeManifest = z
  .strictObject({
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
  })
  .superRefine(checkKindRules);
export type NodeManifest = z.infer<typeof NodeManifest>;

// Не экспортируется. Добавляет issue по правилам 4.1.2 и 4.1.3, сообщения — дословно из таблиц, path — [имя поля].
function checkKindRules(manifest: NodeManifestShape, ctx: z.RefinementCtx): void;

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
```

`NodeManifestShape` — тип объекта до `superRefine` (`z.output` от `strictObject`), внутреннее имя файла.

#### 4.1.1. Имена

Пространство имён `type` — часть до `/`. Пространство `swag` зарезервировано за платформой (REQ-021-3).

#### 4.1.2. Общие правила `checkKindRules`

| Правило | path | Сообщение issue |
|---|---|---|
| имя операции повторяется | `operations` | `operations: duplicate name <name>` |
| имя в `credentials` повторяется | `credentials` | `credentials: duplicate name <name>` |
| `settings.properties` — объект и содержит ключ из `credentials[].name`; если `properties` нет или это не объект, правило не срабатывает | `settings` | `settings: field <name> is a credential` |
| хост в `egress` повторяется | `egress` | `egress: duplicate host <host>` |
| вид `llm-agent` или `human` в пространстве не `swag` | `kind` | `kind <kind> is reserved for swag/*` |

#### 4.1.3. Правила вида

Каждая клетка задаёт требование к полю. Нарушение — issue с path `[поле]` и сообщением ниже, где `<kind>` — значение `kind`.

| `kind` | `inputs` | `outputs` | `operations` | `credentials` | `egress` |
|---|---|---|---|---|---|
| `trigger` | null | обязательна | пусто | любые | любые |
| `channel` | обязательна (исходящее сообщение, `send`) | обязательна (входящее сообщение, `poll`) | пусто | любые | любые |
| `connector` | null | null | не пусто | любые | любые |
| `program` | обязательна | обязательна | пусто | любые | любые |
| `llm-agent` | null | null | пусто | пусто | пусто |
| `human` | null | null | пусто | пусто | пусто |

| Требование нарушено | Сообщение issue |
|---|---|
| «null», а схема задана | `<kind>: inputs must be null` / `<kind>: outputs must be null` |
| «обязательна», а `null` | `<kind>: inputs is required` / `<kind>: outputs is required` |
| «пусто», а массив не пуст | `<kind>: operations must be empty` / `<kind>: credentials must be empty` / `<kind>: egress must be empty` |
| «не пусто», а массив пуст | `<kind>: operations is required` |

У `llm-agent` вход и выход — сообщения шины, их формат задают 022 и 030; схемы рёбер для него появятся в 009. Операции у канала — Q-8.

### 4.2. `@swag/api-integration`, `node-registry.ts`

```ts
import type { NodeManifest, NodeTypeRef, NodeTypeSummary } from '@swag/contracts';

export interface SettingsIssue { path: string; message: string } // path — ключи через точку: "limits.maxSteps", корень — ""

export type NodeRegistryError =
  | { code: 'node_type_duplicate'; ref: NodeTypeRef }
  | { code: 'node_schema_unsupported'; ref: NodeTypeRef; schema: string; message: string }; // schema: settings | inputs | outputs | operations.<name>.input | operations.<name>.output; message — текст исключения fromJSONSchema

export type SettingsResult =
  | { ok: true; settings: Record<string, unknown> }
  | { ok: false; error: { code: 'node_type_not_found' } | { code: 'invalid_settings'; issues: SettingsIssue[] } };

export interface NodeRegistry {
  list(): NodeTypeSummary[];
  get(ref: string): NodeManifest | null; // ссылка не по NodeTypeRef — null
  validateSettings(ref: string, settings: unknown): SettingsResult;
}

export function createNodeRegistry(
  manifests: readonly NodeManifest[],
): { ok: true; registry: NodeRegistry } | { ok: false; error: NodeRegistryError };
```

- Манифесты на входе уже прошли `NodeManifest.parse`.
- При создании реестр превращает каждую схему манифеста в проверку `z.fromJSONSchema` (Zod 4.6, без новых зависимостей ядра) в порядке `settings`, `inputs`, `outputs`, затем операции по порядку (`input`, `output`); первая схема, на которой `fromJSONSchema` бросает, — `node_schema_unsupported`. Повтор `type@version` проверяется до схем. Проверки хранятся в реестре, повторно не строятся.
- `validateSettings` не бросает; ссылка, которую не принимает `NodeTypeRef`, или неизвестный тип — `node_type_not_found`. `issues` — из `error.issues` Zod: `path.join('.')`, `message`.
- Порядок версий — числовой по `major`, затем `minor`, затем `patch`.
- Все операции синхронные: реестр в памяти.

### 4.3. `@swag/node-sdk`

Новый пакет `packages/node-sdk`, `@swag/node-sdk`, не ядро. `package.json`: `exports` `"."` → `./src/index.ts`, `"./testing"` → `./src/testing.ts`; `dependencies` — `zod` (`4.6.7`), `@swag/contracts`. `tsconfig.json` — по образцу `packages/adapter-orchestrator-http/tsconfig.json`: `types: ["node"]` (ради глобальных `Response`, `RequestInit`, `AbortSignal`), `references` на `../contracts`; пакет добавляется в `references` корневого `tsconfig.json`. Код SDK не импортирует `node:*` и не читает `process`.

```ts
import type { z } from 'zod';
import type { EgressHost, NodeCredential, NodeManifest, NodeTypeName, NodeTypeVersion, OperationAccess } from '@swag/contracts';

type Settings = z.ZodObject;

// Тип контекста, который видит код узла. Реализацию на платформе даёт 026; поля 026 может только добавлять.
export interface NodeContext<S> {
  settings: S;
  secrets: { get(name: string): Promise<string> };
  http: { fetch(url: string, init?: RequestInit): Promise<Response> };
  log: {
    debug(msg: string, data?: object): void;
    info(msg: string, data?: object): void;
    warn(msg: string, data?: object): void;
    error(msg: string, data?: object): void;
  };
  state: { get(key: string): Promise<string | null>; set(key: string, value: string | null): Promise<void> }; // null — удалить ключ
  signal: AbortSignal;
}

export type NodeErrorCode = 'secret_not_declared' | 'egress_denied' | 'invalid_settings' | 'invalid_input' | 'invalid_output' | 'unknown_operation';

export class NodeError extends Error {
  readonly code: NodeErrorCode;
  constructor(code: NodeErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'NodeError';
  }
}

export interface PollResult<E> { events: E[]; cursor: string | null }

interface Base<S extends Settings> {
  type: NodeTypeName;
  version: NodeTypeVersion;
  title: string;
  description: string;
  settings: S;
  credentials?: NodeCredential[]; // по умолчанию []
  egress?: EgressHost[];          // по умолчанию []
}
type Ctx<S extends Settings> = NodeContext<z.output<S>>;

export interface TriggerDefinition<S extends Settings, E> extends Base<S> {
  kind: 'trigger';
  outputs: z.ZodType<E>;
  poll(cursor: string | null, ctx: Ctx<S>): Promise<PollResult<E>>;
}
export interface ChannelDefinition<S extends Settings, In, Out> extends Base<S> {
  kind: 'channel';
  inputs: z.ZodType<Out>;  // исходящее сообщение
  outputs: z.ZodType<In>;  // входящее сообщение
  poll(cursor: string | null, ctx: Ctx<S>): Promise<PollResult<In>>;
  send(message: Out, ctx: Ctx<S>): Promise<void>;
}
export interface OperationDefinition<S extends Settings, I, O> {
  title: string;
  description: string;
  access: OperationAccess;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  execute(input: I, ctx: Ctx<S>): Promise<O>;
}
export interface ConnectorDefinition<S extends Settings> extends Base<S> {
  kind: 'connector';
  operations: Record<string, OperationDefinition<S, any, any>>; // ключ — NodeOperation.name; порядок в манифесте — порядок ключей
}
export interface ProgramDefinition<S extends Settings, I, O> extends Base<S> {
  kind: 'program';
  inputs: z.ZodType<I>;
  outputs: z.ZodType<O>;
  execute(input: I, ctx: Ctx<S>): Promise<O>;
}
export interface BuiltinDefinition<S extends Settings> extends Base<S> {
  kind: 'llm-agent' | 'human'; // кода нет, исполняет платформа
}

export type NodeDefinition =
  | TriggerDefinition<any, any>
  | ChannelDefinition<any, any, any>
  | ConnectorDefinition<any>
  | ProgramDefinition<any, any, any>
  | BuiltinDefinition<any>;

export type SettingsOf<D extends NodeDefinition> = z.output<D['settings']>;

// Перегрузка на вид: обработчики получают типы из схем. Без проверок во время выполнения.
export function defineNode<S extends Settings, E>(d: TriggerDefinition<S, E>): TriggerDefinition<S, E>;
export function defineNode<S extends Settings, In, Out>(d: ChannelDefinition<S, In, Out>): ChannelDefinition<S, In, Out>;
export function defineNode<S extends Settings>(d: ConnectorDefinition<S>): ConnectorDefinition<S>;
export function defineNode<S extends Settings, I, O>(d: ProgramDefinition<S, I, O>): ProgramDefinition<S, I, O>;
export function defineNode<S extends Settings>(d: BuiltinDefinition<S>): BuiltinDefinition<S>;

export function toManifest(definition: NodeDefinition): NodeManifest;
```

Правила `toManifest` (REQ-021-8):

- `settings`, `inputs`, `operations[].input` → `z.toJSONSchema(schema, { io: 'input' })`; `outputs`, `operations[].output` → `z.toJSONSchema(schema, { io: 'output' })`: на выходе поля со значением по умолчанию всегда есть и попадают в `required`.
- `credentials` и `egress` — `[]`, если не заданы; `inputs` и `outputs` — `null`, если их нет у вида; `operations` — массив в порядке ключей, `name` = ключ; у видов без операций — `[]`.
- Результат — `NodeManifest.parse(...)`; нарушение правил 4.1 — `ZodError`. Схему, которую нельзя выразить в JSON Schema (`z.date()`, `z.custom()`), `z.toJSONSchema` не принимает и бросает — ошибка пробрасывается как есть. `.transform` в схемах узла не используется: JSON Schema его теряет; это правило README SDK.

`@swag/node-sdk/testing`:

```ts
export interface TestContextOptions {
  settings: unknown;                                                // проверяется схемой определения → NodeError('invalid_settings')
  secrets?: Record<string, string>;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;   // по умолчанию — new Response(null, { status: 501 })
  state?: Record<string, string>;
}
export interface TestContext<S> extends NodeContext<S> {
  logs: { level: 'debug' | 'info' | 'warn' | 'error'; msg: string; data?: object }[];
  stateSnapshot(): Record<string, string>;
}
export function createTestContext<D extends NodeDefinition>(definition: D, options: TestContextOptions): TestContext<SettingsOf<D>>;

export function runNode<S extends Settings, I, O>(definition: ProgramDefinition<S, I, O>, ctx: TestContext<z.output<S>>, input: unknown): Promise<O>;
export function runOperation<S extends Settings>(definition: ConnectorDefinition<S>, name: string, ctx: TestContext<z.output<S>>, input: unknown): Promise<unknown>;
export function runPoll<S extends Settings, E>(definition: TriggerDefinition<S, E> | ChannelDefinition<S, E, any>, ctx: TestContext<z.output<S>>, cursor: string | null): Promise<PollResult<E>>;
export function runSend<S extends Settings, In, Out>(definition: ChannelDefinition<S, In, Out>, ctx: TestContext<z.output<S>>, message: unknown): Promise<void>;
```

- `createTestContext`: настройки — `definition.settings.parse`; ошибка — `NodeError('invalid_settings')`. `signal` — не прерванный `AbortSignal`.
- Вход не по схеме (`inputs`, `operations[name].input`) — `NodeError('invalid_input')` до вызова обработчика; выход, каждое событие `poll` не по схеме — `NodeError('invalid_output')`; неизвестная операция — `NodeError('unknown_operation')`. Возвращается результат `parse` схемы выхода.
- `secrets.get(name)`: имени нет в `credentials` определения или нет в `options.secrets` — `NodeError('secret_not_declared')`.
- `http.fetch(url)`: адрес разбирается `new URL(url)`; сверяются `URL.protocol`, `URL.hostname` (userinfo в сверке не участвует), `URL.port` (пустой — порт по умолчанию). Разрешено, если `protocol === 'https:'` и есть запись `egress`, которая подходит:
  - запись без порта подходит только к пустому `URL.port`; запись с портом — только к тому же `URL.port`;
  - `api.example.com` — только хост `api.example.com`;
  - `*.example.com` — хост, оканчивающийся на `.example.com`, с любым числом уровней перед ним; сам `example.com` не подходит.

  Иначе — `NodeError('egress_denied')` без вызова `options.fetch`. Неразбираемый URL — тоже `egress_denied`.

### 4.4. Пакеты узлов

Пакет узла — каталог `packages/node-<имя>`, `@swag/node-<имя>`:

```
packages/node-<имя>/
  package.json        "exports": { ".": "./src/node.ts", "./swag-node.json": "./swag-node.json" }
  tsconfig.json       по образцу node-sdk; references на ../node-sdk (и ../contracts, если импортирует)
  src/node.ts         export default defineNode({ ... })
  swag-node.json      результат nodes:manifest (4.5)
  README.md
  test/node.test.ts
```

Пакет добавляется в `references` корневого `tsconfig.json`.

| Пакет | `dependencies` | Что в `src/node.ts` |
|---|---|---|
| `@swag/node-llm-agent` | `@swag/contracts`, `@swag/node-sdk`; `devDependencies` — `@swag/api-integration` (тест) | `type: 'swag/llm-agent'`, `version: '1.0.0'`, `kind: 'llm-agent'`, `title: 'LLM-агент'`, `description: 'Агент на модели платформы: роль, модель, бюджет и лимит ответа. Исполняется агентным циклом платформы.'`, `settings: AgentDraft` |
| `@swag/node-example` | `zod` (`4.6.7`), `@swag/node-sdk` | программа ниже |

`@swag/node-example`, `example/echo@1.0.0`:

```ts
export default defineNode({
  type: 'example/echo',
  version: '1.0.0',
  kind: 'program',
  title: 'Эхо',
  description: 'Пример программы: возвращает входной текст с префиксом из настроек.',
  settings: z.strictObject({ prefix: z.string().max(40).default('') }),
  inputs: z.strictObject({ text: z.string().max(4000) }),
  outputs: z.strictObject({ text: z.string() }),
  execute: async ({ text }, ctx) => ({ text: ctx.settings.prefix + text }),
});
```

README пакета — инструкция автору узла: как написать, проверить `runNode` и выгрузить манифест.

Набор проверки REQ-021-10 (AC-021-9): принимаются `{name:'a',role:'b'}`, `{name:'a',role:'b',model:'chat-large',budgetMicroUsd:1000,maxTokens:2048}`; отклоняются `{name:'',role:'b'}`, `{name:'a',role:'b',x:1}`, `{name:'a',role:'b',model:'gpt'}`, `{name:'a',role:'b',maxTokens:0}`, `{role:'b'}`. Известное отличие: `AgentDraft` обрезает пробелы (`trim`), JSON Schema этого не умеет — строка из одних пробелов проходит `validateSettings`, но не `AgentDraft`; набор такие строки не содержит, отличие описано в README пакета.

### 4.5. Выгрузка манифестов

`scripts/node-manifests.ts`, команда `npm run nodes:manifest` = `node scripts/node-manifests.ts`: для каждого каталога `packages/node-*`, кроме `packages/node-sdk`, импортирует `src/node.ts` и пишет `JSON.stringify(toManifest(module.default), null, 2) + '\n'` в `swag-node.json`. Порядок ключей задаёт `NodeManifest.parse` внутри `toManifest`, поэтому повторный запуск не меняет файлы.

Проверка совпадения (REQ-021-12) — тест в пакете узла: `JSON.parse(JSON.stringify(toManifest(definition)))` глубоко равен `JSON.parse` файла `swag-node.json`.

### 4.6. Доступ и `api-core`

`access.ts`: новое право `node.read` у всех трёх ролей (Q-5).

`api-core`:

```ts
export interface ApiCoreDeps {
  // …как сейчас
  nodeTypes: NodeRegistry; // из @swag/api-integration; реестр собирает оболочка (4.7)
}

export interface ApiCore {
  // …как сейчас
  listNodeTypes(actor: Actor): Result<NodeTypeList>;                 // синхронно: реестр в памяти
  getNodeType(actor: Actor, ref: string): Result<NodeManifest>;
}
```

- Нет `node.read` — `forbidden`.
- `getNodeType`: типа нет или `ref` не по `NodeTypeRef` — `not_found`, сообщение `Тип узла не найден`.
- У всех ролей право есть, поэтому `403` по HTTP сейчас недостижим; отказ проверяется в ядре (AC-021-20).

### 4.7. Загрузка манифестов в `api`

`apps/api/src/node-types.ts`:

```ts
export class NodeTypesLoadError extends Error {
  readonly packageName: string | null; // null — ошибка реестра, а не пакета
  constructor(packageName: string | null, message: string) {
    super(message);
    this.packageName = packageName;
    this.name = 'NodeTypesLoadError';
  }
}

export interface LoadNodeTypesOptions {
  resolve?: (specifier: string) => string; // по умолчанию createRequire(import.meta.url).resolve; тесты подменяют путь к фикстурам
}

export async function loadNodeRegistry(packages: readonly string[], options?: LoadNodeTypesOptions): Promise<NodeRegistry>; // бросает NodeTypesLoadError

// Для main.ts: ошибка — log.error('node_manifest_invalid', { package, err }) и fail().
export async function bootNodeRegistry(
  packages: readonly string[],
  deps: { log: { error(msg: string, data?: object): void }; fail: () => Promise<never>; resolve?: (specifier: string) => string },
): Promise<NodeRegistry>;
```

`loadNodeRegistry`:

1. Для каждого имени пакета по порядку: путь `resolve('<пакет>/swag-node.json')`, `readFile` (`node:fs/promises`, `utf8`), `JSON.parse`, `NodeManifest.parse`. Код пакета не импортируется (REQ-021-13). Любое исключение на этих шагах (`MODULE_NOT_FOUND`, `ERR_PACKAGE_PATH_NOT_EXPORTED`, ошибка чтения, `SyntaxError`, `ZodError`) — `NodeTypesLoadError(<пакет>, <сообщение исключения>)`.
2. Пакет, имя которого не начинается с `@swag/`, объявляет `type` в пространстве `swag` — `NodeTypesLoadError(<пакет>, 'reserved namespace swag')` (REQ-021-3).
3. `createNodeRegistry(manifests)`; ошибка — `NodeTypesLoadError(null, '<code> <ref>')`, например `node_type_duplicate example/echo@1.0.0`.

`main.ts`: сразу после `loadConfig(ApiConfig)` — `const nodeTypes = await bootNodeRegistry(config.NODE_PACKAGES, { log, fail: () => fail('node_manifest_invalid', null) })`; `fail` из `main.ts` пишет свой лог и завершает процесс с кодом 1. Реестр передаётся в `createApiCore` как `nodeTypes` (через `start.ts`, если зависимости ядра собираются там). Подключение к Postgres и NATS идёт после, поэтому при ошибке порт не слушается.

`apps/api/package.json`: в `dependencies` добавляются `@swag/api-integration`; в `devDependencies` — `@swag/node-llm-agent`, `@swag/node-example` (тест AC-021-19). Образ `api` пакеты узлов уже содержит: Dockerfile копирует `packages` целиком.

Фикстуры тестов — `apps/api/test/fixtures/packages/<имя>/swag-node.json` (не `node_modules`: он в `.gitignore`); тест передаёт `resolve`, который отображает `<имя>/swag-node.json` на этот путь и бросает `Error` с кодом `MODULE_NOT_FOUND` для неизвестного имени:

| Фикстура | Содержимое |
|---|---|
| `acme-nodes` | `swag-node.json` = манифест `example/echo@1.0.0` с `type: 'swag/fake'` |
| `throwing-node` | `swag-node.json` = манифест `example/echo@1.0.0` с `type: 'acme/throwing'`; `package.json` с `"main": "index.js"`; `index.js` — `throw new Error('must not be imported')` |
| `broken-node` | `swag-node.json` = `{ "type": "acme/broken" }` |
| `echo-copy` | `swag-node.json` = манифест `example/echo@1.0.0` без изменений |

### 4.8. HTTP `api`

| Метод и путь | Ответ | Ошибки |
|---|---|---|
| `GET /node-types` | `200 NodeTypeList` | `401`, `403 forbidden` |
| `GET /node-types/:namespace/:name/:version` | `200 NodeManifest` | `401`, `403 forbidden`, `404 not_found` |

Оболочка собирает `ref` как `${namespace}/${name}@${version}` и передаёт в `getNodeType`. Маршруты — внутри общего блока REST с проверкой токена (024, 4.5), ответ — через существующий `send`.

### 4.9. Env

| Переменная | Где | Значение | Назначение |
|---|---|---|---|
| `NODE_PACKAGES` | `ApiConfig` | список имён npm-пакетов через запятую; `.env.example`: `@swag/node-llm-agent,@swag/node-example` | пакеты узлов, чьи типы попадают в реестр (Q-6) |

Схема в `ApiConfig`:

```ts
NODE_PACKAGES: z
  .string()
  .default('')
  .transform((v) => (v.trim() === '' ? [] : v.split(',').map((s) => s.trim())))
  .pipe(
    z
      .array(z.string().min(1, 'NODE_PACKAGES: empty package name'))
      .refine((a) => new Set(a).size === a.length, 'NODE_PACKAGES: duplicate package name'),
  ),
```

Пустое значение — реестр без типов, `api` работает. `compose.yaml`: сервис `api` получает `NODE_PACKAGES: ${NODE_PACKAGES:-}`. Локальный `.env` — значение из `.env.example`.

## 5. Критерии приёмки

- **AC-021-1** — *Given* манифест `example/echo@1.0.0` из 4.4 в JSON *When* `NodeManifest.parse` с лишним полем `image` *Then* ошибка; без лишнего поля — успех.
- **AC-021-2** — *Given* по манифесту на каждое правило 4.1.2 и каждую клетку 4.1.3 со значением «null», «обязательна», «пусто», «не пусто», нарушающему её *When* `NodeManifest.safeParse` *Then* ошибка с path и сообщением из таблиц; по одному верному манифесту на каждый вид — успех.
- **AC-021-3** — *Given* манифест `kind: 'llm-agent'`, `type: 'acme/agent'` *When* `NodeManifest.safeParse` *Then* ошибка `kind llm-agent is reserved for swag/*`.
- **AC-021-4** — *Given* фикстура `acme-nodes` *When* `loadNodeRegistry(['acme-nodes'], { resolve })` *Then* `NodeTypesLoadError` с `packageName: 'acme-nodes'` и сообщением `reserved namespace swag`.
- **AC-021-5** — *Given* два манифеста `example/echo@1.0.0` *When* `createNodeRegistry` *Then* `{ ok: false, error: { code: 'node_type_duplicate', ref: 'example/echo@1.0.0' } }`.
- **AC-021-6** — *Given* манифест, `settings` которого `{ "type": "object", "properties": { "a": { "$ref": "https://example.com/s.json" } } }` *When* `createNodeRegistry` *Then* `node_schema_unsupported` с `schema: 'settings'` и этим `ref`.
- **AC-021-7** — *Given* реестр с `example/echo@1.0.0` *When* `validateSettings('example/echo@1.0.0', {})` *Then* `ok` с `{ prefix: '' }`; *When* `{ prefix: 1 }` *Then* `invalid_settings`, в `issues` путь `prefix`; *When* `{ prefix: 'a', x: 1 }` *Then* `invalid_settings`; *When* ссылка `example/echo@2.0.0` или `не ссылка` *Then* `node_type_not_found`, `get` — `null`.
- **AC-021-8** — *Given* реестр с `example/echo` версий `1.0.0`, `1.10.0`, `1.2.0` и `swag/llm-agent@1.0.0` *When* `list()` *Then* две записи в порядке `example/echo`, `swag/llm-agent`; у echo `version: '1.10.0'`, `versions: ['1.10.0', '1.2.0', '1.0.0']`.
- **AC-021-9** — *Given* реестр из `toManifest` определения `@swag/node-llm-agent` и набор из 4.4 *When* каждое значение проверяется `AgentDraft.safeParse` и `validateSettings('swag/llm-agent@1.0.0', …)` *Then* итоги совпадают: первые два — успех, остальные — отказ.
- **AC-021-10** — *Given* определение коннектора с двумя операциями (выход второй — `z.strictObject({ n: z.number().default(0) })`), `credentials` и `egress` *When* `toManifest` *Then* манифест проходит `NodeManifest.parse`, `operations` в порядке ключей с `name`, `access` и JSON Schema, `$schema` — `https://json-schema.org/draft/2020-12/schema`, в `output` второй операции `required` содержит `n`; определение программы без `credentials` — `credentials: []`, `egress: []`; коннектор без операций — `toManifest` бросает `ZodError`.
- **AC-021-11** — *Given* `example/echo` и `createTestContext(def, { settings: { prefix: '> ' } })` *When* `runNode(def, ctx, { text: 'hi' })` *Then* `{ text: '> hi' }`; *When* вход `{ text: 1 }` *Then* `NodeError` с `code: 'invalid_input'`, `execute` не вызван; *When* `settings: { prefix: 1 }` *Then* `createTestContext` бросает `NodeError` с `code: 'invalid_settings'`.
- **AC-021-12** — *Given* программа-фикстура, `execute` которой возвращает `{ wrong: true }` *When* `runNode` *Then* `NodeError` с `code: 'invalid_output'`.
- **AC-021-13** — *Given* коннектор-фикстура с `credentials: [{ name: 'apiKey', title: 'Ключ', kind: 'api-key' }]`, `egress: ['api.example.com', '*.cdn.example.com']` и тестовым контекстом с `secrets: { apiKey: 'fake-key' }` *When* операция зовёт `secrets.get('apiKey')`, `secrets.get('other')` *Then* `fake-key`, затем `secret_not_declared`; *When* `http.fetch` к `https://api.example.com/x`, `https://a.cdn.example.com/x`, `https://a.b.cdn.example.com/x` *Then* три вызова `options.fetch`; *When* к `https://cdn.example.com/x`, `https://evil.com/x`, `http://api.example.com/x`, `https://api.example.com:8443/x`, `https://api.example.com@evil.com/x` *Then* пять `egress_denied` без вызова `options.fetch`; `runOperation` с неизвестным именем — `unknown_operation`.
- **AC-021-14** — *Given* канал-фикстура *When* `runPoll(def, ctx, null)` возвращает событие не по `outputs` *Then* `NodeError` `invalid_output`; *When* `runSend` с сообщением не по `inputs` *Then* `NodeError` `invalid_input`, `send` не вызван; верные — проходят, `state.set` из `poll` виден в `stateSnapshot()`.
- **AC-021-15** — *Given* пакеты `@swag/node-llm-agent` и `@swag/node-example` *When* тест пакета сравнивает `toManifest(definition)` с `swag-node.json` по 4.5 *Then* они равны.
- **AC-021-16** — *Given* исходники `packages/node-example/src` *When* тест читает спецификаторы `import` файлов *Then* встречаются только `zod` и `@swag/node-sdk`.
- **AC-021-17** — *Given* фикстура `throwing-node` *When* `loadNodeRegistry(['throwing-node'], { resolve })` *Then* реестр создан, `acme/throwing` в `list()`, исключение `must not be imported` не возникло.
- **AC-021-18** — *Given* фейковые `log` и `fail` *When* `bootNodeRegistry` с пакетом `broken-node`, с неизвестным пакетом `missing-node` и с `['@swag/node-example', 'echo-copy']` (повтор `type@version`) *Then* каждый раз `log.error('node_manifest_invalid', …)` с `package: 'broken-node'`, `'missing-node'` и `null` соответственно и полем `err`, затем вызван `fail`.
- **AC-021-19** — *Given* `buildApp` из `apps/api/test/support.ts` с реестром `loadNodeRegistry(['@swag/node-llm-agent', '@swag/node-example'])` и токен роли `user` *When* `GET /node-types` *Then* `200`, `items` — `example/echo` и `swag/llm-agent` в этом порядке; *When* `GET /node-types/example/echo/1.0.0` *Then* `200` и манифест, равный `swag-node.json`; *When* `GET /node-types/example/echo/9.9.9` *Then* `404 not_found`.
- **AC-021-20** — *Given* запрос без токена *When* `GET /node-types` *Then* `401 unauthorized`; *Given* `Actor` с пустыми `permissions` *When* `listNodeTypes` и `getNodeType` в `api-core` *Then* `forbidden`.
- **AC-021-21** — *Given* роли `user`, `admin`, `supervisor` *When* смотрим `ROLE_PERMISSIONS` *Then* у каждой есть `node.read`.
- **AC-021-22** — *Given* манифест, где `settings.properties` содержит `apiKey`, а `credentials` — `{ name: 'apiKey', … }` *When* `NodeManifest.safeParse` *Then* ошибка `settings: field apiKey is a credential`.
- **AC-021-23** — *Given* тест типов в `packages/node-sdk/test/types.test.ts` *When* `npm run typecheck` *Then* внутри `execute` программы `ctx.settings.prefix` имеет тип `string`, а строки с `// @ts-expect-error` (присвоение `ctx.settings.prefix` в `number`, обращение к `input.missing`) действительно ошибочны — иначе typecheck падает.
- **AC-021-24** — *Given* `ApiConfig` *When* `NODE_PACKAGES` = `''`, `' @swag/node-example , @swag/node-llm-agent '`, `'a,,b'`, `'a,a'` *Then* `[]`, `['@swag/node-example', '@swag/node-llm-agent']`, ошибка `NODE_PACKAGES: empty package name`, ошибка `NODE_PACKAGES: duplicate package name`.
- **AC-021-25** `[manual]` — *Given* чистый `main` после спеки *When* новый пакет `packages/node-demo` (копия `node-example` с `type: 'example/demo'`) добавлен в корневой `tsconfig.json`, `npm install`, `npm run nodes:manifest`, имя дописано в `NODE_PACKAGES`, `npm run up` *Then* `GET /node-types` отдаёт `example/demo`, а `git diff --stat` затрагивает только `packages/node-demo/**`, `tsconfig.json`, `.env.example`, `package-lock.json`. Проверка: выполнить шаги, приложить в журнал ответ `curl` и `git diff --stat`, затем удалить пакет.

## 6. Нефункциональные требования

| ID | Требование | Как измеряется |
|---|---|---|
| NFR-021-1 | Проверка настроек не строится заново на каждый вызов: 10 000 вызовов `validateSettings` на `swag/llm-agent` — меньше 1 с | ручной замер скриптом в журнале реализации, не автотест |

## 7. Безопасность: что не должно сломаться

- Код пакета узла не исполняется в процессе `api`: загрузчик читает только `swag-node.json` → AC-021-17.
- Сторонний пакет не выдаёт себя за тип платформы (`swag/*`, `llm-agent`, `human`) → AC-021-3, AC-021-4.
- Доступ к внешней системе объявляется только в `credentials` и не дублируется полем настроек → AC-021-22; в SDK секрет доступен только объявленный → AC-021-13. Хранение значений — 026.
- Тестовая обвязка не пускает HTTP мимо `egress`, по `http:` и через userinfo → AC-021-13. Это обвязка разработчика; принуждение на платформе — 026.
- Каталог закрыт токеном и правом → AC-021-20; прежние права ролей не меняются → тесты `access.ts` 024 остаются зелёными.
- Неверный манифест не даёт `api` начать приём запросов → AC-021-18.
- В фикстурах и тестах — только фейковые значения секретов (`fake-key`).

## 8. Задачи для агента

Выполняются по порядку. После каждой задачи — коммит; `npm run typecheck` и тесты зелёные на каждом коммите. Пакет — README в том же коммите.

- [x] **T-1.** `packages/contracts/src/node.ts` по 4.1 с `checkKindRules`, `nodeTypeRef`, `parseNodeTypeRef`; экспорт из `index.ts`; тесты `packages/contracts/test/node.test.ts`. Закрывает: REQ-021-1, REQ-021-2, REQ-021-3 (схема), REQ-021-16, AC-021-1, AC-021-2, AC-021-3, AC-021-22. Готово, когда: тесты зелёные, README `contracts` дополнен.
- [x] **T-2.** `packages/contracts/src/access.ts`: право `node.read` у трёх ролей по 4.6; тест в `packages/contracts/test/access.test.ts`. Закрывает: AC-021-21. Готово, когда: тест зелёный, прежние тесты доступа зелёные.
- [x] **T-3.** `packages/api-integration/src/node-registry.ts` по 4.2, экспорт из `index.ts`; тесты `packages/api-integration/test/node-registry.test.ts` с манифестами-литералами. Закрывает: REQ-021-4, REQ-021-5, REQ-021-6, AC-021-5, AC-021-6, AC-021-7, AC-021-8. Готово, когда: тесты зелёные, README `api-integration` дополнен.
- [x] **T-4.** Пакет `packages/node-sdk`: `package.json`, `tsconfig.json`, строка в корневом `tsconfig.json` по 4.3; `src/index.ts` — типы, `NodeError`, `defineNode`, `toManifest`; тесты `test/manifest.test.ts` и `test/types.test.ts`. Закрывает: REQ-021-7, REQ-021-8, AC-021-10, AC-021-23. Готово, когда: тесты и typecheck зелёные, README по схеме CLAUDE.md.
- [x] **T-5.** `packages/node-sdk/src/testing.ts` по 4.3; фикстуры программы (копия echo и программа с неверным выходом), коннектора и канала в `test/fixtures.ts`; тест `test/testing.test.ts`. Закрывает: REQ-021-9, AC-021-11 (на фикстуре-копии echo), AC-021-12, AC-021-13, AC-021-14. Готово, когда: тесты зелёные, README SDK описывает обвязку и правило про `.transform`.
- [x] **T-6.** Пакет `packages/node-example` по 4.4 и скрипт `scripts/node-manifests.ts` с командой `nodes:manifest` в корневом `package.json` по 4.5; `swag-node.json` из команды; тест `test/node.test.ts`: совпадение манифеста, `runNode` echo, импорты `src`. Закрывает: REQ-021-11, REQ-021-12, AC-021-11, AC-021-15, AC-021-16. Готово, когда: тесты зелёные, повторный `npm run nodes:manifest` не меняет `git diff`, README — инструкция автору узла.
- [ ] **T-7.** Пакет `packages/node-llm-agent` по 4.4, `swag-node.json` из `npm run nodes:manifest`; тест: совпадение манифеста и набор AC-021-9 через `createNodeRegistry([toManifest(definition)])`. Закрывает: REQ-021-10, AC-021-9, AC-021-15. Готово, когда: тесты зелёные, README с отличием про `trim`.
- [ ] **T-8.** `api-core`: зависимость `nodeTypes: NodeRegistry`, операции `listNodeTypes`, `getNodeType` по 4.6; тесты в `packages/api-core/test/`. В том же коммите все места, где собирается `ApiCoreDeps`, получают `nodeTypes`: тесты `api-core`, `apps/api/test/support.ts`, `apps/api/test/bench.test.ts`, `apps/api/test/e2e.test.ts`, `apps/api/test/trace.test.ts` — пустой реестр `createNodeRegistry([])`; `apps/api/src/start.ts` и `main.ts` — пустой реестр до T-11; `@swag/api-integration` — в `dependencies` `apps/api/package.json`. Закрывает: AC-021-20 (ядро). Готово, когда: `npm run typecheck` и тесты зелёные, README `api-core` дополнен.
- [ ] **T-9.** `NODE_PACKAGES` в `ApiConfig` (`packages/config`) по 4.9, тест в `packages/config/test/`; `.env.example`, локальный `.env`, `compose.yaml`. Закрывает: REQ-021-17, AC-021-24. Готово, когда: тесты зелёные, README `config` дополнен.
- [ ] **T-10.** `apps/api/src/node-types.ts` — `NodeTypesLoadError`, `loadNodeRegistry`, `bootNodeRegistry` по 4.7; фикстуры `apps/api/test/fixtures/packages/*` из таблицы 4.7; тест `apps/api/test/node-types.test.ts`. Закрывает: REQ-021-3 (загрузчик), AC-021-4, AC-021-17, AC-021-18. Готово, когда: тесты зелёные.
- [ ] **T-11.** `apps/api`: вызов `bootNodeRegistry` в `main.ts` сразу после `loadConfig` и передача реестра в ядро по 4.7; `devDependencies` `@swag/node-llm-agent`, `@swag/node-example`; маршруты 4.8 в `src/app.ts`; тест `apps/api/test/node-types-http.test.ts`. Закрывает: REQ-021-13, REQ-021-14, AC-021-19, AC-021-20 (HTTP). Готово, когда: тесты зелёные, `npm run up` поднимает `api`, README `apps/api` дополнен.
- [ ] **T-12.** Документация: `docs/architecture.md` (пакеты `node-sdk`, `node-*`, реестр в `api-integration`), корневой README (`nodes:manifest`, `NODE_PACKAGES`); глоссарий сверен; замер NFR-021-1 и ручная проверка AC-021-25 в журнал. Закрывает: REQ-021-15, NFR-021-1, AC-021-25. Готово, когда: `npm run check` зелёный, README сверены с кодом.

## 9. Открытые вопросы

Пока список не пуст, спека не может быть `ready`.

- [x] **Q-1.** Формат схем манифеста *(из D-33; Claude, 2026-11-02)*. Схемы `settings`, `inputs`, `outputs`, `operations` нужны редактору (форма), оркестратору (проверка), координатору (каталог) и MCP (инструменты). Варианты: **(а)** JSON Schema пишется руками в манифесте; **(б)** Zod в SDK, в манифест и реестр кладётся JSON Schema 2020-12, проверка в реестре — `z.fromJSONSchema` (Zod 4.6, без новой зависимости ядра); **(в)** то же, что «б», но проверка в реестре через Ajv — полная поддержка JSON Schema, но новая зависимость ядра. Рекомендация — **«б»**: так написаны остальные контракты проекта, JSON Schema язык-нейтральна и подходит MCP и OpenAI `tools`. Проверено на Zod 4.6.7: круговой перевод `AgentDraft` даёт тот же итог на наборе 4.4, `strictObject` отклоняет лишние поля, значения по умолчанию подставляются; внешний `$ref`, `not`, `if/then` `fromJSONSchema` не принимает — такие схемы отсекаются при загрузке (REQ-021-4). Спека написана под «б». **Ответ (человек, 2026-11-02):** (б) — по рекомендации.
- [x] **Q-2.** Подсказки виджетов формы настроек *(из D-33; Claude, 2026-11-02)*: многострочный текст, выбор модели, загрузка вариантов из операции коннектора. Варианты: **(а)** решить в спеке редактора 017, в 021 — только стандартные аннотации JSON Schema (`title`, `description`, `enum`, `default`); **(б)** ключ `x-swag-widget` уже в 021. Рекомендация — **«а»**: без редактора не проверить, какие подсказки нужны; `z.meta()` позже добавит ключ без смены формата. **Ответ (человек, 2026-11-02):** (а) — по рекомендации.
- [x] **Q-3.** Что значит «программа описана манифестом» *(из роадмапа, этап 8а и раздел 4; Claude, 2026-11-02)*. Роадмап описывает программу как узел «команда, параметры запуска и схема выхода». Варианты: **(а)** программа — пакет с кодом `execute`, как расчёт цены 019; в 021 вид `program` в контракте и пример `example/echo`; **(б)** ещё встроенный тип `swag/program` с настройками `command`, `args`, `outputSchema` — исполнение произвольной команды в песочнице. Рекомендация — **«а»**: «б» зависит от `exec` в песочнице (005) и схемы выхода как данных настроек, а целевому кейсу нужна только программа-пакет; «б» — отдельной задачей в 005 или 026. **Ответ (человек, 2026-11-02):** (а) — по рекомендации.
- [x] **Q-4.** Пороги и форматы манифеста *(Claude, 2026-11-02)*. Предложено в 4.1: часть имени типа — до 40 символов `[a-z0-9-]`; `title` до 80, `description` до 2000, у операции — до 1000; до 8 `credentials`, до 32 операций, до 16 хостов `egress`; в `egress` разрешены `*.` и punycode-TLD, не разрешены IP, `localhost` и одноуровневые имена; виды `credentials` — `api-key` и `oauth2`. В тестовой обвязке (4.3) выход только по `https:`. Рекомендация — принять: 32 операции хватает CRM-коннектору средней руки, `*.` нужен CDN и региональным API, punycode — `.рф`-хостам, выход на IP и внутренние имена узлу не нужен. **Ответ (человек, 2026-11-02):** принять — по рекомендации.
- [x] **Q-5.** Кто читает каталог *(Claude, 2026-11-02)*. Варианты: **(а)** право `node.read` у всех ролей; **(б)** у `user` и `admin` — супервизор процессов не создаёт (024, Q-4). Рекомендация — **«а»**: супервизор отвечает за платформу и должен видеть, какие типы узлов в ней есть. **Ответ (человек, 2026-11-02):** (а) — по рекомендации.
- [x] **Q-6.** Как перечислять пакеты узлов *(Claude, 2026-11-02)*. Варианты: **(а)** env `NODE_PACKAGES` у `api`; **(б)** все установленные пакеты с полем `swag.node` в `package.json`; **(в)** файл `infra/nodes.json`. Рекомендация — **«а»**: явный список, по которому видно, что подключено, в духе остальной конфигурации; «б» тянет в каталог всё, что оказалось в `node_modules`. **Ответ (человек, 2026-11-02):** (а) — по рекомендации.
- [x] **Q-7.** Секреты: `credentials` вместо помеченных полей настроек *(из роадмапа, раздел 4: «поля-секреты помечены и хранятся отдельно от графа»; Claude, 2026-11-02)*. Варианты: **(а)** секретов в `settings` нет вовсе, доступ к внешней системе — только `credentials` (имя, вид), значение код получает `secrets.get(name)`; поле настроек с именем из `credentials` — ошибка (REQ-021-16); **(б)** поле `settings` помечается ключом `x-swag-secret`, платформа вырезает его из графа. Рекомендация — **«а»**: одно место для секретов, схема настроек остаётся обычной JSON Schema, а «хранится отдельно от графа» получается само; роадмап уже называет `credentials` в манифесте. **Ответ (человек, 2026-11-02):** (а) — по рекомендации.
- [x] **Q-8.** Операции у канала *(из роадмапа, раздел 4: «`operations` (у коннектора и канала)»; Claude, 2026-11-02)*. Варианты: **(а)** у канала в 021 операций нет: приём — `poll`, отправка — `send` со схемой `inputs`; дополнительные операции канала (например, «история диалога» Авито) решаются в 020; **(б)** разрешить `operations` у канала уже сейчас. Рекомендация — **«а»**: без реального канала не видно, нужны ли операции сверх `send`; добавить их — расширение правила 4.1.3 без смены формата. **Ответ (человек, 2026-11-02):** (а) — по рекомендации.

## 10. Журнал реализации

Заполняет агент.

| Дата | Ветка / коммит | Что сделано | Отклонения от спеки |
|---|---|---|---|
| 2026-11-02 | spec/021-t3 | T-3: реестр типов узлов `createNodeRegistry` | 4.2 «проверки хранятся в реестре»: хранится только проверка `settings` — единственная, которую вызывает `validateSettings`; схемы `inputs`, `outputs` и операций компилируются при создании только для отсечения неподдерживаемых (REQ-021-4) |
| 2026-11-02 | spec/021-t4 | T-4: пакет `@swag/node-sdk`, `defineNode`, `toManifest` | Операции коннектора по букве 4.3 (`OperationDefinition<S, any, any>`): вход и выход обработчика операции не выводятся из схем, проверка только при выполнении — D-158. Пакет не ядро, в `arch:check` не входит (4.3) |
| 2026-11-02 | spec/021-t4 | T-5: `@swag/node-sdk/testing` | Трактовка: `secret_not_declared` и для имени из `credentials`, значение которого не передано в `secrets` (REQ-021-9). Запись `egress` с портом `443` не подходит к адресу без порта — по букве 4.3 |
