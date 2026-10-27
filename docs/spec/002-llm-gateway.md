---
id: "002"
title: LLM Gateway
status: in-progress
roadmap_stage: 2
depends_on: ["001", "016"]
superseded_by: null
updated: 2026-10-27
---

# 002. LLM Gateway

> **Коротко.** Все вызовы моделей идут через один сервис. Только он и LiteLLM за ним видят ключи провайдеров, а стоимость вызова считает он сам.
> - **Что появится.**
>   - Сервис `llm-gateway`: ядро `packages/llm-gateway-core`, оболочка `apps/llm-gateway` на Fastify.
>   - OpenAI-совместимый API: `POST /v1/chat/completions` обычным ответом и потоком SSE, `GET /v1/models`.
>   - За gateway стоит LiteLLM, он только переводит форматы провайдеров. Виртуальные ключи, бюджеты и БД LiteLLM не используются (D-21, решение «а»).
> - **Деньги.**
>   - Стоимость вызова считает gateway: по `usage` ответа и ценам платформы из каталога моделей. Считает в целых микродолларах, округляет вверх.
>   - После каждого вызова gateway публикует событие `llm.call` в поток событий роя: модель, токены, кэш, стоимость, задержка, статус.
>   - В том же событии — фактическая стоимость вызова у провайдера, если он её прислал (`usage.cost` у OpenRouter). Она только для учёта платформы (D-38), списание считается по тарифу.
>   - Ledger, ключи агентов и бюджеты сюда не входят — это спека 004.
> - **Ключи.**
>   - Ключи провайдеров и мастер-ключ LiteLLM лежат в отдельном файле `.env.llm`. Его читают только контейнеры `litellm` и `llm-gateway`.
>   - LiteLLM стоит в своей сети `llm`: из сети роя и из песочниц до него не дойти.
> - **Профили.** `LLM_PROFILE=test|dev|prod` выбирает каталог `infra/llm/<профиль>/` с конфигом LiteLLM и ценами. Имена моделей платформы одинаковы во всех профилях, поэтому смена профиля код не трогает.
>   - Профиль `test` ходит в фейкового провайдера из compose. На нём `npm run check` и CI работают без ключей.
> - **В UI** в ленте событий роя появится строка вызова модели: модель, токены, стоимость. Агентный цикл, который сам вызывает модель, — спека 022. В 002 модель вызывает тест и команда `npm run llm:ping`.
> - **Доступ к моделям.** В 002 — только общий доступ по ключам платформы. Свой ключ организации, за который платформа не берёт плату, — D-35. Gateway уже сейчас не пропускает ключ и адрес провайдера из тела запроса (REQ-002-18): потом ключ организации подставляет сам gateway.
> - **Из бэклога:**
>   - D-21 разложен на Q-1;
>   - N-4, N-5 и N-7 стали задачами T-33, T-2 и T-1.
> - **Что нужно от человека:**
>   - вопросы Q-1…Q-4 решены 2026-10-27: ключи платформы в `.env.llm`, OpenRouter в `dev` и `prod`, общий токен с заголовками до 004, модели `chat-small` и `chat-large`; статус `ready` ставит человек;
>   - для ручной проверки AC-002-25 — ключ провайдера dev в `.env.llm`.

## 1. Контекст и цель

Роадмап, [раздел 1 «LLM Gateway и LiteLLM»](../../AI_PLATFORM_ROADMAP.md#1-llm-gateway-и-litellm--единый-формат-и-учёт-денег), и этап 2 «Агенты думают».

Сейчас агенты из 001 модель не вызывают: эстафета без LLM. Ключей провайдеров на платформе нет.

Цель — единственная точка выхода к моделям.
- Gateway принимает OpenAI-совместимый запрос, пропускает его к LiteLLM и отдаёт ответ без изменений.
- По `usage` ответа gateway считает стоимость по ценам платформы и публикует `llm.call`.
- Ключи провайдеров не попадают ни в `api`, ни в оркестратор, ни в песочницы.

Это основание для агентного цикла (022) и для денег (004): в 004 к тому же вызову добавятся ключ агента, резерв бюджета и запись в ledger.

## 2. Объём

**Входит:**
- контракты: `llm.ts` в `@swag/contracts`, событие `llm.call`, источник и сервис `llm-gateway`;
- ядро `packages/llm-gateway-core`:
  - каталог моделей и формула стоимости;
  - обычный вызов и вызов потоком;
  - разбор `usage`, коды ошибок, событие `llm.call`;
  - проверка каталога против LiteLLM на старте;
- адаптер `packages/adapter-litellm`: HTTP-клиент LiteLLM — обычный ответ, разбор SSE, таймаут простоя, скрытие секретов в текстах ошибок, список моделей;
- оболочка `apps/llm-gateway`: Fastify, проверка токена, запись SSE, обрыв клиентом, телеметрия по 016, Dockerfile;
- фейковый провайдер `infra/llm/fake-provider/server.ts` для тестов и профиля `test`;
- профили `infra/llm/{test,dev,prod}/` и compose:
  - сервисы `litellm`, `llm-fake`, `llm-gateway`;
  - сеть `llm`;
  - файл `.env.llm`;
  - `infra:check`;
- строка `llm.call` в ленте UI;
- команда `npm run llm:ping`;
- задачи из бэклога: N-7 (Node 24.22.1), N-5 (исключение `.claude/**` в vitest), N-4 (сверка решений 001 с документацией).

**Не входит** (агент это не делает, даже если кажется логичным):
- агентный цикл, вызов gateway из агента и передача `LLM_GATEWAY_TOKEN` в песочницу — 022;
- ledger, ключи агентов, бюджеты и резерв, правило списания за оборванный поток, сверка с логами LiteLLM, панель денег — 004;
- БД LiteLLM, виртуальные ключи, бюджеты и callback LiteLLM — не используются (D-21);
- хранение событий в Postgres — 003, события пока живут в памяти `api`;
- баланс ИИ и отказ сверх остатка — 025;
- vault для ключей — после MVP;
- fallback и retry между моделями и провайдерами в gateway: если они нужны, их настраивают в `litellm.yaml`;
- эндпоинты, кроме `chat/completions` и `models`: `embeddings`, `responses`, `images`, `audio`;
- телеметрия самого LiteLLM в Collector;
- модель трейса долгих роёв (D-13) и асинхронный обработчик NATS (D-19) — 022.

## 3. Требования

| ID | Требование | Приоритет |
|---|---|---|
| REQ-002-1 | Сервис `llm-gateway` MUST принимать `POST /v1/chat/completions` в формате OpenAI. Тело уходит к LiteLLM без изменений, кроме `stream_options` (REQ-002-8). Ответ LiteLLM возвращается клиенту без изменений: `tools`, `tool_calls` и прочие поля проходят как есть. | MUST |
| REQ-002-2 | `GET /v1/models` MUST отдавать модели каталога текущего профиля в формате OpenAI `list`. | MUST |
| REQ-002-3 | Каждый запрос к `/v1/*` MUST нести `Authorization: Bearer <LLM_GATEWAY_TOKEN>`, иначе ответ `401`. Запрос к `chat/completions` MUST нести заголовки `x-swag-swarm-id` и `x-swag-agent-id`, иначе ответ `400`. | MUST |
| REQ-002-4 | Если модели нет в каталоге или тело запроса не проходит схему, gateway MUST ответить `400` и MUST NOT обращаться к LiteLLM. | MUST |
| REQ-002-5 | Ключи провайдеров и `LITELLM_MASTER_KEY` MUST быть только в окружении контейнеров `litellm` и `llm-gateway`. В `api`, `orchestrator`, `ui` и песочницах агентов их MUST NOT быть. LiteLLM MUST NOT быть доступен из сети compose `default`. | MUST |
| REQ-002-6 | Стоимость вызова `costMicroUsd` MUST считать gateway по формуле 4.3: из `usage` ответа и цен каталога. Поля стоимости из ответа LiteLLM MUST NOT использоваться для `costMicroUsd`. | MUST |
| REQ-002-7 | На каждый запрос, отправленный в LiteLLM, gateway MUST опубликовать ровно одно событие `llm.call` в `swarm.<swarmId>.events`, с `traceId` запроса. | MUST |
| REQ-002-8 | При `stream: true` gateway MUST: <br>• выставить `stream_options.include_usage = true`; <br>• пересылать клиенту каждый фрагмент SSE сразу, без накопления; <br>• взять `usage` из последнего фрагмента, где оно есть. <br>Поток без `[DONE]` получает статус `aborted`. | MUST |
| REQ-002-9 | Ошибки LiteLLM, сети и таймаута MUST переводиться в коды и статусы таблицы 4.6. Тело ошибки — в формате OpenAI. | MUST |
| REQ-002-10 | Если от LiteLLM нет ни одного байта дольше `LLM_GATEWAY_UPSTREAM_TIMEOUT_MS`, вызов MUST прерываться с `upstream_timeout`. | MUST |
| REQ-002-11 | Тексты ошибок в ответе, логах и событиях MUST NOT содержать значения `LITELLM_MASTER_KEY` и переменных окружения с суффиксом `_API_KEY`: каждое вхождение заменяется на `***`. | MUST |
| REQ-002-12 | Профиль выбирается переменной `LLM_PROFILE` (`test`, `dev`, `prod`) без правки кода. Наборы `id` моделей во всех профилях MUST совпадать. Каждый `id` каталога MUST быть `model_name` в `litellm.yaml` того же профиля. | MUST |
| REQ-002-13 | На старте gateway MUST сверить каталог со списком моделей LiteLLM. Если модели не хватает дольше `LLM_GATEWAY_STARTUP_TIMEOUT_MS`, процесс MUST завершиться с кодом 1. До успешной сверки порт не слушается. | MUST |
| REQ-002-14 | Gateway MUST писать логи по схеме `LogRecord` 016 с `service: "llm-gateway"` и продолжать трейс из `traceparent` запроса. На каждый вызов — одна запись `llm call`. Текст сообщений, промптов и ответов MUST NOT попадать в логи и спаны. | MUST |
| REQ-002-15 | `api` MUST принимать и хранить событие `llm.call` из шины. Лента роя в UI MUST показывать его строкой по формату 4.11. | MUST |
| REQ-002-16 | `npm run check` и CI MUST проходить без ключей реальных провайдеров: на профиле `test` и с фейковым провайдером. | MUST |
| REQ-002-18 | Тело запроса с полями верхнего уровня `api_key`, `api_base`, `base_url`, `api_version`, `organization`, `extra_headers`, `user_config` gateway MUST отклонять с `400 invalid_request` без обращения к LiteLLM: клиент не может подменить ключ или адрес провайдера. | MUST |
| REQ-002-19 | Если в `usage` ответа есть фактическая стоимость провайдера `usage.cost`, gateway MUST записать её в `providerCostMicroUsd` события по 4.3, иначе `null`. На `costMicroUsd` она MUST NOT влиять. | MUST |
| REQ-002-17 | Команда `npm run llm:ping` SHOULD отправлять один вызов через gateway и печатать ответ, `usage`, стоимость и задержку. | SHOULD |

## 4. Контракты

### 4.1. `packages/contracts/src/llm.ts` и изменения существующих схем

```ts
import { z } from 'zod';

// Имя модели платформы: одинаково во всех профилях (Q-4).
export const ModelId = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);
export type ModelId = z.infer<typeof ModelId>;

// Цена в USD за 1 млн токенов: десятичная строка, не больше 4 знаков после точки, не больше 10000.
export const PricePerMTok = z
  .string()
  .regex(/^\d{1,5}(\.\d{1,4})?$/)
  .refine((v) => Number(v) <= 10000);

export const ModelPrices = z.strictObject({
  inputPerMTokUsd: PricePerMTok, // некэшированные входные токены
  cachedInputPerMTokUsd: PricePerMTok, // входные токены из кэша провайдера
  outputPerMTokUsd: PricePerMTok,
});

export const CatalogModel = z.strictObject({ id: ModelId, prices: ModelPrices });

// infra/llm/<профиль>/models.json; id уникальны, порядок задаёт порядок в GET /v1/models.
export const ModelCatalog = z
  .strictObject({ models: z.array(CatalogModel).min(1) })
  .refine((c) => new Set(c.models.map((m) => m.id)).size === c.models.length, {
    message: 'duplicate model id',
  });
export type ModelCatalog = z.infer<typeof ModelCatalog>;

export const LlmUsage = z.strictObject({
  promptTokens: z.number().int().min(0), // все входные токены, включая кэшированные
  cachedPromptTokens: z.number().int().min(0), // ≤ promptTokens после нормализации (4.3)
  completionTokens: z.number().int().min(0),
});
export type LlmUsage = z.infer<typeof LlmUsage>;

export const GatewayErrorCode = z.enum([
  'unauthorized',
  'invalid_caller',
  'invalid_request',
  'model_not_found',
  'upstream_bad_request',
  'rate_limited',
  'upstream_error',
  'upstream_timeout',
]);
export type GatewayErrorCode = z.infer<typeof GatewayErrorCode>;

export const LlmCallStatus = z.enum(['ok', 'error', 'aborted']);

export const LlmCallData = z.strictObject({
  callId: z.uuid(),
  model: ModelId,
  stream: z.boolean(),
  status: LlmCallStatus,
  usage: LlmUsage.nullable(), // null — провайдер не прислал usage или поток оборван до него
  costMicroUsd: z.number().int().min(0).nullable(), // null тогда и только тогда, когда usage null
  // Фактическая стоимость у провайдера по ключу платформы (usage.cost), для счёта платформы (D-38).
  // null — провайдер или LiteLLM её не прислали. На costMicroUsd не влияет.
  providerCostMicroUsd: z.number().int().min(0).nullable(),
  latencyMs: z.number().int().min(0), // от приёма запроса до последнего байта ответа клиенту
  errorCode: GatewayErrorCode.optional(), // есть при status 'error' и при 'aborted' из-за ошибки после первого фрагмента
});
export type LlmCallData = z.infer<typeof LlmCallData>;

// Заголовки вызывающего (Q-3): до спеки 004 агент называет себя сам.
export const SWARM_ID_HEADER = 'x-swag-swarm-id';
export const AGENT_ID_HEADER = 'x-swag-agent-id';
export const LlmCaller = z.strictObject({ swarmId: SwarmId, agentId: AgentId });
export type LlmCaller = z.infer<typeof LlmCaller>;
```

Изменения существующих схем:
- `events.ts`:
  - в `Envelope.source` добавить `'llm-gateway'`;
  - в `PlatformEventInput` добавить вариант `z.strictObject({ ...Envelope, type: z.literal('llm.call'), data: LlmCallData })`.
- `log.ts`: в `ServiceName` добавить `'llm-gateway'`.
- `service-info.ts`: в `ServiceInfo.service` добавить `'llm-gateway'`.
- `index.ts`: `export * from './llm.ts'`.

### 4.2. HTTP API `llm-gateway`

Порт — `LLM_GATEWAY_PORT`. Тело запроса — не больше `LLM_GATEWAY_BODY_LIMIT_BYTES`, иначе `413` по умолчанию Fastify.

| Метод, путь | Вход | Успех | Ошибки |
|---|---|---|---|
| `GET /health` | — | `200 { status: 'ok', service: 'llm-gateway', version }`. Без токена: как у `api`. | — |
| `GET /v1/models` | `Authorization` | `200 { object: 'list', data: [{ id, object: 'model', owned_by: 'swag' }] }` в порядке каталога | `401 unauthorized` |
| `POST /v1/chat/completions` | `Authorization`, `x-swag-swarm-id`, `x-swag-agent-id`, тело `ChatRequest` | без потока: `200`, JSON ответа LiteLLM как есть; с потоком: `200`, `content-type: text/event-stream`, `cache-control: no-cache` | по таблице 4.6 |

Схема тела — в ядре. Поля сверх перечисленных пропускаются как есть:

```ts
export const ChatRequest = z.looseObject({
  model: z.string(), // проверка по каталогу отдельно → model_not_found
  messages: z.array(z.looseObject({ role: z.string() })).min(1),
  stream: z.boolean().optional(),
  stream_options: z.looseObject({}).optional(),
});

// REQ-002-18. Ключ и адрес провайдера задаёт только платформа; ключ организации (D-35) подставит сам gateway.
export const CLIENT_CREDENTIAL_FIELDS = [
  'api_key', 'api_base', 'base_url', 'api_version', 'organization', 'extra_headers', 'user_config',
] as const;
```

Сообщение при таком поле — `Client-side provider credentials are not allowed: <поле>`.

Проверки идут по порядку, первая не прошедшая даёт ответ:
1. токен → `401 unauthorized`;
2. заголовки вызывающего → `400 invalid_caller`;
3. схема `ChatRequest` и отсутствие полей `CLIENT_CREDENTIAL_FIELDS` → `400 invalid_request`;
4. модель в каталоге → `400 model_not_found`.

По этим отказам LiteLLM не вызывается и событие не публикуется.

Токен сравнивается через `crypto.timingSafeEqual`. Если длины не совпадают — сразу `401`.

**Тело ошибки** во всех случаях:

```json
{ "error": { "message": "<текст>", "type": "swag_gateway_error", "code": "<GatewayErrorCode>" } }
```

**SSE клиенту.**
- Каждый фрагмент LiteLLM пересылается как `data: <payload>\n\n` сразу после получения, включая финальный `data: [DONE]\n\n`.
- Поток рвётся после первого отправленного фрагмента, потому что упал LiteLLM или вышел таймаут. Тогда gateway пишет `data: {"error":{...}}\n\n` по форме выше и закрывает ответ без `[DONE]`.
- Ошибка до первого фрагмента — обычный JSON-ответ с кодом по 4.6.

### 4.3. Стоимость

Цена `p` — целое: цена из каталога × 10⁴. Например, `"3.00"` → 30000, `"0.0001"` → 1. Строка переводится в целое без `Number`-арифметики с дробями: целая часть × 10⁴ + дробная часть, дополненная нулями до 4 знаков.

Нормализация `usage`:

```
cached   = min(cachedPromptTokens, promptTokens)
uncached = promptTokens − cached
costMicroUsd = ceil((uncached·p_in + cached·p_cached + completionTokens·p_out) / 10⁴)
```

Вычисления — в `bigint`, результат переводится в `number`. Функция экспортируется из ядра: `costMicroUsd(usage: LlmUsage, prices: ModelPrices): number`.

Примеры, они же тесты AC-002-7:

| usage (prompt / cached / completion) | цены (in / cached / out) | costMicroUsd |
|---|---|---|
| 1000 / 200 / 500 | 3.00 / 0.30 / 15.00 | 9960 |
| 1 / 0 / 0 | 0.0001 / 0 / 0 | 1 |
| 1000 / 0 / 1000 | 0 / 0 / 0 | 0 |
| 100 / 150 / 0 | 1.00 / 0.50 / 0 | 50 (cached → 100, uncached → 0) |

**Разбор `usage` OpenAI → `LlmUsage`:**
- `prompt_tokens` → `promptTokens`;
- `completion_tokens` → `completionTokens`;
- `prompt_tokens_details.cached_tokens` → `cachedPromptTokens`, если поля нет — 0.

**Фактическая стоимость провайдера.** `parseProviderCost(rawUsage: unknown): number | null`:
- источник — `usage.cost` ответа: так OpenRouter отдаёт списанное с аккаунта платформы, в кредитах, 1 кредит = $1; поле приходит всегда, без параметров запроса;
- `cost` — конечное число ≥ 0 → `Math.round(cost × 10⁶)`; округление до ближайшего: это факт расхода, а не списание с клиента;
- поля нет, `usage` нет, `cost` не число, отрицательное или не конечное → `null`;
- `cost_details` и другие поля не используются;
- в потоке — из того же фрагмента, откуда взят `usage`.

`providerCostMicroUsd` не зависит от `costMicroUsd`: при `usage: null` он тоже `null`, при валидном `usage` без `cost` — `null`.

Если `usage` отсутствует или `prompt_tokens`/`completion_tokens` — не целые ≥ 0, считается, что `usage` нет: `usage: null`, `costMicroUsd: null`, лог `warn` `usage_missing` с `callId`.

### 4.4. Ядро `packages/llm-gateway-core`

```ts
export interface LlmUpstream {
  // Обычный вызов. Тело уже проверено ядром.
  complete(body: ChatRequest, signal: AbortSignal): Promise<UpstreamResponse>;
  // Поток: payload'ы событий SSE без префикса "data: ", включая '[DONE]'.
  // Обрыв, таймаут или abort после старта — исключение UpstreamStreamError из итератора.
  stream(body: ChatRequest, signal: AbortSignal): Promise<UpstreamStream>;
  listModels(signal: AbortSignal): Promise<UpstreamModels>;
}

export type UpstreamFailure =
  | { kind: 'http'; status: number; message: string } // message уже без секретов (4.5)
  | { kind: 'network' }
  | { kind: 'timeout' };

export type UpstreamResponse = { ok: true; body: unknown } | { ok: false; failure: UpstreamFailure };
export type UpstreamStream =
  | { ok: true; chunks: AsyncIterable<string> }
  | { ok: false; failure: UpstreamFailure };
export type UpstreamModels = { ok: true; ids: string[] } | { ok: false; failure: UpstreamFailure };

export class UpstreamStreamError extends Error {
  constructor(readonly failure: UpstreamFailure | { kind: 'aborted' }) { super(failure.kind); }
}

export interface EventPublisher { publishEvent(event: PlatformEventInput): Promise<void>; }
export interface Clock { now(): Date; monotonicMs(): number; }
export interface Ids { uuid(): string; }
export interface TraceContext { currentTraceId(): string | null; } // как в 016
export interface Logger { /* debug/info/warn/error(msg, fields?) — как в api-core */ }

export interface LlmGatewayDeps {
  catalog: ModelCatalog; // уже разобран оболочкой
  upstream: LlmUpstream;
  events: EventPublisher;
  clock: Clock; ids: Ids; trace: TraceContext; log: Logger;
  version: string;
}

export type CompleteResult =
  | { kind: 'json'; body: unknown }
  | { kind: 'stream'; chunks: AsyncIterable<string> } // payload'ы для записи клиенту
  | { kind: 'error'; status: number; error: { message: string; code: GatewayErrorCode } };

export interface LlmGatewayCore {
  info(): ServiceInfo;
  listModels(): { object: 'list'; data: { id: string; object: 'model'; owned_by: 'swag' }[] };
  // Сверка каталога: ok — все id каталога есть в upstream; иначе список недостающих.
  checkUpstream(signal: AbortSignal): Promise<{ ok: true } | { ok: false; missing: string[] } | { ok: false; failure: UpstreamFailure }>;
  // rawCaller — значения заголовков как пришли; signal — обрыв клиентом.
  complete(rawCaller: { swarmId?: string; agentId?: string }, rawBody: unknown, signal: AbortSignal): Promise<CompleteResult>;
}

export function createLlmGatewayCore(deps: LlmGatewayDeps): LlmGatewayCore;
export function costMicroUsd(usage: LlmUsage, prices: ModelPrices): number;
export function parseUsage(raw: unknown): LlmUsage | null; // 4.3
export function parseProviderCost(raw: unknown): number | null; // 4.3, аргумент — body.usage
```

**Обычный вызов в ядре, по шагам:**
1. Проверки 2–4 из 4.2.
2. `callId = ids.uuid()`, `t0 = clock.monotonicMs()`.
3. `upstream.complete(body, signal)`.
4. Успех:
   - `usage = parseUsage(body.usage)`, `providerCostMicroUsd = parseProviderCost(body.usage)`;
   - событие `status: 'ok'`;
   - результат `{ kind: 'json', body }`.
5. Неудача:
   - событие `status: 'error'` с `errorCode` по 4.6, `usage: null`, `providerCostMicroUsd: null`;
   - результат `{ kind: 'error' }`.
6. `latencyMs = round(clock.monotonicMs() − t0)`.
7. Запись лога `llm call` (4.10).

**Поток:**
1. Ядро копирует тело и выставляет `stream_options = { ...body.stream_options, include_usage: true }`.
2. Вызывает `upstream.stream`. Неудача до первого фрагмента — как шаг 5 обычного вызова.
3. Возвращает `{ kind: 'stream', chunks }`. Это обёртка-генератор над фрагментами LiteLLM. Каждый payload она:
   - отдаёт дальше без изменений;
   - если это не `[DONE]`, пробует `JSON.parse` и `parseUsage(obj.usage)` и запоминает последнее не-null `usage` вместе с `parseProviderCost(obj.usage)` того же фрагмента;
   - на `[DONE]` отмечает `done = true`.
4. В `finally` обёртки:
   - `status = done ? 'ok' : 'aborted'`;
   - `errorCode` — из `UpstreamStreamError.failure` по 4.6, если сбой не `aborted`;
   - публикуется событие, пишется лог.
5. Если `UpstreamStreamError` вылетает не из-за `aborted`, обёртка отдаёт последний payload `JSON.stringify({ error: { message, type: 'swag_gateway_error', code } })` и завершается без исключения.

Ошибка публикации события в лог `error` `event_publish_failed` с `callId`. Ответ клиенту она не меняет.

Событие:

```ts
{ id: ids.uuid(), swarmId, agentId, ts: clock.now().toISOString(), source: 'llm-gateway',
  traceId: trace.currentTraceId(), type: 'llm.call', data: LlmCallData }
```

`costMicroUsd` считается по ценам модели запроса, если `usage` не null.

### 4.5. Адаптер `packages/adapter-litellm`

```ts
export interface LiteLlmOptions {
  baseUrl: string; // LITELLM_URL
  masterKey: string; // LITELLM_MASTER_KEY → Authorization: Bearer
  idleTimeoutMs: number; // LLM_GATEWAY_UPSTREAM_TIMEOUT_MS
  secrets: string[]; // значения, которые заменяются на *** в message
  fetch?: typeof fetch; // для тестов; по умолчанию глобальный
}
export function createLiteLlmUpstream(options: LiteLlmOptions): LlmUpstream;
export function redact(text: string, secrets: string[]): string; // пустые строки в secrets игнорируются
```

- `complete` — `POST {baseUrl}/v1/chat/completions`, `content-type: application/json`, тело — `JSON.stringify(body)`.
- Текущий `traceparent` передаётся заголовком через propagator из `adapter-telemetry`, как в HTTP-клиенте оркестратора 016.
- Ответ `2xx` — `{ ok: true, body: await res.json() }`.
- Ответ не `2xx`:
  - `message` = `error.message` из JSON-тела, если есть, иначе `HTTP <status>`;
  - обрезается до 1000 символов, затем `redact`;
  - результат `{ ok: false, failure: { kind: 'http', status, message } }`.
- Сеть недоступна — `{ kind: 'network' }`.
- **Таймаут простоя.**
  - Свой `AbortController` объединяется с внешним `signal` через `AbortSignal.any`.
  - Таймер `idleTimeoutMs` перезапускается на каждом полученном куске тела.
  - Срабатывание таймера — `{ kind: 'timeout' }`.
  - Внешний `signal` прерван — для `stream` это `UpstreamStreamError({ kind: 'aborted' })`, для `complete` — `{ kind: 'network' }`. Ядро это значение не использует: клиент уже ушёл.
- **`stream`.**
  - Тот же запрос; при статусе не `2xx` — неудача, как у `complete`.
  - При `2xx` — `chunks`: асинхронный генератор по `res.body`.
  - Разбор SSE: события разделяются пустой строкой; строки `data:` склеиваются через `\n`, ведущий пробел после `data:` убирается; строки `:`-комментариев и других полей игнорируются.
  - Тело закончилось без `[DONE]` — генератор бросает `UpstreamStreamError({ kind: 'network' })`.
- **`listModels`** — `GET {baseUrl}/v1/models`, ответ `{ data: [{ id }] }`, результат — `ids`.
- **Спан** `litellm.chat`, вид `client`. Атрибуты:
  - `gen_ai.request.model`;
  - `swag.llm.stream`;
  - `http.response.status_code`;
  - после ответа — `gen_ai.usage.input_tokens` и `gen_ai.usage.output_tokens`, если `usage` есть.

  Тела запроса и ответа в атрибуты не попадают.

### 4.6. Ошибки

| Причина | HTTP клиенту | `code` | `message` |
|---|---|---|---|
| нет или неверный токен | 401 | `unauthorized` | `Invalid gateway token` |
| заголовки вызывающего не проходят `LlmCaller` | 400 | `invalid_caller` | `Missing or invalid x-swag-swarm-id / x-swag-agent-id` |
| тело не проходит `ChatRequest` | 400 | `invalid_request` | первые 3 ошибки Zod: `path: message`, через `; ` |
| модели нет в каталоге | 400 | `model_not_found` | `Unknown model: <model>` (имя обрезается до 100 символов) |
| LiteLLM `400` или `422` | 400 | `upstream_bad_request` | `message` из адаптера (уже без секретов) |
| LiteLLM `429` | 429 | `rate_limited` | `Provider rate limit` |
| LiteLLM другой не-`2xx`, сеть, поток оборван LiteLLM | 502 | `upstream_error` | `Upstream error` (статус LiteLLM — только в лог) |
| таймаут простоя | 504 | `upstream_timeout` | `Upstream timeout` |

### 4.7. Профили и файлы `infra/llm/`

```
infra/llm/
├── fake-provider/server.ts   # фейковый провайдер (4.12)
├── test/litellm.yaml         # модели → llm-fake
├── test/models.json
├── dev/litellm.yaml          # OpenRouter, бесплатные модели `:free` (Q-2)
├── dev/models.json
├── prod/litellm.yaml         # OpenRouter, платные модели (Q-2)
└── prod/models.json
```

**Модели платформы во всех профилях** (Q-4): `chat-small` и `chat-large`.

`test/models.json`:
- `chat-small` — цены `3.00` / `0.30` / `15.00`;
- `chat-large` — `0` / `0` / `0`.

Цены `dev` и `prod` берутся со страницы цен провайдера. Дата и ссылка — в README `apps/llm-gateway`.

`litellm.yaml` любого профиля:

```yaml
model_list:
  - model_name: chat-small            # = id каталога
    litellm_params:
      model: openai/fake-small        # в test; в dev и prod — openrouter/<модель> (Q-2)
      api_base: http://llm-fake:4010/v1   # только в test
      api_key: os.environ/FAKE_PROVIDER_API_KEY  # ключи — только ссылкой os.environ/…
general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY
```

В `litellm.yaml` нет:
- `database_url`;
- ключей литералом;
- callback'ов;
- `litellm_settings.success_callback`.

### 4.8. Compose, сети и файлы окружения

**Сети:**
- `default` — существующая;
- `llm` — новая, обычная bridge, не `internal`: LiteLLM нужен выход к провайдерам.

**Сервисы:**

| Сервис | Сети | Env | Порты | Прочее |
|---|---|---|---|---|
| `litellm` | `llm` | `env_file: .env.llm` | не публикуется | Образ `ghcr.io/berriai/litellm` — последний стабильный тег `main-v<версия>-stable`, опубликованный не позже чем за 2 недели до реализации; версия — в README `apps/llm-gateway` и журнале. Том `./infra/llm/${LLM_PROFILE}/litellm.yaml:/app/config.yaml:ro`, команда `--config /app/config.yaml --port 4000`. Healthcheck — `GET /health/liveliness` тем, что есть в образе. |
| `llm-fake` | `llm` | `FAKE_PROVIDER_PORT=4010` | не публикуется | Образ `node:24.22.1-alpine3.23`, том `./infra/llm/fake-provider:/app:ro`, команда `node /app/server.ts`. |
| `llm-gateway` | `default`, `llm` | `env_file: [.env, .env.llm]`, плюс `LLM_CATALOG_PATH=/etc/swag/models.json` | `127.0.0.1:${LLM_GATEWAY_PORT}:${LLM_GATEWAY_PORT}` | Dockerfile по образцу `apps/api`. Том `./infra/llm/${LLM_PROFILE}/models.json:/etc/swag/models.json:ro`. `depends_on`: `litellm` (healthy), `nats` (healthy), `otel-collector` (started). Healthcheck `/health`. |

`api`, `orchestrator` и `ui` по-прежнему получают только `.env`.

**Файлы окружения:**
- `.env.llm` не в git: в `.gitignore` уже есть `.env.*`;
- добавить исключение `!.env.llm.example`;
- `scripts/worktree-links.ts` делает hardlink и на `.env.llm`, как на `.env`.

`.env.llm.example`:

```
# Только LiteLLM и llm-gateway. Не коммитить .env.llm.
LITELLM_MASTER_KEY=sk-swag-local-not-secret
FAKE_PROVIDER_API_KEY=fake-provider-key-not-secret
# Ключ общего роутера платформы для профилей dev и prod (Q-2):
OPENROUTER_API_KEY=
```

### 4.9. Переменные окружения

В `.env.example` добавить:

```
# Спека 002. LLM Gateway; профиль моделей: test (фейковый провайдер), dev, prod.
LLM_PROFILE=test
LLM_GATEWAY_PORT=3002
LLM_GATEWAY_TOKEN=swag-local-gateway-token-not-secret-000
LITELLM_URL=http://litellm:4000
LLM_GATEWAY_UPSTREAM_TIMEOUT_MS=120000
LLM_GATEWAY_STARTUP_TIMEOUT_MS=60000
LLM_GATEWAY_BODY_LIMIT_BYTES=8388608
```

`packages/config` — `LlmGatewayConfig`. Без `BaseConfig`: gateway не нужна `DATABASE_URL`.

```ts
export const LlmGatewayConfig = z.object({
  NATS_URL: z.string().url(),
  OTEL_EXPORTER_OTLP_ENDPOINT: OptionalUrl,
  LOG_LEVEL: LogLevel.default('info'),
  TELEMETRY_FLUSH_TIMEOUT_MS: FlushTimeoutMs,
  LLM_GATEWAY_PORT: Port,
  LLM_GATEWAY_TOKEN: z.string().min(32),
  LLM_CATALOG_PATH: z.string().min(1),
  LITELLM_URL: z.string().url(),
  LITELLM_MASTER_KEY: z.string().startsWith('sk-').min(16),
  LLM_GATEWAY_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1).default(120000),
  LLM_GATEWAY_STARTUP_TIMEOUT_MS: z.coerce.number().int().min(1).default(60000),
  LLM_GATEWAY_BODY_LIMIT_BYTES: z.coerce.number().int().min(1024).default(8388608),
});
```

`secrets` для адаптера оболочка собирает так: `LITELLM_MASTER_KEY` плюс значения всех переменных `process.env`, имя которых оканчивается на `_API_KEY`.

`npm run infra:check` дополнительно проверяет `GET http://127.0.0.1:${LLM_GATEWAY_PORT}/health` → `200`, `service: 'llm-gateway'`.

### 4.10. Телеметрия и логи

- Оболочка подключает `adapter-telemetry` так же, как `apps/api`: `startTelemetry` с сервисом `llm-gateway`, хуки Fastify, логгер pino, `TraceContext`.
- Публикация события — через `adapter-nats`, спан публикации уже есть.
- Запись `llm call`, уровень `info` при `ok`, `warn` при `error` и `aborted`. Поля: `callId`, `swarmId`, `agentId`, `model`, `stream`, `status`, `latencyMs`, `promptTokens`, `cachedPromptTokens`, `completionTokens`, `costMicroUsd`, `providerCostMicroUsd`, `errorCode`, `upstreamStatus`.
- Отсутствующие значения — поле не пишется.
- Текстов сообщений и ответа модели нет ни в одном логе и спане (правило Q-4 спеки 016).

### 4.11. UI

В `packages/ui-core` — функция `formatLlmCall(data: LlmCallData): string`:

| Случай | Строка |
|---|---|
| `usage` есть, `status: 'ok'` | `chat-small · 1000 (кэш 200) → 500 ток. · $0.009960` |
| `usage` есть, `status: 'aborted'` | то же + ` · прерван` |
| `usage` null, `status: 'ok'` | `chat-small · без usage` |
| `usage` null, `status: 'aborted'` | `chat-small · прерван · без usage` |
| `status: 'error'` | `chat-small · ошибка upstream_timeout` |

Сумма — `costMicroUsd / 1e6`, ровно 6 знаков после точки.

`apps/ui/cabinet/src/app/swarm.page.ts`, метод `detail`: `case 'llm.call': return formatLlmCall(event.data);`.

### 4.12. Фейковый провайдер `infra/llm/fake-provider/server.ts`

- Один файл, только `node:http`, без зависимостей. Запускается `node server.ts`: Node 24 выполняет TypeScript со снятием типов.
- Экспортирует `startFakeProvider(opts: { port: number; models?: string[] }): Promise<{ url: string; close(): Promise<void>; requests: FakeRequest[] }>`.
- `FakeRequest = { path: string; headers: Record<string, string>; body: unknown; closedByClient: boolean }`.
- При запуске как скрипт слушает `FAKE_PROVIDER_PORT`.

Поведение. Сценарий выбирается по тексту последнего сообщения `messages`:

| Текст содержит | Ответ |
|---|---|
| — (по умолчанию) | Без потока — `chat.completion`: `content: 'fake reply'`, `usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, prompt_tokens_details: { cached_tokens: 200 }, cost: 0.0085 }`. `cost` отличается от тарифа платформы (9960 micro-USD) нарочно: тест видит, что одно не подменяет другое. Если в запросе есть `tools` — `message.tool_calls` с одним вызовом первого инструмента, аргументы `{}`, `finish_reason: 'tool_calls'`. <br>С потоком — фрагменты `'fake'` и `' reply'` с паузой `FAKE_CHUNK_DELAY_MS` (по умолчанию 0) между ними. Если `stream_options.include_usage` — затем фрагмент с `choices: []` и `usage` как выше. Затем `[DONE]`. |
| `__slow_chunks__` | поток, пауза между фрагментами 500 мс |
| `__no_usage__` | ответ без `usage` |
| `__no_cost__` | `usage` как по умолчанию, но без `cost` |
| `__cut__` | поток: первый фрагмент, затем `socket.destroy()` |
| `__hang__` | заголовки не отправляются, ответа нет, пока клиент не закроет соединение |
| `__fail_500__` | `500 { error: { message: 'boom' } }` |
| `__fail_429__` | `429 { error: { message: 'slow down' } }` |
| `__fail_400__` | `400 { error: { message: 'bad request, auth was: <значение заголовка Authorization>' } }` — для проверки скрытия секретов |

`GET /v1/models` → `{ object: 'list', data: [{ id }] }` по `opts.models`, по умолчанию `['chat-small', 'chat-large']`. В стеке этот ответ не используется: `GET /v1/models` LiteLLM отдаёт `model_name` из своего конфига. В тестах в процессе фейк стоит на месте LiteLLM.

Пакет LiteLLM снимает префикс `openai/` перед запросом к провайдеру — это стоит проверить при реализации T-27. В тестах без LiteLLM адаптер ходит в фейк напрямую. Модели фейк не проверяет.

### 4.13. Команда `npm run llm:ping`

`node --env-file-if-exists=.env scripts/llm-ping.ts [model] [--stream]`, модель по умолчанию — `chat-small`.

Запрос:
- `POST http://127.0.0.1:${LLM_GATEWAY_PORT}/v1/chat/completions`;
- заголовки: токен, `x-swag-swarm-id` — случайный UUID, `x-swag-agent-id: agent-1`;
- сообщение пользователя: `Ответь одним словом: пинг`.

Печатает текст ответа, `usage` и задержку. Стоимость не печатает: она в событии, а `api` отбросит событие неизвестного роя — это ожидаемо. Код выхода — 0 при `200`, иначе 1 и тело ошибки.

### 4.14. Пакеты и README

| Пакет | Что | Зависимости |
|---|---|---|
| `packages/llm-gateway-core` | ядро 4.4 | `@swag/contracts`, `zod` |
| `packages/adapter-litellm` | 4.5 | `@swag/llm-gateway-core` (типы порта), `@swag/adapter-telemetry` |
| `apps/llm-gateway` | оболочка: Fastify, конфиг, сборка адаптеров, чтение каталога, старт со сверкой | `fastify`, ядро, адаптеры `litellm`, `nats`, `telemetry`, `@swag/config` |

У каждого нового пакета — `README.md` по схеме из CLAUDE.md, правило 7. В `docs/architecture.md`:
- строка `llm-gateway-core` в таблице ядер;
- `LiteLLM` в списке адаптеров.

`arch:check` должен проходить без исключений для новых пакетов.

## 5. Критерии приёмки

Тесты ядра и адаптера — в процессе, с фейковым провайдером из 4.12 на случайном порту. Тесты оболочки поднимают Fastify-приложение в процессе: адаптер LiteLLM настроен прямо на фейк, шина — в памяти, как в `apps/api/test/e2e.test.ts`.

Критерии `[stack]` — тесты против поднятого `npm run up` на профиле `test`. По образцу `adapter-nats` они пропускаются без переменной `LLM_GATEWAY_URL`. Прогон со стеком приложить в журнал.

- **AC-002-1** — *Given* каталог `test` и запрос без потока с `model: 'chat-small'`, `messages`, `tools`, `tool_choice` и `temperature`. *When* `POST /v1/chat/completions` с верным токеном и заголовками вызывающего. *Then* `200`, тело совпадает с ответом фейка (`tool_calls` первого инструмента). Фейк получил тело, глубоко равное отправленному.
- **AC-002-2** — *Given* запрос без `Authorization`, с чужим токеном и с токеном другой длины. *When* `POST /v1/chat/completions` и `GET /v1/models`. *Then* `401`, `code: 'unauthorized'`. Фейк запросов не получил, событий нет.
- **AC-002-3** — *Given* верный токен и нет `x-swag-swarm-id`, или он не UUID, или `x-swag-agent-id: 'bob'`. *When* вызов. *Then* `400 invalid_caller`, фейк не вызван, событий нет.
- **AC-002-4** — *Given* `model: 'gpt-unknown'`. *When* вызов. *Then* `400 model_not_found`, фейк не вызван, событий нет.
- **AC-002-5** — *Given* тело без `messages`, `messages: []` и тело-массив. *When* вызов. *Then* `400 invalid_request`, фейк не вызван.
- **AC-002-6** — *Given* каталог `test`. *When* `GET /v1/models` с токеном. *Then* `{ object: 'list', data: [chat-small, chat-large] }` в этом порядке, `owned_by: 'swag'`.
- **AC-002-7** — *Given* строки таблицы 4.3. *When* `costMicroUsd`. *Then* результаты 9960, 1, 0, 50.
- **AC-002-8** — *Given* каталоги с ценой `"1.23456"`, `"-1"`, `"10000.0001"`, с повтором `id` и с `id` `Chat_Small`. *When* `ModelCatalog.safeParse`. *Then* ошибка. Каталоги `infra/llm/*/models.json` проходят.
- **AC-002-9** — *Given* успешный вызов без потока, начатый в трейсе с известным `traceId`. *When* ответ отдан. *Then* в `swarm.<swarmId>.events` опубликовано ровно одно событие, и оно проходит `PlatformEventInput`. Поля события:
  - `type: 'llm.call'`, `source: 'llm-gateway'`;
  - `agentId` из заголовка, `traceId` равен трейсу запроса;
  - `data.status: 'ok'`, `stream: false`;
  - `usage: { promptTokens: 1000, cachedPromptTokens: 200, completionTokens: 500 }`, `costMicroUsd: 9960`.
- **AC-002-10** — *Given* `stream: true` без `stream_options`. *When* вызов. *Then*:
  - клиент получил `content-type: text/event-stream`, фрагменты `fake`, ` reply`, фрагмент с `usage` и `[DONE]` в этом порядке;
  - фейк получил `stream_options: { include_usage: true }`;
  - событие: `status: 'ok'`, `stream: true`, `usage` из фрагмента, `costMicroUsd: 9960`.
- **AC-002-11** — *Given* сценарий `__slow_chunks__`. *When* вызов потоком. *Then* первый фрагмент дошёл до клиента раньше 300 мс от отправки запроса, весь поток — не раньше 500 мс.
- **AC-002-12** — *Given* сценарий `__cut__`. *When* вызов потоком. *Then*:
  - клиент получил первый фрагмент и фрагмент `{"error":{...,"code":"upstream_error"}}`, без `[DONE]`;
  - событие: `status: 'aborted'`, `errorCode: 'upstream_error'`, `usage: null`, `costMicroUsd: null`.
- **AC-002-13** — *Given* сценарий `__slow_chunks__`. *When* клиент рвёт соединение после первого фрагмента. *Then* в течение 1 с фейк видит закрытие (`closedByClient: true`). Событие: `status: 'aborted'`, без `errorCode`.
- **AC-002-14** — *Given* сценарий `__no_usage__` без потока. *When* вызов. *Then* `200`, событие `status: 'ok'`, `usage: null`, `costMicroUsd: null`, лог `warn` с `usage_missing` и `callId`.
- **AC-002-15** — *Given* сценарии `__fail_500__`, `__fail_429__`, `__fail_400__`. *When* вызов без потока и потоком. *Then* соответственно:
  - `502 upstream_error`;
  - `429 rate_limited`;
  - `400 upstream_bad_request`, `message` содержит `bad request`.

  Тело ошибки — по 4.2. Событие: `status: 'error'` с тем же `errorCode`.
- **AC-002-16** — *Given* `LLM_GATEWAY_UPSTREAM_TIMEOUT_MS=200` и сценарий `__hang__`. *When* вызов. *Then* через 200–1000 мс ответ `504 upstream_timeout`, событие `status: 'error'`, `errorCode: 'upstream_timeout'`.
- **AC-002-17** — *Given* в адаптере ключ фейка `fake-provider-key-not-secret`, `masterKey` и `secrets` по 4.9, сценарий `__fail_400__`. Ключ фейка приходит ему в `Authorization`. *When* вызов. *Then*:
  - `message` ответа содержит `***` и не содержит ни значения ключа фейка, ни мастер-ключа;
  - весь вывод логгера и атрибуты спанов этого вызова не содержат этих значений.

  Тест `redact`: пустой секрет в списке не меняет текст.
- **AC-002-18** — *Given* каталог с моделью, которой нет в `GET /v1/models` апстрима, и `LLM_GATEWAY_STARTUP_TIMEOUT_MS=500`. *When* старт оболочки. *Then*:
  - порт не слушается;
  - через 500–2000 мс процесс завершается с кодом 1;
  - в логе `error` `upstream_models_mismatch` с `missing: [<id>]`.

  Недостающая модель задаётся фейком с `models: ['chat-small']`. Если все модели есть — `/health` → `200 { status: 'ok', service: 'llm-gateway' }`.
- **AC-002-19** — *Given* файлы `infra/llm/{test,dev,prod}/`. *When* репозиторный тест. *Then*:
  - каждый `models.json` проходит `ModelCatalog`, наборы `id` трёх профилей равны;
  - каждый `id` есть как `model_name` в `litellm.yaml` своего профиля;
  - во всех `litellm.yaml` значения `api_key` и `master_key` начинаются с `os.environ/`;
  - ключа `database_url` нет.
- **AC-002-20** `[stack]` — *Given* `npm run up` с `LLM_PROFILE=test` и рой, созданный через `POST /swarms` в `api`. *When* через gateway вызов без потока и потоком с `x-swag-swarm-id` этого роя. *Then*:
  - оба `200` через настоящий LiteLLM;
  - `GET /swarms/:id/events` в `api` содержит два события `llm.call` со `status: 'ok'`, `usage` от фейка и `costMicroUsd: 9960`.
- **AC-002-21** `[stack]` — *Given* поднятый стек. *When* `docker inspect` контейнеров `api`, `orchestrator`, `ui` и exec `getent hosts litellm` в контейнере `api`. *Then* в env нет `LITELLM_MASTER_KEY` и переменных `*_API_KEY`, имя `litellm` не разрешается.
- **AC-002-22** — *Given* `orchestrator-core` запускает рой из 001. *When* фейковый `SandboxProvider` получает `SandboxSpec`. *Then* в `env` нет ключей, совпадающих с `/API_KEY|LITELLM/`.
- **AC-002-23** — *Given* вызов без потока и потоком с маркером `MARKER-7f3a` в тексте сообщения. *When* вызов завершён. *Then*:
  - есть ровно одна запись `llm call`, она проходит `LogRecord` с `service: 'llm-gateway'`, поля — по 4.10;
  - маркер не встречается ни в одном логе и ни в одном атрибуте спана.
- **AC-002-24** — *Given* пять случаев таблицы 4.11. *When* `formatLlmCall`. *Then* строки ровно как в таблице.
- **AC-002-25** `[manual]` — *Given* `LLM_PROFILE=dev`, ключ провайдера dev в `.env.llm`, `npm run up`. *When* `npm run llm:ping` и `npm run llm:ping -- --stream`. *Then* обе команды печатают ответ модели и `usage` с ненулевыми токенами, код выхода 0. Затем `npm run llm:ping -- chat-large`. Проверка: вывод команд и строка `llm call` из `docker compose logs llm-gateway` — в журнал.
- **AC-002-26** — *Given* рой есть в `api-core`. *When* из шины приходит `llm.call` от `llm-gateway`. *Then* событие сохранено с очередным `seq` и выдаётся подписчикам. Событие с `source: 'llm-gateway'` и неизвестным роем отбрасывается с `unknown_swarm`.
- **AC-002-28** — *Given* тело с `api_key: 'sk-x'`, отдельно с `api_base: 'http://evil.test'` и с `extra_headers`. *When* вызов. *Then* `400 invalid_request`, в `message` имя поля, фейк не вызван, событий нет.
- **AC-002-29** — *Given* ответ фейка по умолчанию с `usage.cost: 0.0085`, без потока и потоком. *When* вызов. *Then* событие: `providerCostMicroUsd: 8500`, `costMicroUsd: 9960`. Сценарий `__no_cost__` — `providerCostMicroUsd: null`, `costMicroUsd: 9960`. Тест `parseProviderCost`: `0.0085` → 8500, `0` → 0, `-1`, `'0.1'`, `NaN`, нет поля → `null`.
- **AC-002-27** — *Given* env без `LLM_GATEWAY_TOKEN`, с токеном из 31 символа, с `LITELLM_MASTER_KEY` без `sk-`. *When* `LlmGatewayConfig.safeParse`. *Then* ошибка. С `.env.example` + `.env.llm.example` разбор проходит.

## 6. Нефункциональные требования

| ID | Требование | Как измеряется |
|---|---|---|
| NFR-002-1 | Задержка gateway поверх апстрима, p95 ≤ 20 мс на вызовах без потока | Скрипт в тесте-замере: 200 вызовов через оболочку в процессе против фейка и 200 — к фейку напрямую, разница p95. Результат — в журнал, порог в CI не проверяется. |
| NFR-002-2 | Фрагменты потока не копятся: первый фрагмент у клиента через < 300 мс при паузе 500 мс у апстрима | AC-002-11 |

## 7. Безопасность: что не должно сломаться

- Фактическая стоимость провайдера `providerCostMicroUsd` не показывается в ленте кабинета: `formatLlmCall` её не использует → AC-002-24. Кто её видит, когда появятся организации, — D-38.
- Ключи провайдеров и мастер-ключ LiteLLM не попадают в `api`, оркестратор, UI и песочницы → AC-002-21, AC-002-22.
- LiteLLM недоступен из сети роя → AC-002-21.
- Секреты не утекают в ответы, логи и спаны через тексты ошибок провайдера → AC-002-17.
- Без токена gateway модель не вызывает → AC-002-2.
- Клиент не может подменить ключ или адрес провайдера и увести вызов на свой сервер → AC-002-28.
- Промпты и ответы моделей не попадают в логи и спаны → AC-002-23.
- В git нет `.env.llm` и литеральных ключей в `litellm.yaml` → AC-002-19, `.gitignore`.
- Порты: наружу публикуется только `llm-gateway` и только на `127.0.0.1`; `litellm` и `llm-fake` не публикуются → проверка в `scripts/repo.test.ts` по образцу существующих проверок compose, если такие есть, иначе ревью compose в журнале.
- Существующие сценарии 001 и 016 не ломаются → весь `npm run check`.

## 8. Задачи для агента

Выполняются по порядку. Одна задача — один субагент и один коммит. В каждой задаче указано, какие разделы спеки прочитать: субагенту достаточно их, раздела 3 и критериев из строки «Закрывает».

Для каждой задачи: README затронутых пакетов обновляется в том же коммите, новые имена — в глоссарии. Тест критерия называется с его id: `it('AC-002-n: ...')`. Если критерий проверяется на нескольких уровнях (ядро и оболочка), у каждого уровня свой тест с тем же id.

**Подготовка**

- [x] **T-1.** Node 24.20.0 → 24.22.1 (из N-7). Что меняется:
  - `.nvmrc`;
  - `engines.node` в корневом `package.json` → `>=24.22.1 <25`;
  - `FROM node:24.22.1-alpine3.23` в Dockerfile `apps/agent`, `apps/api`, `apps/orchestrator`, `apps/ui/cabinet`.

  Перед правкой проверить, что тег образа опубликован. Если не опубликован — `blocked`, Q в раздел 9. Затем `npm run check`, пересобрать образы.

  Готово, когда: нигде в репозитории нет `24.20.0`, `npm run check` зелёный.
- [x] **T-2.** В `vitest.config.ts` добавить `'.claude/**'` в `exclude` (из N-5). Готово, когда: `npm test` не находит тесты в `.claude/worktrees`.

**Контракты**

- [x] **T-3.** `packages/contracts/src/llm.ts` по 4.1: `ModelId`, `PricePerMTok`, `ModelPrices`, `CatalogModel`, `ModelCatalog`, `LlmUsage`, `GatewayErrorCode`, `LlmCallStatus`, `LlmCallData`, `LlmCaller`, `SWARM_ID_HEADER`, `AGENT_ID_HEADER`; экспорт из индекса пакета. Событие `llm.call` здесь ещё не добавляется. Читать: 4.1. Закрывает: AC-002-8 (часть схемы: пять неверных каталогов). Готово, когда: тест AC-002-8 в `contracts` зелёный, `npm run typecheck` зелёный.
- [x] **T-4.** Событие `llm.call` по 4.1: вариант в `PlatformEventInput`, `'llm-gateway'` в `source`, `ServiceName`, `ServiceInfo`. Если UI или ядра перестали компилироваться из-за нового варианта — минимальная правка: в `detail` — `default`. Тест в `api-core`: событие `llm.call` известного роя сохраняется с очередным `seq`, неизвестного — отбрасывается с `unknown_swarm`. Читать: 4.1. Закрывает: REQ-002-15 (часть `api`), AC-002-26. Готово, когда: `npm run typecheck`, тесты `contracts` и `api-core` зелёные.

**Ядро `packages/llm-gateway-core`: функции**

- [x] **T-5.** Каркас пакета по образцу `packages/api-core`: `package.json` (`@swag/llm-gateway-core`), `tsconfig`, индекс, README по схеме CLAUDE.md. Внутри — `costMicroUsd` и `parseUsage` по 4.3. Читать: 4.3, 4.14. Плюс `parseProviderCost` по 4.3. Закрывает: REQ-002-6, AC-002-7, AC-002-29 (тест `parseProviderCost`). Готово, когда: тесты AC-002-7, `parseProviderCost` и `parseUsage` (поле есть, поля нет, `cached_tokens` нет) зелёные, `arch:check` зелёный.
- [x] **T-6.** В ядре — схема `ChatRequest` и `CLIENT_CREDENTIAL_FIELDS` по 4.2, функция проверки тела: результат — разобранное тело или `message` по таблице 4.6 (первые 3 ошибки Zod `path: message` через `; `; для поля из `CLIENT_CREDENTIAL_FIELDS` — `Client-side provider credentials are not allowed: <поле>`). Читать: 4.2, 4.6. Закрывает: REQ-002-18 (схема). Готово, когда: юнит-тесты на тело без `messages`, `messages: []`, тело-массив, каждое поле из `CLIENT_CREDENTIAL_FIELDS` и тело с лишним полем `temperature` (проходит) зелёные.

**Фейковый провайдер**

- [x] **T-7.** `infra/llm/fake-provider/server.ts` по 4.12, часть без потока: `startFakeProvider`, `FakeRequest`, запуск как скрипт на `FAKE_PROVIDER_PORT`, `GET /v1/models`, ответ по умолчанию (с `tools` — `tool_calls`, `usage.cost`), `__no_usage__`, `__no_cost__`, `__fail_500__`, `__fail_429__`, `__fail_400__`. Здесь же каркас пакета `packages/adapter-litellm` (`package.json`, `tsconfig`, пустой индекс, README-заготовка): тесты фейка лежат в `packages/adapter-litellm/test/fake-provider.test.ts`. Читать: 4.12. Готово, когда: тест на каждый перечисленный сценарий через `fetch` зелёный, `node infra/llm/fake-provider/server.ts` стартует.
- [x] **T-8.** Фейк, потоковая часть: фрагменты `'fake'` и `' reply'` с паузой `FAKE_CHUNK_DELAY_MS`, фрагмент `usage` при `stream_options.include_usage`, `[DONE]`; `__slow_chunks__`, `__cut__`, `__hang__`; `closedByClient` при закрытии соединения клиентом. Читать: 4.12. Готово, когда: тест на каждый сценарий через `fetch` зелёный, включая `closedByClient: true` после `AbortController.abort()`.

**Адаптер `packages/adapter-litellm`**

- [x] **T-9.** `redact` и `complete` по 4.5 без таймаута: `POST {baseUrl}/v1/chat/completions` с `Authorization: Bearer <masterKey>`, `traceparent` через propagator `adapter-telemetry`, разбор `2xx`, не-`2xx` (`message` из `error.message` или `HTTP <status>`, обрезка до 1000 символов, затем `redact`), сеть недоступна → `network`. Тесты против фейка. Читать: 4.4 (порт `LlmUpstream`, `UpstreamFailure`), 4.5. Закрывает: REQ-002-11 (адаптер), AC-002-17 (часть `redact`: пустой секрет не меняет текст; `message` по `__fail_400__` без ключа фейка и мастер-ключа). Готово, когда: тесты на обычный ответ, три сценария `__fail_*__`, недоступный порт и `redact` зелёные.
- [x] **T-10.** Таймаут простоя для `complete` и `listModels` по 4.5: свой `AbortController` через `AbortSignal.any` с внешним `signal`, таймер `idleTimeoutMs` перезапускается на каждом куске тела, срабатывание → `timeout`, внешний abort → `network`. `listModels` — `GET {baseUrl}/v1/models` → `ids`. Читать: 4.5. Закрывает: REQ-002-10 (без потока). Готово, когда: тесты `__hang__` с `idleTimeoutMs: 200` (результат `timeout` за 200–1000 мс), внешний abort и `listModels` зелёные.
- [x] **T-11.** `stream` по 4.5: тот же запрос, не-`2xx` — неудача как у `complete`; при `2xx` — асинхронный генератор payload'ов SSE (склейка строк `data:`, удаление ведущего пробела, пропуск комментариев и других полей); тело без `[DONE]` → `UpstreamStreamError({ kind: 'network' })`; таймаут простоя → `UpstreamStreamError({ kind: 'timeout' })`; внешний abort → `UpstreamStreamError({ kind: 'aborted' })`. Читать: 4.4, 4.5. Закрывает: REQ-002-10 (поток). Готово, когда: тесты против фейка на поток по умолчанию, `__cut__`, `__slow_chunks__` с `idleTimeoutMs: 200`, внешний abort и юнит-тест разбора SSE (многострочный `data:`, комментарий `:`) зелёные.
- [x] **T-12.** Спан `litellm.chat` по 4.5: вид `client`, атрибуты `gen_ai.request.model`, `swag.llm.stream`, `http.response.status_code`, `gen_ai.usage.*` при наличии `usage`; тел запроса и ответа в атрибутах нет. README пакета — по факту кода. Читать: 4.5. Готово, когда: тест с in-memory экспортёром спанов (как в тестах `adapter-telemetry`) проверяет атрибуты и отсутствие текста сообщения.

**Ядро: `createLlmGatewayCore`**

- [x] **T-13.** Фабрика и порты по 4.4: интерфейсы `LlmUpstream`, `EventPublisher`, `Clock`, `Ids`, `TraceContext`, `Logger`, `LlmGatewayDeps`, `CompleteResult`, класс `UpstreamStreamError`. Методы `info`, `listModels`, `checkUpstream`; `complete` пока бросает `not implemented`. В `test/` ядра — фейковые порты в памяти (upstream со сценариями, публикатор, часы, логгер), их используют T-14…T-18. Читать: 4.4. Закрывает: REQ-002-2 (ядро), AC-002-6 и AC-002-18 на уровне ядра (`checkUpstream` → `missing: ['chat-large']`). Готово, когда: тесты `listModels`, `checkUpstream` (все есть, не хватает, ошибка апстрима) зелёные.
- [ ] **T-14.** `complete`, проверки 2–4 из 4.2: `LlmCaller` → `invalid_caller`, проверка тела из T-6 → `invalid_request`, модель в каталоге → `model_not_found` (имя обрезается до 100 символов). При отказе upstream не вызывается, событие не публикуется. Успешный путь пока не делается. Читать: 4.2, 4.4, 4.6. Закрывает: REQ-002-4, REQ-002-18, AC-002-3, -4, -5, -28 на уровне ядра. Готово, когда: эти тесты зелёные.
- [ ] **T-15.** `complete` без потока, успешный путь по шагам 2–7 из 4.4: `callId`, `latencyMs`, `parseUsage`, `costMicroUsd`, событие `llm.call` `status: 'ok'` с `traceId`, лог `llm call` по 4.10; без `usage` — `warn` `usage_missing` с `callId`; ошибка публикации — `error` `event_publish_failed`, ответ не меняется. Читать: 4.4, 4.10. `providerCostMicroUsd` в событии и логе. Закрывает: REQ-002-1, REQ-002-7, REQ-002-19, AC-002-1, -9, -14 и AC-002-29 без потока на уровне ядра. Готово, когда: эти тесты и тест на сбой публикации зелёные.
- [ ] **T-16.** `complete` без потока, ошибки апстрима по таблице 4.6: `http` 400/422 → `upstream_bad_request`, 429 → `rate_limited`, другой статус и `network` → `upstream_error`, `timeout` → `upstream_timeout`; событие `status: 'error'`, `usage: null`; `upstreamStatus` — только в лог. Читать: 4.4, 4.6, 4.10. Закрывает: REQ-002-9, AC-002-15 (без потока) и AC-002-16 на уровне ядра. Готово, когда: тест на каждую строку 4.6 про апстрим зелёный.
- [ ] **T-17.** Поток, успешный путь, шаги 1–4 из 4.4: копия тела с `stream_options.include_usage = true`, обёртка-генератор отдаёт payload'ы без изменений, запоминает последнее не-null `usage`, на `[DONE]` — `done`; в `finally` — событие `status: 'ok'`, `stream: true` и лог. Неудача до первого фрагмента — как в T-16. Читать: 4.4. `providerCostMicroUsd` — из фрагмента с `usage`. Закрывает: REQ-002-8, AC-002-10 и AC-002-29 потоком на уровне ядра. Готово, когда: тесты на поток по умолчанию (порядок payload'ов, `include_usage` у upstream, событие с `costMicroUsd: 9960`) и неудачу до первого фрагмента зелёные.
- [ ] **T-18.** Поток, обрывы, шаг 5 из 4.4: `UpstreamStreamError` не `aborted` → последний payload `{"error":{...}}` и завершение без исключения, событие `status: 'aborted'` с `errorCode`; `aborted` (клиент ушёл) → событие `status: 'aborted'` без `errorCode`. Читать: 4.4, 4.6. Закрывает: AC-002-12, -13 и потоковая часть AC-002-15 на уровне ядра. Готово, когда: эти тесты зелёные.

**Конфиг и оболочка `apps/llm-gateway`**

- [ ] **T-19.** Файлы окружения и конфиг: блок спеки 002 в `.env.example` по 4.9, `.env.llm.example` по 4.8, исключение `!.env.llm.example` в `.gitignore`, hardlink `.env.llm` в `scripts/worktree-links.ts`, `LlmGatewayConfig` в `packages/config`. Читать: 4.8 (файлы окружения), 4.9. Закрывает: AC-002-27. Готово, когда: тест AC-002-27 зелёный, `git check-ignore .env.llm` находит файл, а `.env.llm.example` — нет.
- [ ] **T-20.** Каркас оболочки: пакет `apps/llm-gateway` по образцу `apps/api`, чтение и разбор каталога из `LLM_CATALOG_PATH`, сборка `secrets` по 4.9, сборка адаптера LiteLLM и `adapter-nats`, вызов фабрики ядра, `GET /health`. Старт: `checkUpstream` с повтором раз в 1 с до `LLM_GATEWAY_STARTUP_TIMEOUT_MS`, до успеха порт не слушается, иначе лог `error` `upstream_models_mismatch` с `missing` и выход с кодом 1. README пакета. Читать: 4.2 (`/health`), 4.9, 4.14. Закрывает: REQ-002-13, AC-002-18. Готово, когда: тест AC-002-18 зелёный — оболочка против фейка с `models: ['chat-small']`; с полным списком `/health` → `200`.
- [ ] **T-21.** Оболочка: проверка токена через `crypto.timingSafeEqual` (разная длина — сразу `401`), разбор `x-swag-swarm-id` и `x-swag-agent-id`, `GET /v1/models`, `bodyLimit` из `LLM_GATEWAY_BODY_LIMIT_BYTES`, тело ошибки по 4.2. `POST /v1/chat/completions` передаёт в ядро заголовки и тело; запись ответа — только для `kind: 'error'`. Читать: 4.2, 4.6. Закрывает: REQ-002-3, AC-002-2, AC-002-6, а также AC-002-3, -4, -5, -28 через HTTP. Готово, когда: эти тесты в процессе против фейка зелёные, тело больше лимита → `413`.
- [ ] **T-22.** Оболочка: запись `kind: 'json'`, `AbortController` по событию `close` у `request.raw`, передача `signal` в ядро. Читать: 4.2. Закрывает: AC-002-1, -9, -14, -16 и AC-002-15 без потока через HTTP. Готово, когда: эти тесты в процессе зелёные, событие читается из шины в памяти.
- [ ] **T-23.** Оболочка: запись SSE — `content-type: text/event-stream`, `cache-control: no-cache`, каждый payload как `data: <payload>\n\n` сразу после получения, без буферизации Fastify (`reply.hijack()` или `reply.raw`). Читать: 4.2 (SSE клиенту). Закрывает: AC-002-10, -11, -12, -13 и потоковая часть AC-002-15 через HTTP, NFR-002-2. Готово, когда: эти тесты в процессе зелёные.
- [ ] **T-24.** Телеметрия оболочки по 4.10: `startTelemetry` с сервисом `llm-gateway`, хуки Fastify, логгер pino, `TraceContext` из `adapter-telemetry`, как в `apps/api`. Читать: 4.10. Закрывает: REQ-002-14, REQ-002-11 (оболочка), AC-002-17, AC-002-23. Готово, когда: тесты AC-002-17 и AC-002-23 в процессе, с перехватом вывода логгера и in-memory экспортёром спанов, зелёные.
- [ ] **T-25.** `apps/llm-gateway/Dockerfile` по образцу `apps/api`. Готово, когда: `docker build` проходит, контейнер стартует и без `LLM_GATEWAY_TOKEN` завершается с ошибкой конфига.

**Инфраструктура**

- [ ] **T-26.** Профили `infra/llm/{test,dev,prod}/` по 4.7 и ответам на Q-2 и Q-4: `litellm.yaml` и `models.json`. Модели и цены `dev` и `prod` — с каталога и страницы цен OpenRouter, с датой и ссылкой в README `apps/llm-gateway`. Репозиторный тест AC-002-19 и вторая часть AC-002-8 (каталоги `infra/llm/*/models.json` проходят). Читать: 4.7, Q-2, Q-4. Закрывает: REQ-002-12, AC-002-8, AC-002-19. Готово, когда: эти тесты зелёные.
- [ ] **T-27.** Compose по 4.8: сервисы `litellm`, `llm-fake`, `llm-gateway`, сеть `llm`; проверка `GET /health` gateway в `infra:check` (4.9); в `scripts/repo.test.ts` — порты из раздела 7. Проверить, что LiteLLM снимает префикс `openai/` (4.12) и передаёт клиенту `usage.cost` фейка без потока и потоком; если не передаёт — строка в журнал и `D-n` в `questions.md`, `providerCostMicroUsd` остаётся `null`, это не `blocked`. Записать версию образа LiteLLM в README `apps/llm-gateway` и журнал. Читать: 4.8, 4.9, 4.12, раздел 7. Закрывает: REQ-002-5 (compose), REQ-002-16. Готово, когда: `npm run up` на `test` поднимает всё healthy, `npm run infra:check` зелёный, вывод — в журнал.
- [ ] **T-28.** Тесты `[stack]` AC-002-20 и AC-002-21, пропуск без `LLM_GATEWAY_URL` по образцу `adapter-nats`. Закрывает: REQ-002-5. Готово, когда: оба теста зелёные против поднятого стека, прогон — в журнал.
- [ ] **T-29.** Тест AC-002-22 в `orchestrator-core`. Готово, когда: тест зелёный.

**UI, команды, сдача**

- [ ] **T-30.** UI: `formatLlmCall` в `ui-core` по 4.11 с тестом AC-002-24, `case 'llm.call'` в `swarm.page.ts`. Закрывает: REQ-002-15. Готово, когда: тест зелёный, в ленте роя из AC-002-20 видны строки вызовов. Скриншот — в журнал.
- [ ] **T-31.** `scripts/llm-ping.ts` и скрипт `llm:ping` по 4.13. Ручная проверка AC-002-25 на профиле `dev`; в журнал — также `providerCostMicroUsd` из строки `llm call` (на моделях `:free` ожидается 0). Закрывает: REQ-002-17, AC-002-25. Готово, когда: вывод в журнале. Если ключа dev нет — пометить AC-002-25 «ждёт ключа» в журнале и сообщить человеку, это не `blocked` для остальных задач.
- [ ] **T-32.** Замер NFR-002-1: скрипт-замер по разделу 6, 200 вызовов через оболочку в процессе и 200 напрямую к фейку, разница p95. Готово, когда: результат — в журнале.
- [ ] **T-33.** Сверить решения 001 с актуальной документацией через context7 (из N-4). Что проверить:
  - Angular: standalone, signals, `ng serve` с прокси WebSocket;
  - dockerode, `@nats-io/transport-node`, Fastify с WebSocket, Docker Compose;
  - заодно Fastify-оболочку `llm-gateway`.

  Устаревшее исправить, решения записать в README пакетов. Если context7 недоступен — сверить по официальной документации библиотек и указать источник в журнале. Готово, когда: в журнале список проверенного, найденного и исправленного.
- [ ] **T-34.** Документация и сдача:
  - корневой README: сервисы, `.env.llm`, профили, `llm:ping`;
  - `docs/architecture.md` по 4.14;
  - `npm run check`, сверка README всех затронутых пакетов с кодом.

  Готово, когда: всё зелёное, статус `review`.

## 9. Открытые вопросы

Пока список не пуст, спека не может быть `ready`.

- [x] **Q-1. Где лежат ключи провайдеров, где цены, что с оборванным потоком** (из D-21). *(Claude, 2026-10-27)*
  **Решение человека (2026-10-27):**
  - ключи платформы — в окружении `litellm` из `.env.llm`, LiteLLM — в отдельной сети `llm` (вариант «а»);
  - цены — `models.json` профиля в формате 4.1;
  - оборванный поток — событие `aborted` с `usage: null`, без списания; правило списания — в 004.

  Уточнение человека: у платформы два режима доступа к моделям. Общий доступ по ключам платформы оплачивается по мере пользования. Свой ключ организации платформа хранит у себя и плату за вызовы на нём не берёт (D-35). Модель оплаты — подписка (D-36). В 002 — только общий доступ. Чтобы свой ключ потом добавился без переделки, gateway не пропускает ключ и адрес провайдера из тела запроса (REQ-002-18): ключ организации будет подставлять сам gateway в тело запроса к LiteLLM.
- [x] **Q-2. Провайдеры профилей `dev` и `prod`.** *(Claude, 2026-10-27)*
  **Решение человека (2026-10-27): OpenRouter в обоих профилях** — общий роутер платформы, один ключ `OPENROUTER_API_KEY` в `.env.llm`, модели разных провайдеров через него.
  - `dev` — бесплатные модели OpenRouter `:free` с поддержкой `tools` и потока, цены в `models.json` — `0`. Суточные лимиты бесплатных моделей допустимы для разработки.
  - `prod` — платные модели OpenRouter: `chat-small` — модель класса Haiku, `chat-large` — класса Sonnet. Цены в `models.json` — цены OpenRouter.
  - Конкретные модели, их поддержку `tools`, потока и `usage` в потоке агент проверяет по документации и каталогу OpenRouter при T-26 и записывает с датой в README `apps/llm-gateway`. Если для `chat-small` или `chat-large` в `dev` нет бесплатной модели с `tools` — `blocked`, вопрос человеку.
- [x] **Q-3. Кто вызывает gateway до спеки 004.** *(Claude, 2026-10-27)*
  **Решение человека (2026-10-27): вариант «а».** Общий внутренний токен `LLM_GATEWAY_TOKEN` (Bearer), рой и агента вызывающий называет заголовками `x-swag-swarm-id` и `x-swag-agent-id`. В 004 токен заменится ключом агента.
- [x] **Q-4. Имена моделей платформы.** *(Claude, 2026-10-27)*
  **Решение человека (2026-10-27): `chat-small` и `chat-large`**, одинаковые во всех профилях.

## 10. Журнал реализации

Заполняет агент.

| Дата | Ветка / коммит | Что сделано | Отклонения от спеки |
|---|---|---|---|
| 2026-10-27 | `spec/002-t5-llm-gateway-core-cost` / `1dbfc2e` | T-5: каркас `llm-gateway-core`, `costMicroUsd` / `parseUsage` / `parseProviderCost`. Новые имена в глоссарии: `costMicroUsd`, `parseUsage`, `@swag/llm-gateway-core`. | `export type ModelPrices` добавлен в `packages/contracts/src/llm.ts`: в блоке 4.1 его нет, нужен как тип параметра `costMicroUsd` из 4.3. |
| 2026-10-27 | `spec/002-t6-chat-request-schema` / `aabbc8f` | T-6: схема `ChatRequest`, `CLIENT_CREDENTIAL_FIELDS`, функция `parseChatRequest` (результат `{ ok, value }` / `{ ok: false, message }`) в `llm-gateway-core`. Новые имена в глоссарии: `ChatRequest`, `CLIENT_CREDENTIAL_FIELDS`, `parseChatRequest`. | Трактовки D-42, D-43 (порядок проверок, формат пути). Имя `parseChatRequest` и форма результата в 4.2 и 4.4 не заданы: выбраны по стилю пакета. |
| 2026-10-27 | `spec/002-t7-fake-provider, 37eab88` | T-7: `infra/llm/fake-provider/server.ts` (`startFakeProvider`, `FakeRequest`, запуск как скрипт на `FAKE_PROVIDER_PORT`, `GET /v1/models`, сценарии без потока), каркас `packages/adapter-litellm` (`package.json`, `tsconfig`, индекс, README), тесты фейка в `packages/adapter-litellm/test/fake-provider.test.ts`. Поле `requests` пишет только `POST /v1/chat/completions`: `GET /v1/models` и неизвестные пути (404) в него не попадают. Ручная проверка запуска: `FAKE_PROVIDER_PORT=47391 node infra/llm/fake-provider/server.ts &` → лог `llm-fake слушает порт 47391 (http://127.0.0.1:47391)`; `curl http://127.0.0.1:47391/v1/models` → `{"object":"list","data":[{"id":"chat-small"},{"id":"chat-large"}]}`; процесс остановлен по своему PID. Новые имена в глоссарии: `FakeRequest`, маркеры фейка, `@swag/adapter-litellm`. | 1) Зависимости `adapter-litellm` по 4.14 не добавлены (YAGNI: тестам нужен только `fetch` и фейк); добавятся с кодом адаптера. 2) `stream: true` в фейке отвечает `501` до T-8, маркеры потоковой части (`__slow_chunks__`, `__cut__`, `__hang__`) не реализованы; `closedByClient` всегда `false`. 3) Сетевой интерфейс: тесты — `127.0.0.1`, запуск скриптом — `0.0.0.0` (см. D-44). 4) `infra/llm/fake-provider` добавлен в `tsconfig.dev.json` (typecheck), как `scripts/`. 5) В ответе с `tools` `content: null` по OpenAI-формату, в 4.12 не задано (см. D-45). |
| 2026-10-27 | `spec/002-t8-fake-provider-stream` | T-8: потоковая часть фейка в `infra/llm/fake-provider/server.ts`: кадры `chat.completion.chunk` (`fake`, ` reply`), usage-кадр при `stream_options.include_usage`, `[DONE]`, `FAKE_CHUNK_DELAY_MS`, маркеры `__slow_chunks__`, `__cut__`, `__hang__`, `closedByClient`; ответ 501 убран. Тесты потока в `packages/adapter-litellm/test/fake-provider.test.ts` (без AC-id). Новые маркеры в глоссарии. | 1) Формат кадров SSE в 4.12 не задан, принят формат OpenAI с трактовками (роль в первом фрагменте, `finish_reason` в ' reply', пауза между всеми кадрами, `tools` в потоке не учитываются, заголовки SSE) — см. D-46. 2) `FAKE_CHUNK_DELAY_MS` читается из env на каждом запросе, опции `startFakeProvider` не менялись. 3) Кадр ошибки `upstream_error` для `__cut__` фейк не шлёт, его формирует шлюз (AC-002-12). 4) Трактовки маркеров потока (`__slow_chunks__` — 500 мс, порядок проверки маркеров, поток только при `stream: true`) — см. D-46. |
| 2026-10-27 | `spec/002-t9-litellm-complete`, коммит `8b43993` | T-9: `createLiteLlmUpstream` с методом `complete` (`Authorization: Bearer`, `traceparent` через глобальный пропагатор, разбор `2xx`, не-`2xx` с обрезкой и `redact`, `network`), `redact`. В `llm-gateway-core`: типы `UpstreamFailure`, `UpstreamResponse`, `LlmUpstream`, `UpstreamSignal`. Тесты в `packages/adapter-litellm/test/complete.test.ts` (AC-002-17). Новые имена в глоссарии: `UpstreamFailure`, `UpstreamResponse`, `UpstreamSignal`, `createLiteLlmUpstream`, `LiteLlmOptions`, `redact`. | 1) `LlmUpstream` объявлен только с `complete`: `stream` и `listModels` добавят T-11 и T-13 (4.4 задаёт полный интерфейс). 2) Тип сигнала в порте — `UpstreamSignal` вместо `AbortSignal`, ядро без DOM (D-47). 3) `@opentelemetry/api` — зависимость адаптера, `@swag/adapter-telemetry` — devDependency, как у `adapter-nats`; 4.14 называет его зависимостью. 4) Тело `2xx`, которое не читается как JSON, — `network` (4.5 не описывает; D-49). 5) Порядок «обрезка, затем redact» взят из 4.5 буквально; риск на границе 1000 символов — D-48. 6) В тесте AC-002-17 `masterKey` = `LITELLM_MASTER_KEY` из 4.9, `secrets` = оба значения: `LITELLM_MASTER_KEY` и `FAKE_PROVIDER_API_KEY`: фейк отражает заголовок `Authorization`, поэтому в `message` попадает мастер-ключ. |
| 2026-10-27 | `spec/002-t10-litellm-idle-timeout`, коммит `a812d2e` | T-10: таймаут простоя в `adapter-litellm` (`idleGuard`: `AbortSignal.any` с внешним signal, таймер взводится до запроса и перезапускается на каждом куске тела, любой статус); срабатывание — `timeout`, внешний abort — `network`; метод `listModels` (`GET /v1/models` → `ids`), тип `UpstreamModels` и метод `listModels` в порте `LlmUpstream`. Тесты: `test/idle-timeout.test.ts` (`__hang__` при 200 мс, таймер на кусках, abort), `test/list-models.test.ts`; без AC-id, AC-002-16 описывает 504 шлюза. Новые имена в глоссарии: `UpstreamModels`. | 1) Тесты без AC-id: AC-002-16 про ответ шлюза `504`, его закрывают T-16 и T-20. 2) Таймер покрывает и чтение тела не-2xx ответа, при срабатывании — `timeout`, а не `http` (D-51). Обрыв соединения при чтении тела не-2xx без срабатывания таймера — `network`, не `http` (D-51). 3) `listModels` с телом не по форме `{ data: [{ id }] }` или не JSON — `network` (D-50). 4) Тело ответа читается потоком (`getReader`) вместо `res.json()`, чтобы таймер перезапускался на каждом куске; разбор JSON и `message` ошибки — как раньше. 5) `listModels` в порте принимает `UpstreamSignal` (D-47). |
| 2026-10-27 | `spec/002-t11-litellm-stream`, коммит `6a4d6b4` | T-11: `stream` в порте `LlmUpstream`, типы `UpstreamStream` и класс `UpstreamStreamError` в `llm-gateway-core`; `stream` в `adapter-litellm`: общий путь запроса (`open`, `readWhole`) для `complete`, `stream` и `listModels`, разбор SSE `sseData` (строки `data:` через `\n`, один ведущий пробел, комментарии и другие поля пропускаются), генератор `payloads` до `[DONE]` включительно, отмена чтения и снятие таймера при раннем выходе. Тесты: `packages/adapter-litellm/test/stream.test.ts` (фейк по умолчанию, `include_usage`, `__cut__`, `__slow_chunks__` при 200 мс, внешний abort, ранний выход, не-2xx, тело без `[DONE]`, `sseData`). Без AC-id: AC-002-10…13 описывают ответ шлюза (T-17…T-23). Новые имена в глоссарии: `UpstreamStream`, `UpstreamStreamError`. | 1) Класс `UpstreamStreamError` объявлен с явным полем `failure` вместо параметра-свойства: Node запускает `.ts` без трансформации (strip-only), сигнатура та же. 2) `sseData` понимает разделители `\n` и `\r\n`, одиночный `\r` не поддержан; незавершённое событие на конце тела отбрасывается (D-52). 3) Адаптер отправляет тело как получено от ядра, `stream: true` не добавляет. 4) Тесты потока без AC-id, см. выше. 5) Таймер простоя в потоке идёт только пока ждём кусок от апстрима: пауза потребителя между payload'ами в простой не входит (замечание ревью T-11). 6) Отказ до потока при уже прерванном `signal` — `network`, не `aborted` (D-53). |
| 2026-10-27 | `spec/002-t12-litellm-span`, коммит `1d5ac76` | T-12: спан `litellm.chat` (вид `client`) у `complete` и `stream` в `adapter-litellm`: `gen_ai.request.model`, `swag.llm.stream`, `http.response.status_code` (при заголовках ответа), `gen_ai.usage.input_tokens` и `gen_ai.usage.output_tokens` (при `usage`; у потока — из фрагмента с `usage`), статус `ERROR` при отказе, спан заканчивается с генератором потока. Тесты: `packages/adapter-litellm/test/span.test.ts` (in-memory экспортёр, атрибуты, без текста сообщений), `test/complete.test.ts` (`traceparent` теперь от спана `litellm.chat`). Без AC-id: спан не закрывает AC. Новые имена в глоссарии: спан `litellm.chat`. | 1) `traceparent` в заголовке несёт контекст спана `litellm.chat` (он активен при инжекте), а не внешнего спана; тест T-9 поправлен по смыслу (D-54). 2) `listModels` спана не создаёт: 4.5 задаёт спан только для чата. 3) Статус `ERROR` при любом отказе, в т.ч. `http` с любым статусом; `usage` потока разбирается в адаптере тем же `parseUsage` (D-54). |
| 2026-10-27 | `spec/002-t13-core-interfaces`, коммит этой задачи | T-13: фабрика `createLlmGatewayCore(deps)` в `llm-gateway-core` с методами `info`, `listModels` (из каталога), `checkUpstream` (сверка `ids` апстрима с каталогом); `complete` — заглушка `not implemented`. Порты `EventPublisher`, `Clock`, `Ids`, `TraceContext`, `Logger`, `LogContext`, тип `LlmGatewayDeps`, `CompleteResult`, `CheckUpstreamResult`, `ModelList`. `UpstreamStreamError` и `UpstreamSignal` уже объявлены в T-11 и T-9, здесь не дублируются. Фейковые порты в `packages/llm-gateway-core/test/fakes.ts`. Тесты: `packages/llm-gateway-core/test/gateway-core.test.ts` (AC-002-6, AC-002-18). Новые имена в глоссарии: `createLlmGatewayCore`, `LlmGatewayDeps`, `LlmGatewayCore`, `CompleteResult`, `CheckUpstreamResult`, `ModelList`, `EventPublisher`, `Ids`, `Clock`, `TraceContext`, `Logger`, `LogContext`. | 1) Порт id назван `Ids` по 4.4, в других ядрах и глоссарии — `IdGenerator`; `Clock.now()` возвращает `Date`, а не ISO-строку (D-55). 2) `complete` — `async`, поэтому отказ заглушки приходит отклонённым промисом, а не синхронным исключением (трактовка). |
