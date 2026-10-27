# @swag/llm-gateway-core

Ядро LLM Gateway (спека 002): расчёт стоимости вызова модели и разбор `usage` ответа провайдера. Чистый TypeScript, не знает про HTTP, Fastify, LiteLLM и env.

## Задачи

- Проверить тело `POST /v1/chat/completions` по схеме `ChatRequest` и запретить поля ключа и адреса провайдера (REQ-002-18): `parseChatRequest` возвращает разобранное тело или текст `message` для `invalid_request`.
- Посчитать стоимость вызова `costMicroUsd` по `usage` и ценам модели из каталога (REQ-002-6): поля стоимости из ответа LiteLLM не используются.
- Разобрать `usage` ответа OpenAI-формата в `LlmUsage`; без `prompt_tokens` или `completion_tokens` — `null`.
- Разобрать фактическую стоимость провайдера `usage.cost` в micro-USD для `providerCostMicroUsd` (REQ-002-19). На `costMicroUsd` она не влияет.

- Отдать `GET /v1/models` из каталога и сверить каталог с моделями апстрима при старте (`checkUpstream`, REQ-002-2, AC-002-6, AC-002-18): `createLlmGatewayCore(deps)` даёт `info`, `listModels`, `checkUpstream`.

- Проверить вызов `complete` до апстрима (REQ-002-4, REQ-002-18, AC-002-3, -4, -5, -28): вызывающий `LlmCaller` → `invalid_caller`, тело `ChatRequest` → `invalid_request`, модель каталога → `model_not_found`. Отказ — `{ kind: 'error' }`, апстрим не вызывается, событие не публикуется.

`complete` для запросов, которые прошли проверки, пока заглушка (`not implemented`): успешный путь — T-15…T-18.

## Что внутри сейчас

- `costMicroUsd(usage, prices)` — формула 4.3 в `bigint`: цены из строк × 10⁴, `cached = min(cachedPromptTokens, promptTokens)`, округление вверх.
- `parseUsage(raw)` — `prompt_tokens` → `promptTokens`, `completion_tokens` → `completionTokens`, `prompt_tokens_details.cached_tokens` → `cachedPromptTokens` (нет поля — 0). Возвращает `null`, если нет `prompt_tokens` или `completion_tokens` или они не целые ≥ 0.
- `parseProviderCost(rawUsage)` — `usage.cost` как конечное число ≥ 0 → `Math.round(cost × 10⁶)`; иначе `null`.
- `ChatRequest` (zod `looseObject`: `model`, `messages` с минимум одним элементом, `stream`, `stream_options`; остальные поля проходят) и `CLIENT_CREDENTIAL_FIELDS` (7 полей из 4.2).
- Тип порта апстрима `LlmUpstream` (`complete`, `stream`, `listModels`), `UpstreamFailure`, `UpstreamResponse`, `UpstreamStream`, `UpstreamModels`, класс `UpstreamStreamError` (4.4). `UpstreamStreamError` — поле `failure` явно, без параметра-свойства: Node запускает `.ts` без трансформации. `signal` — структурный тип `UpstreamSignal`: `AbortSignal` без DOM не объявляется (D-47).
- `parseChatRequest(raw)` — сначала поля `CLIENT_CREDENTIAL_FIELDS` (`Client-side provider credentials are not allowed: <поле>`), потом схема; первые 3 ошибки Zod как `path: message` через `; ` (сегменты пути через `.`, при пустом пути — только текст; D-43).
- `createLlmGatewayCore(deps: LlmGatewayDeps)` — фабрика ядра (4.4). `deps`: `catalog` (уже разобран оболочкой), `upstream: LlmUpstream`, `events: EventPublisher`, `clock: Clock`, `ids: Ids`, `trace: TraceContext`, `log: Logger`, `version`.
- `listModels()` — `{ object: 'list', data }` по порядку каталога, `owned_by: 'swag'`; апстрим не вызывается.
- `checkUpstream(signal)` — `listModels` апстрима; все `id` каталога есть → `{ ok: true }`; нет части → `{ ok: false, missing }` в порядке каталога; ошибка апстрима → `{ ok: false, failure }`.
- Порты `EventPublisher`, `Clock` (`now(): Date`, `monotonicMs()`), `Ids`, `TraceContext`, `Logger` и `LogContext`, типы `CompleteResult`, `CheckUpstreamResult`, `ModelList`.
- `complete(rawCaller, rawBody)` — проверки 2–4 из 4.2 по порядку: `LlmCaller.safeParse` на `swarmId`/`agentId` (`invalid_caller`), `parseChatRequest` (`invalid_request`), поиск `model` в каталоге (`model_not_found`, `Unknown model: <имя>`, имя обрезается до 100 символов). Ответ — `CompleteResult` `kind: 'error'` с `status: 400` и `error` по 4.6.
- Тесты: `test/complete-checks.test.ts` — AC-002-3, -4, -5, -28 на уровне ядра (`complete` до апстрима); `test/llm-gateway-core.test.ts` — AC-002-7, AC-002-29 (часть про `parseProviderCost`), разбор `parseUsage` в трёх случаях, блок «схема тела ChatRequest» (REQ-002-18); `test/gateway-core.test.ts` — AC-002-6 (`listModels`), AC-002-18 (`checkUpstream` на уровне ядра), `info`.
- `test/fakes.ts` — фейковые порты в памяти: `fakeUpstream` (сценарии `models`, `complete`, `stream`, запись вызовов), `chunksThen` (поток из payload'ов и последующий `UpstreamStreamError`), `fakeEvents` (массив `published`), `fakeClock` (`advance(ms)`), `fakeIds`, `fakeTrace`, `fakeLog` (массив `entries`), `fakeDeps` (собирает `LlmGatewayDeps`). Каталог `testCatalog`: `chat-small`, `chat-large`.

## Ограничения

Правила ядра ([архитектура](../../docs/architecture.md), [спека 000, 4.2](../../docs/spec/000-foundation.md#42-правила-ядра-и-оболочки)):

- Зависимости — `@swag/contracts` и `zod`. `zod` по 4.14 нужен для схемы `ChatRequest`.
- Нет Node API, `process`, env, файлов, сети: `tsconfig` без `@types/node` и DOM.

Нарушения ловят `npm run arch:check` и `npm run typecheck`.

## Связи

- Оболочка: `apps/llm-gateway` (спека 002, T-20).
- Адаптер: `@swag/adapter-litellm` (реализует `LlmUpstream` из этого пакета, спека 002, 4.5).
- Использует: `@swag/contracts` (`LlmUsage`, `ModelPrices`).

## Ключевые решения

- Цены в `costMicroUsd` — строки `ModelPrices` и `bigint`-арифметика без `Number` с дробями (4.3): `"0.0001"` дает ровно 1 micro-USD за миллион токенов.
- Проверка тела — функция с результатом `{ ok, value }` / `{ ok: false, message }`, а не исключение: оболочка переводит `message` в `400 invalid_request` (4.2, 4.4). Имя и форма результата в спеке не заданы, выбраны здесь и записаны в глоссарий.
- Поля ключа и адреса проверяются до схемы: сообщение «Client-side provider credentials…» точнее, чем ошибка Zod про обязательное `messages`. Порядок внутри шага 3 из 4.2 спека не задаёт; решение — D-42 в `docs/spec/questions.md`.
- `parseProviderCost` округляет до ближайшего, а `costMicroUsd` — вверх: `providerCostMicroUsd` — факт расхода платформы, `costMicroUsd` — списание с клиента по тарифу (4.3).
- Порты с именами и полями из 4.4, а не из других ядер: `Ids` вместо `IdGenerator`, `Clock.now()` возвращает `Date` (D-55). Лог и трейс — той же формы, что в `api-core`.
- `complete` — `async`, для запроса после проверок бросает `not implemented` отклонённым промисом до T-15.
- Порядок проверок — как в 4.2: сначала вызывающий, потом тело, потом модель. Отказ возвращается значением (`kind: 'error'`), а не исключением: оболочка переводит его в HTTP-ответ по 4.6.
- Имя модели в `model_not_found` обрезается по символам Unicode (`Array.from`), а не по UTF-16 единицам, чтобы не разрезать эмодзи (D-56); трактовка «100 символов» записана в журнале спеки.

## Спеки

- 002 — 4.3 ([стоимость](../../docs/spec/002-llm-gateway.md#43-стоимость)), 4.4 ([ядро](../../docs/spec/002-llm-gateway.md#44-ядро-packagesllm-gateway-core)), 4.14 (пакеты).
