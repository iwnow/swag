# @swag/llm-gateway-core

Ядро LLM Gateway (спека 002): расчёт стоимости вызова модели и разбор `usage` ответа провайдера. Чистый TypeScript, не знает про HTTP, Fastify, LiteLLM и env.

## Задачи

- Проверить тело `POST /v1/chat/completions` по схеме `ChatRequest` и запретить поля ключа и адреса провайдера (REQ-002-18): `parseChatRequest` возвращает разобранное тело или текст `message` для `invalid_request`.
- Посчитать стоимость вызова `costMicroUsd` по `usage` и ценам модели из каталога (REQ-002-6): поля стоимости из ответа LiteLLM не используются.
- Разобрать `usage` ответа OpenAI-формата в `LlmUsage`; без `prompt_tokens` или `completion_tokens` — `null`.
- Разобрать фактическую стоимость провайдера `usage.cost` в micro-USD для `providerCostMicroUsd` (REQ-002-19). На `costMicroUsd` она не влияет.

- Отдать `GET /v1/models` из каталога и сверить каталог с моделями апстрима при старте (`checkUpstream`, REQ-002-2, AC-002-6, AC-002-18): `createLlmGatewayCore(deps)` даёт `info`, `listModels`, `checkUpstream`, `complete`.

- Проверить вызов `complete` до апстрима (REQ-002-4, REQ-002-18, AC-002-3, -4, -5, -28): вызывающий `LlmCaller` → `invalid_caller`, тело `ChatRequest` → `invalid_request`, модель каталога → `model_not_found`. Отказ — `{ kind: 'error' }`, апстрим не вызывается, событие не публикуется.

- Успешный `complete` без потока (REQ-002-1, REQ-002-7, REQ-002-19, AC-002-1, -9, -14, -29): `callId`, замер задержки, `usage` и стоимость, событие `llm.call` `status: 'ok'`, лог `llm call`, `usage_missing` без `usage`, `event_publish_failed` при сбое шины.

- Отказ апстрима в `complete` без потока (REQ-002-9, AC-002-15, -16 на уровне ядра): таблица 4.6 — `400 upstream_bad_request`, `429 rate_limited`, `502 upstream_error`, `504 upstream_timeout`; событие `status: 'error'` с `usage: null`, лог `llm call` warn с `upstreamStatus` (только в лог).

- Поток `complete` с `stream: true` без обрывов (T-17, REQ-002-8, AC-002-10, -15, -29): `stream_options.include_usage = true` в копии тела, payload'ы отдаются клиенту как пришли, `usage` берётся из последнего фрагмента; событие `llm.call` `status: 'ok'` публикуется в `finally` генератора. Отказ до первого фрагмента — как в JSON-пути.

- Обрыв потока после старта и уход клиента (T-18, AC-002-12, -13, -15 потоком): обрыв апстрима (`UpstreamStreamError`, не `aborted`) — последний payload `{"error":{message, type: 'swag_gateway_error', code}}`, поток завершается без исключения, событие `status: 'aborted'` с `errorCode` по 4.6 (`upstreamReply`, та же таблица, что у JSON-пути), `usage` из уже полученных фрагментов. Внешний `aborted` (клиент ушёл) — исключение уходит потребителю, payload ошибки не пишется, событие `status: 'aborted'` без `errorCode`; `return()` потребителя — то же событие без `errorCode`.

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
- `complete(rawCaller, rawBody, signal)` — проверки 2–4 из 4.2 по порядку: `LlmCaller.safeParse` на `swarmId`/`agentId` (`invalid_caller`), `parseChatRequest` (`invalid_request`), поиск `model` в каталоге (`model_not_found`, `Unknown model: <имя>`, имя обрезается до 100 символов). Ответ — `CompleteResult` `kind: 'error'` с `status: 400` и `error` по 4.6.
- `complete` после проверок: `ids.uuid()` → `callId`, `upstream.complete(body, signal)`; `latencyMs = round(monotonicMs() − t0)` сразу после ответа. Успех: `usage` через `parseUsage` от `body.usage`, `costMicroUsd` по ценам модели из каталога, `providerCostMicroUsd` через `parseProviderCost` (только при `usage`). Отказ: `upstreamReply(failure)` по 4.6, событие с `usage`, стоимостями и `errorCode` — null/отсутствующие. Общая `publishCall`: событие `llm.call`, сбой публикации — `error` `event_publish_failed` с `callId`, затем лог `llm call` (по умолчанию info при `ok`, warn иначе; у обычного вызова с обрывом клиентом — info, спека 030; `callLogFields`: поля из данных события и `upstreamStatus`, null-значения не пишутся).
- Тесты: `test/complete-stream-aborts.test.ts` — AC-002-12 (обрыв после первого фрагмента: payload ошибки, событие `aborted` с `errorCode`, `usage` из полученных фрагментов, лог), AC-002-15 потоком (строки 4.6 после старта), AC-002-13 (`return()` и `aborted` апстрима без `errorCode`); `test/complete-errors.test.ts` — AC-002-15 (`http` 400/422/429/500/503, сеть) и AC-002-16 (таймаут) без потока на уровне ядра: ответ, событие, лог, сбой публикации; `test/complete-ok.test.ts` — AC-002-1, -9, -14, -29 без потока (успешный путь, `usage` отсутствует, сбой публикации); `test/complete-checks.test.ts` — AC-002-3, -4, -5, -28 на уровне ядра (`complete` до апстрима); `test/llm-gateway-core.test.ts` — AC-002-7, AC-002-29 (часть про `parseProviderCost`), разбор `parseUsage` в трёх случаях, блок «схема тела ChatRequest» (REQ-002-18); `test/gateway-core.test.ts` — AC-002-6 (`listModels`), AC-002-18 (`checkUpstream` на уровне ядра), `info`; `test/complete-stream.test.ts` — AC-002-10 (payload'ы по порядку, `include_usage` в копии тела и немутация `stream_options` клиента, `usage` из последнего фрагмента с фрагментом не по JSON, поток без `usage` без лога `usage_missing`, `return()` после первого `next()` — `aborted` и закрытый апстрим), AC-002-29 и -15 (отказ до потока), AC-002-9 (сбой публикации в конце потока). `fakes.ts`: `chunksThen` фиксирует закрытие итератора (`closed`).
- `test/fakes.ts` — фейковые порты в памяти: `fakeUpstream` (сценарии `models`, `complete`, `stream`, запись вызовов), `chunksThen` (поток из payload'ов и последующий `UpstreamStreamError`), `fakeEvents` (массив `published`, `fail` — отказ публикации), `fakeClock` (`advance(ms)`), `fakeIds`, `fakeTrace`, `fakeLog` (массив `entries`), `fakeDeps` (собирает `LlmGatewayDeps`). Каталог `testCatalog`: `chat-small`, `chat-large`.

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
- Поток — генератор `relay` над `upstream.stream`: usage и `providerCostMicroUsd` запоминаются до отдачи фрагмента, событие в `finally`. Ошибка апстрима после старта ловится в `catch` генератора: клиенту уходит payload ошибки, генератор завершается; `aborted` пробрасывается потребителю (D-62). Если потребитель вызвал `return()` до первого `next()`, `finally` не запустится, события не будет (D-60). `latencyMs` и `ts` потока — по концу потока (D-59). Для потока без `usage` лог `usage_missing` не пишется: вариант А, D-61.
- Обычный вызов, клиент ушёл (спека 030, 4.5): порт отдаёт `{ kind: 'aborted' }` (внешний `signal` оборван), событие `llm.call` со `status: 'aborted'`, `usage: null`, стоимости `null`, без `errorCode`, лог `llm call` уровня `info`. Ответ клиенту — `502 upstream_error`, как при `network`. Остальные отказы остаются `error` с `errorCode` по таблице 4.6. Поток не меняется: обрыв клиентом там и так `aborted` (D-58 заменён этим решением).
- Порядок проверок — как в 4.2: сначала вызывающий, потом тело, потом модель. Отказ возвращается значением (`kind: 'error'`), а не исключением: оболочка переводит его в HTTP-ответ по 4.6.
- `latencyMs` считается сразу после ответа апстрима, до публикации: поле входит в событие, а 4.4 задаёт его после него (D-57). `ts` события — `clock.now()` в тот же момент.
- Имя модели в `model_not_found` обрезается по символам Unicode (`Array.from`), а не по UTF-16 единицам, чтобы не разрезать эмодзи (D-56); трактовка «100 символов» записана в журнале спеки.

## Спеки

- 002 — 4.3 ([стоимость](../../docs/spec/002-llm-gateway.md#43-стоимость)), 4.4 ([ядро](../../docs/spec/002-llm-gateway.md#44-ядро-packagesllm-gateway-core)), 4.14 (пакеты).
- 030 — 4.5 (обрыв клиентом обычного вызова), REQ-030-7, AC-030-8 (T-7).
