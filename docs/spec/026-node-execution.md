---
id: "026"
title: Исполнение узлов
status: draft
roadmap_stage: 8а
depends_on: ["021", "024"]
superseded_by: null
updated: 2026-11-02
---

# 026. Исполнение узлов

> **Коротко.**
> - Оркестратор исполняет один вызов узла с кодом: `poll` триггера и канала, `send` канала, операцию коннектора, `execute` программы. Внутренний маршрут `POST /node-invocations` принимает вызов и синхронно отдаёт результат. Граф процесса, который будет вызывать узлы, появится в 009. В 026 вызов делают тесты и ручная проверка.
> - На каждый вызов создаётся своя песочница из образа `swag-node-host:dev`. Обмен с ней идёт по stdin/stdout строками JSON. Сеть песочницы закрыта: из неё доступен только исходящий прокси. Env не содержит секретов. После вызова песочница удаляется при любом исходе.
> - Исходящий прокси — новый сервис `egress-proxy`. Он пропускает только `CONNECT` к хостам из `egress` манифеста. Право на выход — подписанный HMAC-токен, его выдаёт оркестратор на один вызов. Прокси не соединяется с внутренними и частными адресами.
> - Секреты организации хранятся в Postgres, зашифрованные AES-256-GCM. Ключ — `SECRETS_KEY` в `.env`. Администратор организации задаёт секреты через `api`: `GET`, `PUT` и `DELETE /secrets`. Значение секрета наружу не отдаётся никогда.
> - Код узла получает только секреты из своих `credentials`. Они приходят в песочницу кадром stdin. Логи узла и сообщения ошибок оркестратор пишет с вымаранными значениями секретов.
> - Проверки, которым доверяет платформа, делает оркестратор, а не песочница. Это тип узла, вид вызова, настройки, вход, выход, `credentials` и лимиты кадров. Код внутри песочницы считается недоверенным.
> - **Решения человека (2026-11-02):** Q-1…Q-9 закрыты по рекомендациям. Для старта реализации нужен статус `ready`.

## 1. Контекст и цель

Закрывает вторую половину этапа 8а роадмапа, [раздел 4 «Граф процесса»](../../AI_PLATFORM_ROADMAP.md#4-граф-процесса). По роадмапу код узла видит только контекст исполнения. Это настройки, секреты по запросу, HTTP через исходящий прокси со списком хостов из `egress`, логгер и хранилище состояния. Сторонний код исполняется в песочнице. Секреты клиента не попадают в граф и логи.

Сейчас (после 021) есть контракт узла, реестр типов в `api`, SDK `@swag/node-sdk` и тестовая обвязка. Но кода узла платформа не исполняет. `NodeContext` реализован только в обвязке, а секретов организации нет.

Цель:
- оркестратор исполняет вызов узла в песочнице с реальным `NodeContext`;
- выход в сеть разрешён только к хостам из `egress`;
- секреты организации хранятся зашифрованными, и узел получает только объявленные;
- состояние узла живёт в Postgres.

На этом слое 009 строит исполнение графа, 019 и 020 — узлы DNS и Авито.

## 2. Объём

**Входит:**

- `egressMatches` в `@swag/contracts` — единое правило сверки хоста с `egress` для SDK и прокси. Также схемы вызова `NodeInvocation`, `NodeInvocationResult`, `EgressGrant`, секретов и право `secret.manage` (4.1);
- `validate` в реестре типов `@swag/api-integration` — проверка входа, выхода и событий по схемам манифеста (4.2);
- `@swag/node-sdk/runtime` — `invokeNode`: одна функция вызова обработчика по виду, на ней же тестовая обвязка (4.3);
- пакет `@swag/node-packages` — загрузчик манифестов из `apps/api/src/node-types.ts`, общий для `api` и оркестратора, с `packageOf` (4.4);
- секреты организации: таблица, шифр `adapter-crypto`, хранилище `adapter-postgres`, операции `api-core`, маршруты `api` (4.5, 4.6);
- хранилище состояния узла: таблица и адаптер (4.5);
- ядро `egress-proxy-core` и оболочка `apps/egress-proxy` — исходящий прокси (4.7);
- процесс песочницы `apps/node-host` и образ `swag-node-host:dev`, протокол кадров stdio (4.8);
- песочница узла в `adapter-docker`: закрытая сеть, ограничения, stdio (4.9);
- `invokeNode` в `orchestrator-core`, маршрут `POST /node-invocations`, уборка песочниц узлов (4.10);
- env, compose, сеть `swag-nodes` (4.11);
- проверка типов UI-приложений в `npm run check` (из N-29, 4.12);
- README, `docs/architecture.md`, глоссарий, корневой README.

**Не входит** (агент это не делает, даже если кажется логичным):

- граф процесса и вызов узлов из него, `stateKey` из id узла графа, проверка рёбер — 009;
- проверка настроек узлов графа при запуске роя и доставка реестра для неё — 009. Здесь оркестратор загружает реестр только для вызова узла (Q-5);
- тёплый пул, gVisor (`runsc`), reaper по TTL и общие лимиты песочниц — 005. Здесь у песочницы узла фиксированные ограничения 4.9, а рантайм — тот же, что у агентов;
- тариф compute и списание за время песочницы узла — 005 (D-126). Запись стоимости из кода узла (`ctx.cost`) тоже не входит (Q-3);
- загрузка пакетов узлов организацией, открытый каталог, модерация и подпись пакетов — после MVP (Q-2, новый D-159);
- триггер с подпиской `start`/`stop` и вебхуки — 020;
- исполнение `llm-agent` и `human` — их исполняет платформа (022, 028), вызов отклоняется `not_executable`;
- свой ключ организации к провайдеру моделей: смешанный режим, проверка ключа, подстановка в gateway — 025 и спека gateway (D-35). Здесь только хранилище, которым он воспользуется;
- экран секретов в кабинете — 020, первая спека, где организация вводит секрет (N-30);
- ротация `SECRETS_KEY` и vault — после MVP (этап 12);
- MCP как способ исполнения — этап 12;
- события платформы о вызове узла (`node.*`) и показ в UI — 009.

## 3. Требования

| ID | Требование | Приоритет |
|---|---|---|
| REQ-026-1 | Оркестратор MUST исполнять один вызов узла по `NodeInvocation`: `poll` у `trigger` и `channel`, `send` у `channel`, `operation` у `connector`, `execute` у `program`. Ответ — `NodeInvocationResult` (4.10). | MUST |
| REQ-026-2 | До создания песочницы оркестратор MUST проверить вызов по своему реестру в таком порядке: тип известен; вид исполняемый; вид вызова подходит виду узла; операция есть; настройки и вход проходят схемы манифеста; ключи `credentials` вызова совпадают с именами `credentials` манифеста; все секреты есть в организации. Первая ошибка возвращается результатом `ok: false`, песочница не создаётся. | MUST |
| REQ-026-3 | Выход узла MUST проверяться оркестратором по схеме манифеста: выход программы, выход операции, каждое событие `poll`. Несовпадение — `invalid_output`. Проверке внутри песочницы платформа не доверяет. | MUST |
| REQ-026-4 | Песочница узла MUST создаваться на каждый вызов в сети `DOCKER_NODE_NETWORK` без выхода наружу, с ограничениями 4.9 и без секретов в env. Она MUST удаляться после вызова при любом исходе: успех, ошибка, таймаут, сбой протокола. Песочницы узлов прошлого запуска удаляются при старте оркестратора. | MUST |
| REQ-026-5 | Секреты MUST попадать в песочницу только кадром `invoke` в stdin и только объявленные в `credentials` манифеста. | MUST |
| REQ-026-6 | Исходящий прокси MUST принимать только `CONNECT` с действующим токеном `EgressGrant` и только к `host:port`, которые проходят `egressMatches` по `egress` гранта. Он MUST разрешать имя сам, отказывать, если любой адрес из ответа DNS непубличный (4.7), и соединяться с проверенным адресом. | MUST |
| REQ-026-7 | Секрет организации MUST храниться только шифротекстом AES-256-GCM с привязкой к `orgId` и имени. Значение MUST NOT попадать в ответы API, логи, события, графы и результаты вызова, кроме выхода узла (4.10, шаг 9). | MUST |
| REQ-026-8 | `api` MUST давать администратору организации список, запись и удаление секретов своей организации. Без права `secret.manage` — `403`. Чужая организация недоступна. | MUST |
| REQ-026-9 | Логи узла MUST попадать в лог оркестратора с контекстом вызова и с заменой значений секретов на `[secret]`. Действуют лимиты 4.8. То же правило замены — в `error.message` результата. | MUST |
| REQ-026-10 | `ctx.state` MUST читать и писать значения в Postgres по ключу `(orgId, stateKey, key)`, `null` удаляет ключ. Действуют лимиты 4.5. | MUST |
| REQ-026-11 | Вызов MUST завершаться результатом `timeout` по истечении `timeoutMs`. Порядок: кадр `abort`, `NODE_ABORT_GRACE_MS`, удаление песочницы. | MUST |
| REQ-026-12 | Кадр больше `NODE_FRAME_MAX_BYTES`, нераспознанный кадр, кадр не в свой момент, выход процесса без `result` — MUST давать `protocol_error` и удаление песочницы. | MUST |
| REQ-026-13 | Сверка хоста с `egress` MUST быть одной функцией `egressMatches` в `@swag/contracts`. Её используют тестовая обвязка SDK и прокси. Поведение обвязки 021 (AC-021-13) не меняется. | MUST |
| REQ-026-14 | Загрузчик манифестов MUST быть одним пакетом `@swag/node-packages`, общим для `api` и оркестратора. Поведение `api` из 021 (AC-021-4, AC-021-17, AC-021-18) не меняется. | MUST |
| REQ-026-15 | Вызов обработчика по виду MUST быть одной функцией `invokeNode` в `@swag/node-sdk/runtime`. Её используют `apps/node-host` и тестовая обвязка; поведение `runNode`, `runOperation`, `runPoll`, `runSend` не меняется. | MUST |
| REQ-026-16 | Подключение нового типа узла к исполнению MUST NOT требовать правки ядер, `@swag/contracts` и `apps/*/src`. Достаточно добавить пакет в `NODE_PACKAGES` и в зависимости `apps/node-host`. | MUST |
| REQ-026-17 | `npm run check` MUST проверять типы UI-приложений с их строгими флагами (из N-29). | MUST |
| REQ-026-18 | README новых и затронутых пакетов, `docs/architecture.md`, корневой README и глоссарий MUST описывать исполнение узлов, секреты и прокси. | MUST |

## 4. Контракты

### 4.1. `@swag/contracts`

`node.ts`, дополнения:

```ts
// Единое правило сверки (REQ-026-13). hostname — в нижнем регистре, без скобок IPv6; port — число.
// Запись без порта подходит только к 443; запись с портом — только к тому же порту.
// "api.example.com" — только этот хост; "*.example.com" — хост, оканчивающийся на ".example.com", с любым числом уровней перед ним; сам "example.com" не подходит.
export function egressMatches(egress: readonly EgressHost[], hostname: string, port: number): boolean;
```

Тестовая обвязка SDK (021, 4.3) переходит на `egressMatches(egress, url.hostname, url.port === '' ? 443 : Number(url.port))` при `protocol === 'https:'`. Правило «пустой порт — порт по умолчанию» в 021 для `https:` и означает 443.

Новый файл `node-invocation.ts`:

```ts
import { z } from 'zod';
import { NodeTypeRef, type NodeErrorCode } from './node.ts'; // NodeErrorCode — коды SDK 021, см. ниже

export const SecretName = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export type SecretName = z.infer<typeof SecretName>;

export const SecretValue = z.string().min(1).max(8192);

export const SecretSummary = z.strictObject({
  name: SecretName,
  hint: z.string().length(4).nullable(), // последние 4 символа значения, если в нём ≥ 16 символов; иначе null
  updatedAt: z.iso.datetime(),
});
export type SecretSummary = z.infer<typeof SecretSummary>;
export const SecretList = z.strictObject({ items: z.array(SecretSummary) }); // по name по возрастанию
export const SecretPutRequest = z.strictObject({ value: SecretValue });

export const NodeCall = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('execute'), input: z.unknown() }),                        // program
  z.strictObject({ kind: z.literal('operation'), operation: z.string().min(1), input: z.unknown() }), // connector
  z.strictObject({ kind: z.literal('poll'), cursor: z.string().max(4096).nullable() }),      // trigger, channel
  z.strictObject({ kind: z.literal('send'), message: z.unknown() }),                         // channel
]);
export type NodeCall = z.infer<typeof NodeCall>;

export const NodeInvocation = z.strictObject({
  orgId: z.uuid(),
  type: NodeTypeRef,
  call: NodeCall,
  settings: z.record(z.string(), z.unknown()),
  credentials: z.record(z.string(), SecretName), // имя из credentials манифеста → имя секрета организации
  stateKey: z.string().min(1).max(200),          // в 009 — id узла графа
  timeoutMs: z.number().int().min(1000).max(300_000).optional(), // по умолчанию NODE_INVOKE_TIMEOUT_MS
});
export type NodeInvocation = z.infer<typeof NodeInvocation>;

export const NodeInvocationErrorCode = z.enum([
  'node_type_not_found',   // нет в реестре оркестратора
  'not_executable',        // llm-agent, human
  'invalid_call',          // вид вызова не подходит виду узла; ключи credentials не совпадают с манифестом
  'unknown_operation',
  'invalid_settings',
  'invalid_input',
  'invalid_output',
  'secret_missing',        // секрета с указанным именем нет в организации
  'secret_not_declared',   // из песочницы: secrets.get с именем вне credentials
  'egress_denied',         // из песочницы: http.fetch мимо egress
  'node_failed',           // обработчик бросил исключение не NodeError
  'timeout',
  'sandbox_failed',        // песочницу не удалось создать или подключиться к ней
  'protocol_error',
]);
export type NodeInvocationErrorCode = z.infer<typeof NodeInvocationErrorCode>;

export const NodeInvocationResult = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), output: z.unknown(), durationMs: z.number().int().min(0) }),
  z.strictObject({
    ok: z.literal(false),
    error: z.strictObject({ code: NodeInvocationErrorCode, message: z.string().max(1000) }),
    durationMs: z.number().int().min(0),
  }),
]);
export type NodeInvocationResult = z.infer<typeof NodeInvocationResult>;
// output: execute и operation — выход после parse схемы; poll — { events, cursor }; send — null.

export const EgressGrant = z.strictObject({
  invocationId: z.uuid(),
  egress: z.array(EgressHost).max(16),
  expiresAt: z.number().int(), // мс эпохи
});
export type EgressGrant = z.infer<typeof EgressGrant>;
```

`NodeErrorCode` SDK (021, 4.3) — подмножество `NodeInvocationErrorCode`. Код из песочницы, которого нет в `NodeInvocationErrorCode`, — `protocol_error`.

`access.ts`: право `secret.manage` — только у роли `admin` (Q-6). Тест прав ролей 024 и 021 дополняется.

### 4.2. `@swag/api-integration`, реестр

`NodeRegistry` получает метод, остальное из 021 не меняется:

```ts
export type NodeSchemaTarget =
  | { place: 'inputs' }
  | { place: 'outputs' }
  | { place: 'operation'; name: string; io: 'input' | 'output' };

export type ValueResult =
  | { ok: true; value: unknown } // результат parse схемы
  | { ok: false; error: { code: 'node_type_not_found' } | { code: 'schema_not_found' } | { code: 'invalid_value'; issues: SettingsIssue[] } };

export interface NodeRegistry {
  // ...021
  validate(ref: string, target: NodeSchemaTarget, value: unknown): ValueResult;
}
```

- Схемы уже построены при создании реестра (021, 4.2), повторно не строятся.
- `schema_not_found`: у вида нет `inputs` или `outputs` (значение `null` в манифесте) или нет операции с таким именем.

### 4.3. `@swag/node-sdk/runtime`

Новый вход пакета: `exports["./runtime"]` → `./src/runtime.ts`. Код не импортирует `node:*` и не читает `process`.

```ts
import type { NodeCall } from '@swag/contracts';
import type { NodeContext, NodeDefinition } from './index.ts';

// Проверяет настройки, вход и выход схемами определения; ошибки — NodeError с кодами 021.
// Вид вызова не подходит виду узла — NodeError('unknown_operation'). execute и operation отдают выход,
// poll — PollResult, send — null.
export function invokeNode(definition: NodeDefinition, call: NodeCall, ctx: NodeContext<unknown>): Promise<unknown>;
export function parseSettings(definition: NodeDefinition, settings: unknown): unknown; // NodeError('invalid_settings')
```

`runNode`, `runOperation`, `runPoll`, `runSend` и `createTestContext` из `./testing` вызывают `invokeNode` и `parseSettings`, а не свою копию проверок. Тесты 021 (AC-021-11…14) остаются зелёными без правки.

### 4.4. `@swag/node-packages`

Новый пакет `packages/node-packages`. Это не ядро: он читает файлы, поэтому `node:*` разрешены. Содержимое `apps/api/src/node-types.ts` переносится сюда без изменения поведения, а `apps/api` импортирует его отсюда. Фикстуры и тест `apps/api/test/node-types.test.ts` переезжают в `packages/node-packages/test/` с теми же id AC-021-4, AC-021-17, AC-021-18.

```ts
export class NodeTypesLoadError extends Error { /* как в 021, 4.7 */ }
export interface LoadNodeTypesOptions { resolve?: (specifier: string) => string }

export interface NodePackages {
  registry: NodeRegistry;
  packageOf(ref: string): string | null; // имя пакета, из которого загружен тип; неизвестный — null
}
export async function loadNodePackages(packages: readonly string[], options?: LoadNodeTypesOptions): Promise<NodePackages>;
export async function loadNodeRegistry(packages: readonly string[], options?: LoadNodeTypesOptions): Promise<NodeRegistry>; // = (await loadNodePackages(...)).registry
export async function bootNodePackages(
  packages: readonly string[],
  deps: { log: { error(msg: string, data?: object): void }; fail: () => Promise<never>; resolve?: (specifier: string) => string },
): Promise<NodePackages>; // правила bootNodeRegistry 021, 4.7
export async function bootNodeRegistry(/* как в 021 */): Promise<NodeRegistry>;
```

### 4.5. Postgres

Миграция `packages/adapter-postgres/migrations/0006_nodes.sql`:

```sql
create table org_secrets (
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  ciphertext bytea not null,         -- iv (12 байт) || tag (16 байт) || шифротекст
  hint text null,
  updated_at timestamptz not null,
  updated_by uuid not null references users(id),
  primary key (org_id, name)
);

create table node_state (
  org_id uuid not null references organizations(id) on delete cascade,
  state_key text not null,
  key text not null,
  value text not null,
  updated_at timestamptz not null,
  primary key (org_id, state_key, key)
);
```

`adapter-crypto`, шифр:

```ts
export interface SecretCipher {
  encrypt(plaintext: string, aad: string): Uint8Array; // AES-256-GCM, случайный iv 12 байт; результат iv||tag||data
  decrypt(blob: Uint8Array, aad: string): string;      // неверный ключ, aad или подмена — исключение
}
export function createAesGcmCipher(keyBase64: string): SecretCipher; // ключ ровно 32 байта, иначе исключение
```

AAD — строка `${orgId}:${name}`: шифротекст, перенесённый в другую организацию или под другое имя, не расшифровывается.

`adapter-postgres`:

```ts
export function createPostgresSecretStore(sql: Sql, cipher: SecretCipher): SecretStore & SecretReader;
export function createPostgresNodeState(sql: Sql): NodeStateStore;
```

Порты объявляют ядра. `SecretStore` объявляет `api-core` (4.6), `SecretReader` и `NodeStateStore` — `orchestrator-core` (4.10).

- `put` — `insert ... on conflict (org_id, name) do update`, `hint` по правилу `SecretSummary`.
- `read(orgId, names)` отдаёт только найденные имена.
- Лимиты состояния проверяет ядро оркестратора до вызова адаптера: `key` — 1…200 символов, `value` — до 65 536 символов. Нарушение — ответ на кадр с ошибкой, лог `warn node state rejected`.

### 4.6. Секреты в `api-core` и `api`

```ts
// порт api-core
export interface SecretStore {
  list(orgId: string): Promise<SecretSummary[]>;
  put(orgId: string, name: SecretName, value: string, by: string, now: Date): Promise<SecretSummary>;
  delete(orgId: string, name: SecretName): Promise<boolean>; // false — не было
}
// операции
listSecrets(actor: Actor): Promise<Result<SecretList>>;
putSecret(actor: Actor, name: string, body: unknown): Promise<Result<SecretSummary>>;
deleteSecret(actor: Actor, name: string): Promise<Result<null>>;
```

Организация — всегда `actor.orgId`, из запроса не берётся. Проверка `can(actor, 'secret.manage')` идёт первой.

| Метод и путь | Ответ | Ошибки |
|---|---|---|
| `GET /secrets` | `200 SecretList` | `401`, `403 forbidden` |
| `PUT /secrets/:name` | `200 SecretSummary` | `400 invalid_request` (имя не `SecretName`, тело не `SecretPutRequest`), `401`, `403 forbidden` |
| `DELETE /secrets/:name` | `204` | `401`, `403 forbidden`, `404 not_found` |

Маршруты идут внутри общего блока REST с проверкой токена (024, 4.5). Fastify не логирует тело запроса: значение секрета не попадает в лог `api`. Это проверяется тестом.

### 4.7. Исходящий прокси

Ядро `packages/egress-proxy-core` по правилам ядра: зависимости `zod` и `@swag/contracts`.

```ts
export interface GrantVerifier { verify(token: string): EgressGrant | null } // подпись неверна или формат — null
export interface Resolver { resolve(hostname: string): Promise<string[]> }  // все A и AAAA; ошибка — исключение

export type Decision =
  | { ok: true; address: string; port: number; invocationId: string }
  | { ok: false; status: 403 | 405 | 407 | 502; reason: 'method' | 'auth' | 'expired' | 'host' | 'private_address' | 'resolve_failed' };

export function createEgressProxyCore(deps: { grants: GrantVerifier; resolver: Resolver; clock: Clock; logger: Logger }): {
  // method — метод запроса; target — "host:port" из CONNECT; proxyAuthorization — заголовок как есть
  authorize(method: string, target: string, proxyAuthorization: string | undefined): Promise<Decision>;
};
export function isPublicAddress(address: string): boolean;
```

Порядок `authorize`:

1. Метод не `CONNECT` — `405 method`.
2. Заголовок не `Basic base64("swag:" + token)`, или `verify` вернул `null` — `407 auth`.
3. `expiresAt` ≤ `clock.now()` — `407 expired`.
4. Хост — в нижний регистр; порт — целое 1…65535. Не проходит `egressMatches` — `403 host`. IP-литерал в `egress` не встречается (021, 4.1), поэтому тоже отклоняется.
5. `resolve` бросил исключение — `502 resolve_failed`. Если хоть один адрес не проходит `isPublicAddress` — `403 private_address`. Иначе соединение идёт с первым адресом.

`isPublicAddress` отклоняет:
- IPv4: `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, `224/4`, `240/4`;
- IPv6: `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, а также `::ffff:a.b.c.d`, если адрес `a.b.c.d` отклоняется.

Логи ядра:
- `info egress allowed` с полями `invocationId`, `host`, `port`;
- `warn egress denied` с полями `reason`, `host`, `port` и `invocationId`, если грант разобран.

Токен и заголовок в лог не пишутся.

Токен гранта — `base64url(JSON.stringify(grant)) + '.' + base64url(HMAC-SHA256(key, первая часть))`. В `adapter-crypto`:

```ts
export function createEgressGrants(keyBase64: string): { issue(grant: EgressGrant): string } & GrantVerifier; // ключ — 32 байта
```

Сверка подписи — `timingSafeEqual`. JSON, который не проходит `EgressGrant`, — `null`.

Оболочка `apps/egress-proxy` (Fastify не нужен) — `node:http` сервер на `EGRESS_PROXY_PORT`:
- `connect` → `authorize`. Отказ — ответ `HTTP/1.1 <status>` и закрытие сокета. Разрешение — `net.connect(port, address)`, `200 Connection Established` и двунаправленный `pipe`.
- Обычный HTTP-запрос — `405`.
- `GET /health` на отдельном порту `EGRESS_PROXY_HEALTH_PORT` — `200`.
- Резолвер — `dns.promises.lookup(host, { all: true, verbatim: true })`.
- Телеметрия — как у остальных оболочек (016).

### 4.8. Процесс песочницы `apps/node-host` и протокол

`apps/node-host` — оболочка в песочнице. Зависимости: `@swag/node-sdk`, `@swag/contracts`, `undici` (`ProxyAgent`; точная версия — в журнал) и пакеты узлов. В MVP это `@swag/node-example`; `@swag/node-llm-agent` не нужен, у него нет кода. Образ — `apps/node-host/Dockerfile`, тег `swag-node-host:dev`, пользователь `node`, команда `node apps/node-host/src/main.ts`. Сервис compose `node-host` с `profiles: [node-host]` устроен по образцу `agent`. Сборка — `npm run node-host:image`.

Кадры — по одному JSON на строку, UTF-8, `\n`. Схемы — в `@swag/contracts`, `node-invocation.ts`: `HostFrame` (оркестратор → песочница) и `SandboxFrame` (песочница → оркестратор).

| Направление | Кадр | Когда |
|---|---|---|
| → | `{ t: 'invoke', invocationId, package, definition: { type, version }, call: NodeCall, settings, secrets: Record<string,string>, egressProxy: { url, token }, deadline }` | первый и единственный кадр вызова |
| → | `{ t: 'state', id, value: string \| null }` / `{ t: 'state', id, error: string }` | ответ на `state.get` / `state.set` |
| → | `{ t: 'abort' }` | по таймауту |
| ← | `{ t: 'log', level, msg, data? }` | `ctx.log.*` |
| ← | `{ t: 'state.get', id, key }`, `{ t: 'state.set', id, key, value }` | `ctx.state.*`; `id` — целое, уникальное в вызове |
| ← | `{ t: 'result', ok: true, output }` / `{ t: 'result', ok: false, code: NodeErrorCode \| 'node_failed', message }` | последний кадр, после него процесс выходит с кодом 0 |

Работа `node-host`:

1. Ничего не пишет в stdout до кадра `invoke`, потому что оркестратор подключается к stdio после запуска контейнера.
2. Делает `await import(package)` и берёт `default`. Если `type` или `version` не совпадают с `definition`, отвечает `result` `node_failed` с текстом `definition mismatch`.
3. Строит `NodeContext`:
   - `settings` — `parseSettings`;
   - `secrets.get` берёт значение из кадра. Имени нет — `NodeError('secret_not_declared')`;
   - `http.fetch` сначала проверяет `https:` и `egressMatches` по `egress` определения, иначе `NodeError('egress_denied')`. Затем вызывает `fetch` с `dispatcher: new ProxyAgent({ uri: egressProxy.url, token: 'Basic ' + base64('swag:' + token) })`;
   - `log` пишет кадры `log`;
   - `state` работает через кадры `state.*` и ответы `state`;
   - `signal` прерывается по кадру `abort` или по закрытию stdin.
4. Вызывает `invokeNode`. `NodeError` превращается в `result` с его кодом, любое другое исключение — в `node_failed` с `message` исключения.

Код узла в том же процессе недоверенный, поэтому все лимиты и проверки результата — на стороне оркестратора (4.10):

| Лимит | Значение | Нарушение |
|---|---|---|
| Строка кадра | `NODE_FRAME_MAX_BYTES`, по умолчанию 1 048 576 | `protocol_error` |
| Кадров `log` за вызов | 200 | дальше не пишутся, один `warn node log limit` |
| `msg` | 1000 символов | обрезается |
| `data` | 8192 байта в JSON | заменяется на `{ truncated: true }` |
| `message` в `result` | 1000 символов | обрезается |

### 4.9. Песочница узла в `adapter-docker`

Порт `orchestrator-core`:

```ts
export interface NodeSandboxSpec {
  template: string;                 // NODE_TEMPLATE
  metadata: Record<string, string>; // swag.kind=node, swag.invocation, swag.org
}
export interface NodeSandboxSession {
  sandboxId: string;
  write(line: string): void;                 // добавляет "\n"
  lines: AsyncIterable<string>;              // stdout построчно; заканчивается с выходом процесса
}
export interface NodeSandboxes {
  run(spec: NodeSandboxSpec): Promise<NodeSandboxSession>; // создаёт, запускает, подключает stdio
  remove(sandboxId: string): Promise<void>;                // нет такой — не ошибка
  list(match: Record<string, string | true>): Promise<string[]>;
}
```

`createDockerNodeSandboxes({ network, docker? })` в `adapter-docker`:

- `Env` — только `TRACEPARENT`: без `NATS_URL`, `LLM_GATEWAY_URL`, `OTEL_*` и секретов;
- `OpenStdin: true`, `StdinOnce: false`, `AttachStdin`, `AttachStdout`; stderr не читается как кадры, адаптер пишет его в лог `debug`;
- `HostConfig`:
  - `NetworkMode: network`, `ReadonlyRootfs: true`, `Tmpfs: { '/tmp': 'rw,size=64m' }`;
  - `CapDrop: ['ALL']`, `SecurityOpt: ['no-new-privileges']`;
  - `Memory: 268435456`, `NanoCpus: 500000000`, `PidsLimit: 64`;
  - без монтирований, портов и привилегий;
- `User: 'node'`.

Рантайм gVisor, тёплый пул и общие лимиты — 005.

### 4.10. `orchestrator-core`: вызов узла

Зависимости ядра дополняются:

```ts
nodes: { registry: NodeRegistry; packageOf(ref: string): string | null };
nodeSandboxes: NodeSandboxes;
secrets: SecretReader;      // read(orgId, names): Promise<Record<string, string>>
nodeState: NodeStateStore;  // get(orgId, stateKey, key): Promise<string | null>; set(orgId, stateKey, key, value: string | null, now): Promise<void>
egressGrants: { issue(grant: EgressGrant): string };
node: { template: string; egressProxyUrl: string; timeoutMs: number; abortGraceMs: number; frameMaxBytes: number };
```

`@swag/api-integration` — в зависимостях ядра (белый список).

Операция `invokeNode(invocation: NodeInvocation): Promise<NodeInvocationResult>`:

1. Проверки REQ-026-2 по реестру:
   - `node_type_not_found`;
   - `not_executable` — вид `llm-agent` или `human`;
   - `invalid_call` — сочетание вида узла и `call.kind` не из таблицы REQ-026-1;
   - `unknown_operation`;
   - `invalid_settings` — по `validateSettings`;
   - `invalid_input` — по `validate`: `inputs` для `execute`, `operation.input` для `operation`, `inputs` канала для `send`;
   - `invalid_call` — набор ключей `credentials` вызова не равен набору имён `credentials` манифеста;
   - `secret_missing` — `secrets.read` вернул не все имена; `message` называет отсутствующие имена секретов, а не значения.

   До песочницы, без её создания.
2. `invocationId` — `ids`. `deadline` = `now + (timeoutMs ?? node.timeoutMs)`. Токен — `egressGrants.issue({ invocationId, egress: manifest.egress, expiresAt: deadline + abortGraceMs })`.
3. `nodeSandboxes.run` с метками `swag.kind=node`, `swag.invocation`, `swag.org`. Сбой — `sandbox_failed`.
4. Отправка кадра `invoke`: `settings` после `validateSettings`, `secrets` — только из шага 1.
5. Чтение кадров:
   - кадр не по `SandboxFrame` или длиннее `frameMaxBytes` — `protocol_error`;
   - `log` — в лог ядра `node log` с уровнем кадра, полями `invocationId`, `nodeType`, `orgId` и `data` по лимитам 4.8, после вымарывания;
   - `state.get` и `state.set` — в `nodeState` с ключом `(orgId, stateKey, key)` и лимитами 4.5;
   - `result` — переход к шагу 7.
6. Если до `deadline` нет `result`, ядро шлёт `abort`. Если за `abortGraceMs` его тоже нет — `timeout`. Конец `lines` без `result` — `protocol_error`.
7. `result.ok: true` — проверка выхода по `validate`:
   - `outputs` для `execute`;
   - `operation.output` для `operation`;
   - для `poll` — форма `{ events: unknown[], cursor: string|null }`, каждое событие по `outputs`, `cursor` до 4096 символов;
   - для `send` выход должен быть `null`.

   Ошибка — `invalid_output`. `result.ok: false` — код из кадра; код вне `NodeErrorCode ∪ {node_failed}` — `protocol_error`.
8. В `finally` — `nodeSandboxes.remove`. Сбой удаления — `warn sandbox remove failed`, результат не меняется.
9. **Вымарывание**: каждое значение секрета вызова длиной от 4 символов заменяется на `[secret]` в `msg` и строковых значениях `data` логов узла и в `error.message`. Выход узла не меняется: что узел отдаёт в выход, решает автор узла.
10. Лог `info node invoke` с полями `invocationId`, `nodeType`, `orgId`, `callKind`, `ok`, `code`, `durationMs`.

`cleanupOrphans` дополнительно удаляет `nodeSandboxes.list({ 'swag.kind': 'node' })`.

HTTP `apps/orchestrator`:

| Метод и путь | Ответ | Ошибки |
|---|---|---|
| `POST /node-invocations` | `200 NodeInvocationResult` | `400 invalid_request` (тело не `NodeInvocation`), `401` (нет или неверный `ORCHESTRATOR_TOKEN`) |

Маршрут защищён так же, как `POST /swarms`. Тело запроса не логируется: в нём нет секретов, но есть настройки и вход организации.

`main.ts` оркестратора:
- `bootNodePackages(config.NODE_PACKAGES, ...)` до подключения к Docker;
- `createAesGcmCipher(config.SECRETS_KEY)`, `createPostgresSecretStore`, `createPostgresNodeState`;
- `createEgressGrants(config.EGRESS_PROXY_KEY)`;
- `createDockerNodeSandboxes({ network: config.DOCKER_NODE_NETWORK })`.

### 4.11. Env и compose

| Переменная | Где | Значение (`.env.example`) | Назначение |
|---|---|---|---|
| `SECRETS_KEY` | `ApiConfig`, `OrchestratorConfig` | base64 ровно 32 байт; в `.env.example` — пустое, `.env` — сгенерированный `openssl rand -base64 32` | ключ шифра секретов |
| `NODE_PACKAGES` | `OrchestratorConfig` (схема как у `api`, 021, 4.9) | `@swag/node-example` | типы, которые оркестратор исполняет |
| `NODE_TEMPLATE` | `OrchestratorConfig` | `swag-node-host:dev` | образ песочницы узла |
| `DOCKER_NODE_NETWORK` | `OrchestratorConfig` | `swag-nodes` | сеть песочниц узлов |
| `NODE_EGRESS_PROXY_URL` | `OrchestratorConfig` | `http://egress-proxy:3128` | адрес прокси изнутри сети узлов |
| `EGRESS_PROXY_KEY` | `OrchestratorConfig`, `EgressProxyConfig` | base64 32 байт, как `SECRETS_KEY` | подпись грантов |
| `NODE_INVOKE_TIMEOUT_MS` | `OrchestratorConfig` | `30000` (1000…300000) | таймаут по умолчанию |
| `NODE_ABORT_GRACE_MS` | `OrchestratorConfig` | `1000` | ожидание после `abort` |
| `NODE_FRAME_MAX_BYTES` | `OrchestratorConfig` | `1048576` | лимит строки кадра |
| `EGRESS_PROXY_PORT` | `EgressProxyConfig` | `3128` | порт прокси |
| `EGRESS_PROXY_HEALTH_PORT` | `EgressProxyConfig` | `3129` | здоровье |

`EgressProxyConfig` в `@swag/config` — без `DATABASE_URL`, плюс общие `LOG_LEVEL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `TELEMETRY_FLUSH_TIMEOUT_MS`. Ключ меньше или больше 32 байт — ошибка конфигурации при старте.

`compose.yaml`:

```yaml
networks:
  nodes:
    name: swag-nodes
    internal: true
```

- Сервис `egress-proxy` подключён к сетям `default` и `nodes`. Порт наружу не публикуется, healthcheck — по `EGRESS_PROXY_HEALTH_PORT`.
- `orchestrator` получает переменные 4.11 и `depends_on: egress-proxy`. В сеть `nodes` он не входит: с песочницей он общается через Docker API.
- `api` получает `SECRETS_KEY`.

Сгенерированные ключи пишутся в локальный `.env` в той же задаче, в чат и лог не выводятся.

### 4.12. Проверка типов UI в `check` (из N-29)

Корневой скрипт `typecheck:ui` прогоняет `tsc --noEmit -p apps/ui/<app>/tsconfig.app.json --rootDir .` для `shell`, `cabinet`, `admin`, `supervisor`. `npm run check` вызывает его после `typecheck`. Если `--rootDir .` не проходит для какого-то приложения, рядом с его `tsconfig.app.json` кладётся `tsconfig.check.json` с `extends` и нужным `rootDir`. Выбор между этими двумя путями — в журнал.

## 5. Критерии приёмки

- **AC-026-1** — *Given* `egress` `["api.example.com", "*.cdn.example.com", "x.example.com:8443"]`. *When* `egressMatches` сверяет:
  - `api.example.com:443` → `true`;
  - `a.b.cdn.example.com:443` → `true`;
  - `cdn.example.com:443` → `false`;
  - `api.example.com:8443` → `false`;
  - `x.example.com:8443` → `true`;
  - `x.example.com:443` → `false`.

  *Then* результаты такие, как в списке; тесты AC-021-13 обвязки зелёные без правки.
- **AC-026-2** — *Given* реестр с `example/echo@1.0.0` и коннектором-литералом. *When* `validate` вызывают с выходом не по схеме, с неизвестной операцией, с `inputs` у вида без входа. *Then* результаты — `invalid_value` с `issues`, `schema_not_found`, `schema_not_found`; верное значение даёт `ok: true` с результатом `parse`.
- **AC-026-3** — *Given* фикстуры программы, коннектора, канала и триггера SDK. *When* `invokeNode` вызывают с каждым видом вызова и с неподходящим видом. *Then* выходы совпадают с `runNode`/`runOperation`/`runPoll`/`runSend`, а неподходящий вид даёт `NodeError('unknown_operation')`.
- **AC-026-4** — *Given* пакет `@swag/node-packages`. *When* загружают `['@swag/node-example']`. *Then* `packageOf('example/echo@1.0.0')` — `'@swag/node-example'`, неизвестный тип — `null`; тесты AC-021-4, AC-021-17, AC-021-18 перенесены и зелёные.
- **AC-026-5** — *Given* шифр с ключом K. *When* шифруют значение с AAD `org1:key`, расшифровывают с AAD `org2:key`, с другим ключом и с изменённым байтом. *Then* все три расшифровки бросают; верная AAD возвращает значение; два шифрования одного значения дают разные шифротексты; ключ не 32 байта — исключение `createAesGcmCipher`.
- **AC-026-6** — *Given* Postgres с миграцией 0006. *When* `put` секрета `avito_token` длиной 20 символов, затем `list`, `read`, повторный `put`, `delete`. *Then* в таблице нет открытого значения (`position(value in convert_from(ciphertext,'latin1')) = 0`), `hint` — последние 4 символа, `read` отдаёт значение, повторный `put` заменяет, `delete` → `true`, затем `false`; секрет из 10 символов — `hint: null`.
- **AC-026-7** — *Given* `api` с администратором и пользователем организации A и администратором B. *When* администратор A делает `PUT /secrets/avito_token`, `GET /secrets`, `DELETE`; пользователь A — `GET /secrets`; администратор B — `GET /secrets`. *Then*:
  - у администратора A — `200` с `SecretSummary` без значения, затем список с одним секретом, затем `204`, повторный `DELETE` → `404`;
  - у пользователя A — `403 forbidden`;
  - у администратора B — пустой список;
  - имя `Bad Name` → `400 invalid_request`;
  - значения нет ни в одном теле ответа и ни в одной строке лога `api`.
- **AC-026-8** — *Given* ядро прокси с фейковыми `GrantVerifier`, `Resolver`, `Clock`. *When* `authorize`:
  - `GET` → `405 method`;
  - без заголовка → `407 auth`;
  - грант с прошедшим `expiresAt` → `407 expired`;
  - хост вне `egress` → `403 host`;
  - хост, разрешённый в `10.0.0.5`, → `403 private_address`;
  - хост с адресами `93.184.215.14` и `127.0.0.1` → `403 private_address`;
  - сбой резолвера → `502 resolve_failed`;
  - верный случай → `ok` с адресом.

  *Then* результаты такие, как в списке, а в логах нет токена.
- **AC-026-9** — *Given* `isPublicAddress`. *When* проверяют по одному адресу из каждого диапазона 4.7, `::ffff:127.0.0.1` и публичные `1.1.1.1` и `2606:4700::1111`. *Then* все диапазоны и `::ffff:127.0.0.1` → `false`, публичные → `true`.
- **AC-026-10** — *Given* `createEgressGrants` с ключом K. *When* выдают токен и проверяют его тем же ключом, другим ключом, с изменённым символом полезной части и с полезной частью не по `EgressGrant`. *Then* первый случай возвращает грант, остальные — `null`.
- **AC-026-11** — *Given* оболочка прокси на случайном порту с резолвером, отдающим `127.0.0.1` для `allowed.test`, и проверкой адреса, подменённой в тесте так, чтобы локальный адрес считался публичным. Плюс локальный TCP-эхо-сервер. *When* клиент шлёт `CONNECT allowed.test:<port>` с верным токеном, `CONNECT other.test:<port>` и обычный `GET`. *Then* первый получает `200` и эхо через туннель, второй — `403`, `GET` — `405`.
- **AC-026-12** — *Given* фейковые порты ядра оркестратора и реестр с `example/echo`, фикстурным коннектором с `credentials: [{ name: 'apiKey' }]` и узлом вида `llm-agent`. *When* `invokeNode` вызывают с каждой ошибкой шага 1 из 4.10. *Then* приходит соответствующий код (`node_type_not_found`, `not_executable`, `invalid_call` ×2, `unknown_operation`, `invalid_settings`, `invalid_input`, `secret_missing`), а `nodeSandboxes.run` не вызывался.
- **AC-026-13** — *Given* фейковая песочница, которая отвечает заданными кадрами. *When* вызов `execute` echo завершается `result` с верным выходом. *Then*:
  - результат `ok: true` с выходом после `parse`;
  - кадр `invoke` содержит `secrets` только из `credentials` манифеста, `egressProxy.token` выдан с `egress` манифеста и `expiresAt = deadline + abortGraceMs`;
  - песочница удалена;
  - лог `info node invoke` записан.
- **AC-026-14** — *Given* фейковая песочница. *When* она отдаёт выход не по схеме, событие `poll` не по схеме, `result` с кодом `egress_denied`, `result` с неизвестным кодом, строку не JSON, строку длиннее `frameMaxBytes`, конец потока без `result`. *Then* коды — `invalid_output`, `invalid_output`, `egress_denied`, `protocol_error` ×4; во всех случаях песочница удалена.
- **AC-026-15** — *Given* фейковая песочница, которая не отвечает, и ручные таймеры. *When* наступает `deadline`. *Then* в песочницу уходит `abort`; если `result` нет за `abortGraceMs` — `timeout`, песочница удалена; если `result` пришёл в пределах грейса — он и возвращается.
- **AC-026-16** — *Given* вызов с секретом `apiKey = 'fake-secret-value'`. *When* песочница шлёт `log` с `msg` и `data`, где есть это значение, и `result ok: false` с `message`, где оно есть. *Then* в записях фейкового логгера и в `error.message` вместо значения стоит `[secret]`. После 200 кадров `log` новые не пишутся, `warn node log limit` записан один раз.
- **AC-026-17** — *Given* фейковая песочница и фейковое хранилище состояния. *When* песочница шлёт `state.set k=v`, `state.get k`, `state.set k=null`, `state.get k`, `state.set` с ключом длиннее 200 и значением длиннее 65 536 символов. *Then*:
  - ответы — `null` на запись, `v`, `null`, `null`;
  - ключи хранилища — `(orgId, stateKey, k)`;
  - на слишком длинные ключ и значение — кадры `state` с `error`, в хранилище ничего не записано.
- **AC-026-18** — *Given* Postgres. *When* `NodeStateStore` пишет одинаковый `key` под двумя `orgId` и двумя `stateKey`. *Then* четыре значения независимы; `set(null)` удаляет только свою строку.
- **AC-026-19** — *Given* `createDockerNodeSandboxes` с фейковым клиентом dockerode. *When* `run`. *Then* в `createContainer` переданы:
  - сеть из опций, `ReadonlyRootfs`, `Tmpfs`, `CapDrop: ['ALL']`, `no-new-privileges`, `Memory`, `NanoCpus`, `PidsLimit`, `User: 'node'`, `OpenStdin`;
  - `Env` без `NATS_URL`, `LLM_GATEWAY_URL`, `OTEL_*` и значений секретов;
  - без `Binds` и `PortBindings`;
  - метки из `metadata`.
- **AC-026-20** — *Given* `apps/node-host` запущен как дочерний процесс с пакетом `@swag/node-example`. *When* в stdin приходит `invoke` `execute` echo, затем — `invoke` фикстурного узла, который пишет `log`, делает `state.get` и `secrets.get('missing')`. *Then*:
  - до `invoke` stdout пуст;
  - первый процесс пишет `result ok: true` с эхо и выходит с кодом 0;
  - второй пишет кадры `log`, `state.get` и после ответа `state` — `result ok: false` с кодом `secret_not_declared`.
- **AC-026-21** — *Given* `POST /node-invocations` оркестратора с фейковым ядром. *When* без токена, с неверным телом, с верным. *Then* `401`, `400 invalid_request`, `200` с результатом ядра; тело запроса не попадает в лог.
- **AC-026-22** — *Given* `OrchestratorConfig`, `ApiConfig`, `EgressProxyConfig`. *When* `SECRETS_KEY` или `EGRESS_PROXY_KEY` — 16 байт, пусто или не base64; `NODE_INVOKE_TIMEOUT_MS` = 500. *Then* `loadConfig` бросает, а значения из `.env.example` (с подставленными ключами) проходят.
- **AC-026-23** — *Given* `cleanupOrphans` с фейковыми `NodeSandboxes`, где есть две песочницы `swag.kind=node`. *When* оркестратор стартует. *Then* обе удалены.
- **AC-026-24** — *Given* корневой `package.json`. *When* `npm run check`. *Then* в нём есть шаг `typecheck:ui`. Тест в `scripts/repo.test.ts` проверяет, что `check` вызывает `typecheck:ui`, а `typecheck:ui` упоминает все четыре приложения.
- **AC-026-25** `[manual]` — *Given* `npm run node-host:image`, `npm run up` со сгенерированными ключами в `.env`. *When*:
  1. `curl` к `POST /node-invocations` с `ORCHESTRATOR_TOKEN` и вызовом `example/echo@1.0.0` `execute` `{ text: 'hi' }`, `settings: { prefix: '> ' }`;
  2. тот же вызов с `settings: { prefix: 1 }`;
  3. изнутри песочницы (`docker run --rm --network swag-nodes swag-node-host:dev node -e "fetch('https://example.com').then(()=>console.log('open'),e=>console.log('closed', e.cause?.code))"`) — прямой выход наружу;
  4. через прокси без токена — `curl -x http://egress-proxy:3128 https://example.com` из контейнера в сети `swag-nodes`.

  *Then*:
  1. `ok: true`, `{ text: '> hi' }`, после вызова `docker ps -a --filter label=swag.kind=node` пуст;
  2. `invalid_settings` без запуска контейнера;
  3. `closed`;
  4. `407`.

  Результат прикладывается в журнал.
- **AC-026-26** `[manual]` — *Given* стек из AC-026-25 и временный пакет узла `example/http` (программа, `egress: ['example.com']`, делает `ctx.http.fetch('https://example.com')`), добавленный в `NODE_PACKAGES` и `apps/node-host`. *When* его вызывают. Затем меняют `egress` на `['example.org']`, пересобирают манифест и образ и вызывают снова. *Then* первый вызов `ok: true` со статусом 200. Второй — `egress_denied`; в логе `egress-proxy` нет `egress allowed` для `example.com`. Ядра, `@swag/contracts` и `apps/*/src` не менялись (REQ-026-16). Временный пакет после проверки удаляется.

## 6. Нефункциональные требования

| ID | Требование | Как измеряется |
|---|---|---|
| NFR-026-1 | Накладные расходы вызова `example/echo` на dev-стеке (Docker Desktop, `runc`): p50 < 2000 мс, p95 < 4000 мс от приёма запроса до ответа | 20 последовательных вызовов `curl` после прогрева, замер `durationMs` и времени ответа; результат в журнал (Q-9) |
| NFR-026-2 | `egressMatches` и `authorize` без DNS — < 1 мс на вызов | тест-бенч 10 000 вызовов < 1000 мс |

## 7. Безопасность: что не должно сломаться

- Код узла не выходит в сеть мимо прокси: сеть `swag-nodes` `internal` → AC-026-25 (п. 3).
- Прокси не пускает за пределы `egress`, на внутренние и частные адреса и без гранта → AC-026-8, AC-026-9, AC-026-11, AC-026-25 (п. 4), AC-026-26.
- Грант нельзя подделать или продлить → AC-026-10, AC-026-8 (`expired`).
- Секрет хранится только шифротекстом и не расшифровывается в чужой организации или под чужим именем → AC-026-5, AC-026-6.
- Значение секрета не уходит в ответы `api` и логи → AC-026-7, AC-026-16; не попадает в env песочницы → AC-026-19.
- Узел получает только объявленные секреты своей организации → AC-026-12 (`secret_missing`, `invalid_call`), AC-026-13.
- Недоверенный код не обходит проверки выхода, лимиты кадров и таймаут → AC-026-14, AC-026-15, AC-026-16.
- Песочница узла не остаётся после вызова и после перезапуска оркестратора → AC-026-13, AC-026-14, AC-026-23, AC-026-25.
- Песочница узла без привилегий, монтирований и портов → AC-026-19.
- Секреты и состояние разделены по организациям → AC-026-7, AC-026-18.
- Поведение 021 (каталог, обвязка, загрузчик) не меняется → AC-026-1, AC-026-3, AC-026-4.
- В тестах и фикстурах — только фейковые значения (`fake-secret-value`, ключи из нулей).

## 8. Задачи для агента

Выполняются по порядку. После каждой задачи — коммит; `npm run typecheck` и тесты зелёные на каждом коммите; README пакета — в том же коммите.

- [ ] **T-1.** `packages/contracts/src/node.ts`: `egressMatches`. Новый `node-invocation.ts` по 4.1 и 4.8 (`HostFrame`, `SandboxFrame`), экспорт из `index.ts`. `access.ts`: `secret.manage` у `admin`. Тесты `packages/contracts/test/node-invocation.test.ts` и `access.test.ts`. Закрывает: REQ-026-13 (функция), AC-026-1. Готово, когда: тесты зелёные, README `contracts` и глоссарий дополнены.
- [ ] **T-2.** `packages/node-sdk`: `src/runtime.ts` (`invokeNode`, `parseSettings`), `exports["./runtime"]`. `src/testing.ts` переходит на `invokeNode`, `parseSettings` и `egressMatches`. Тест `test/runtime.test.ts`. Закрывает: REQ-026-13, REQ-026-15, AC-026-3. Готово, когда: тесты 021 зелёные без правки, README SDK дополнен.
- [ ] **T-3.** `packages/api-integration/src/node-registry.ts`: `validate` по 4.2; тесты в `test/node-registry.test.ts`. Закрывает: AC-026-2. Готово, когда: тесты зелёные, README дополнен.
- [ ] **T-4.** Пакет `packages/node-packages` по 4.4: перенос `apps/api/src/node-types.ts`, фикстур и теста, `loadNodePackages`, `packageOf`, `bootNodePackages`. `apps/api` импортирует отсюда, старый файл удалён, строка в корневом `tsconfig.json`. Закрывает: REQ-026-14, AC-026-4. Готово, когда: тесты зелёные, README нового пакета, README `apps/api` обновлён.
- [ ] **T-5.** `packages/adapter-crypto`: `createAesGcmCipher` и `createEgressGrants` по 4.5 и 4.7; тесты. Закрывает: AC-026-5, AC-026-10. Готово, когда: тесты зелёные, README дополнен.
- [ ] **T-6.** `packages/adapter-postgres`: миграция `0006_nodes.sql`, `createPostgresSecretStore`, `createPostgresNodeState` по 4.5. В этой же задаче объявляются интерфейсы портов, которые адаптер реализует: `SecretStore` в `api-core`, `SecretReader` и `NodeStateStore` в `orchestrator-core` — только тип и экспорт, без операций. Тесты на Postgres. Закрывает: AC-026-6, AC-026-18. Готово, когда: тесты зелёные, README дополнен.
- [ ] **T-7.** `packages/config`: `SECRETS_KEY` в `ApiConfig`; переменные 4.11 в `OrchestratorConfig`; новый `EgressProxyConfig`; тесты. `.env.example`, локальный `.env` со сгенерированными ключами (значения не выводить), `compose.yaml`: сеть `nodes`, переменные `api` и `orchestrator`. Закрывает: AC-026-22. Готово, когда: тесты зелёные, README `config` дополнен.
- [ ] **T-8.** `api-core`: операции `listSecrets`, `putSecret`, `deleteSecret` с `SecretStore` по 4.6; тесты ядра, включая «чужая организация» и `403`. Все места сборки `ApiCoreDeps` получают `secrets`: фейк в тестах, Postgres в `start.ts`/`main.ts`. Закрывает: REQ-026-8 (ядро). Готово, когда: тесты зелёные, README дополнен.
- [ ] **T-9.** `apps/api`: маршруты `/secrets` по 4.6, `createAesGcmCipher(config.SECRETS_KEY)` в `main.ts`; тест `apps/api/test/secrets-http.test.ts` с проверкой логов. Закрывает: REQ-026-7, REQ-026-8, AC-026-7. Готово, когда: тесты зелёные, README `apps/api` дополнен.
- [ ] **T-10.** Ядро `packages/egress-proxy-core` по 4.7 (`authorize`, `isPublicAddress`) с README по схеме CLAUDE.md, строки в корневом `tsconfig.json` и в `arch:check`, если он перечисляет ядра. Тесты AC-026-8, AC-026-9 и бенч NFR-026-2. Закрывает: REQ-026-6 (логика). Готово, когда: тесты и `arch:check` зелёные.
- [ ] **T-11.** Оболочка `apps/egress-proxy` по 4.7: `main.ts`, `Dockerfile`, сервис `egress-proxy` в `compose.yaml` в сетях `default` и `nodes` с healthcheck; тест AC-026-11. Закрывает: REQ-026-6, AC-026-11. Готово, когда: тест зелёный, `npm run up` поднимает `egress-proxy` здоровым, README пакета, корневой README дополнен.
- [ ] **T-12.** `apps/node-host` по 4.8: `src/main.ts`, `package.json` (`undici` — точная версия в журнал), `Dockerfile`, сервис `node-host` с `profiles` в compose, скрипт `node-host:image`. Фикстурный узел для теста — в `apps/node-host/test/fixtures/`. Тест AC-026-20 запускает процесс через `child_process.spawn`. Закрывает: AC-026-20. Готово, когда: тест зелёный, образ собирается, README пакета.
- [ ] **T-13.** `adapter-docker`: `createDockerNodeSandboxes` по 4.9, порт `NodeSandboxes` объявлен в `orchestrator-core`; тест с фейковым dockerode. Закрывает: REQ-026-4 (адаптер), AC-026-19. Готово, когда: тест зелёный, README дополнен.
- [ ] **T-14.** `orchestrator-core`: `invokeNode` по 4.10, зависимости ядра, `cleanupOrphans` для узлов; тесты на фейках. Закрывает: REQ-026-1…5, REQ-026-9…12, AC-026-12…17, AC-026-23. Готово, когда: тесты зелёные, README `orchestrator-core` дополнен.
- [ ] **T-15.** `apps/orchestrator`: сборка зависимостей 4.10 в `main.ts`, маршрут `POST /node-invocations`; тест AC-026-21; `compose.yaml` — переменные и `depends_on`. Закрывает: AC-026-21. Готово, когда: тесты зелёные, `npm run up` поднимает оркестратор, README `apps/orchestrator` дополнен.
- [ ] **T-16.** `typecheck:ui` в корневом `package.json` и в `check` по 4.12; тест AC-026-24 в `scripts/repo.test.ts`. Закрывает: REQ-026-17, AC-026-24 (из N-29). Готово, когда: `npm run check` зелёный и падает, если в UI-коде вернуть `s.type` у `Record<string, unknown>` (проверено руками, результат в журнал).
- [ ] **T-17.** Документация и проверки: `docs/architecture.md` (исполнение узлов, прокси, секреты, новые пакеты), корневой README (`node-host:image`, ключи в `.env`), глоссарий сверен; ручные AC-026-25, AC-026-26 и замер NFR-026-1 — в журнал. Закрывает: REQ-026-16, REQ-026-18, NFR-026-1, AC-026-25, AC-026-26. Готово, когда: `npm run check` зелёный, README сверены с кодом.

## 9. Открытые вопросы

Пока список не пуст, спека не может быть `ready`.

- [x] **Q-1.** Где исполняются узлы платформы *(из D-32; Claude, 2026-11-02)*. Варианты:
  - **(а)** все узлы с кодом, включая `swag/*` (Авито, DNS, расчёт цены), — в песочнице, как сторонние; `llm-agent` и `human` исполняет платформа;
  - **(б)** узлы `swag/*` — в процессе оркестратора как доверенные, сторонние — в песочнице.

  Рекомендация — **«а»**. Один путь исполнения проверяет контракт на реальном кейсе, как требует роадмап («узлы MVP пишутся на том же публичном контракте»). Ошибка в узле платформы не роняет оркестратор. Цена — старт контейнера на вызов (NFR-026-1), её снимает тёплый пул 005. Спека написана под «а». **Ответ (человек, 2026-11-02):** (а) — по рекомендации.

- [x] **Q-2.** Кто публикует узлы в MVP *(из D-32; Claude, 2026-11-02)*. Варианты:
  - **(а)** только платформа: пакет попадает в образ `swag-node-host` при сборке и в `NODE_PACKAGES`;
  - **(б)** организация загружает свой пакет для себя;
  - **(в)** открытый каталог.

  Рекомендация — **«а»**. Целевому кейсу нужны только узлы платформы. Для «б» и «в» нужны загрузка пакета в работающую платформу, сборка образа на лету, модерация и подпись — отдельная спека после MVP. Новый вопрос D-159 записан в `questions.md`. **Ответ (человек, 2026-11-02):** (а) — по рекомендации.

- [x] **Q-3.** Кто платит за compute узла и запись стоимости из кода узла *(из D-32; Claude, 2026-11-02)*. Варианты:
  - **(а)** в 026 не считать: тариф compute решает 005 (D-126), метка `swag.org` на песочнице позволит его посчитать. `ctx.cost` не добавляется, пока нет узла, который сам платит за внешний API;
  - **(б)** уже в 026 писать секунды песочницы узла в ledger.

  Рекомендация — **«а»**: у compute ещё нет тарифа, а узлам MVP (DNS на чтение, Авито, расчёт) `ctx.cost` не нужен. **Ответ (человек, 2026-11-02):** (а) — по рекомендации.

- [x] **Q-4.** Хранение секретов организации *(из D-34; Claude, 2026-11-02)*. Варианты:
  - **(а)** Postgres, AES-256-GCM с AAD `orgId:name`, ключ `SECRETS_KEY` в `.env`, за портами `SecretStore`/`SecretReader`, которые потом реализует vault;
  - **(б)** vault (OpenBao) в compose уже в MVP.

  Рекомендация — **«а»**: vault в роадмапе появляется на этапе 12, порт позволяет заменить хранилище без правки ядер. Спека написана под «а». **Ответ (человек, 2026-11-02):** (а) — по рекомендации.

- [x] **Q-5.** Откуда оркестратор берёт реестр типов узлов *(из D-157 — в части исполнения; проверка графа остаётся за 009; Claude, 2026-11-02)*. Для вызова оркестратору нужны `egress`, `credentials` и схемы манифеста, а доверять песочнице нельзя. Варианты:
  - **(а)** оркестратор сам загружает манифесты по своему `NODE_PACKAGES` общим загрузчиком `@swag/node-packages`;
  - **(б)** `api` присылает манифест в каждом вызове;
  - **(в)** оркестратор запрашивает манифесты у `api` по внутреннему токену.

  Рекомендация — **«а»**. Вызов не зависит от `api`, загрузчик один. Риск расхождения списков у `api` и оркестратора снимается одной переменной в `.env`, которую compose передаёт обоим. Вопрос D-157 о проверке настроек графа при запуске остаётся за 009. **Ответ (человек, 2026-11-02):** (а) — по рекомендации.

- [x] **Q-6.** Кто управляет секретами и что показывается после ввода *(из D-35, часть про право и показ; Claude, 2026-11-02)*. Варианты:
  - **(а)** право `secret.manage` только у `admin`; после ввода — имя, дата и последние 4 символа, если в значении не меньше 16 символов;
  - **(б)** то же, но без последних символов;
  - **(в)** право ещё и у `user`.

  Рекомендация — **«а»**. Секреты — доступы организации, ими распоряжается администратор. 4 символа помогают отличить ключи и не раскрывают короткие значения. Супервизор секретов организации не видит. **Ответ (человек, 2026-11-02):** (а) — по рекомендации.

- [x] **Q-7.** Как оркестратор говорит с песочницей узла *(Claude, 2026-11-02)*. Варианты:
  - **(а)** stdin/stdout строками JSON через Docker attach: в сети песочницы только прокси, секреты не попадают в env и `docker inspect`;
  - **(б)** шина NATS, как у агентов: песочнице нужен NATS, а это лишний сетевой путь и account на вызов (007);
  - **(в)** HTTP-сервер в песочнице.

  Рекомендация — **«а»**: меньше всего поверхности, без новых сетевых путей. **Ответ (человек, 2026-11-02):** (а) — по рекомендации.

- [x] **Q-8.** Исходящий прокси: отдельный сервис или часть оркестратора *(Claude, 2026-11-02)*. Варианты:
  - **(а)** отдельный сервис `egress-proxy` с ядром и правом выхода по подписанному гранту, без состояния и управляющего API;
  - **(б)** прокси в процессе оркестратора на отдельном порту: тогда оркестратор входит в сеть песочниц, и его HTTP API становится им доступен.

  Рекомендация — **«а»**: оркестратор не попадает в сеть недоверенного кода, а сбой прокси не роняет запуск роёв. **Ответ (человек, 2026-11-02):** (а) — по рекомендации.

- [x] **Q-9.** Пороги вызова *(Claude, 2026-11-02)*. Предложено:
  - таймаут по умолчанию 30 с (1…300 с на вызов), грейс после `abort` 1 с;
  - кадр до 1 МиБ, до 200 записей лога на вызов, `msg` до 1000 символов, `data` до 8 КБ;
  - секрет до 8192 символов, имя `[a-z][a-z0-9_-]{0,63}`;
  - состояние: ключ до 200, значение до 65 536 символов;
  - песочница: 256 МиБ памяти, 0,5 CPU, 64 процесса, `/tmp` 64 МиБ;
  - NFR-026-1: p50 < 2 с, p95 < 4 с на dev-стеке.

  Рекомендация — принять. Вызовы коннекторов магазина — секунды, ответы API Авито и DNS укладываются в 1 МиБ. Лимиты песочницы — нижняя граница для Node 24 с одним пакетом. 005 пересмотрит их вместе с пулом. **Ответ (человек, 2026-11-02):** принять — по рекомендации.

## 10. Журнал реализации

Заполняет агент.

| Дата | Ветка / коммит | Что сделано | Отклонения от спеки |
|---|---|---|---|
