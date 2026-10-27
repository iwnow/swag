# @swag/llm-gateway-core

Ядро LLM Gateway (спека 002): расчёт стоимости вызова модели и разбор `usage` ответа провайдера. Чистый TypeScript, не знает про HTTP, Fastify, LiteLLM и env.

## Задачи

- Проверить тело `POST /v1/chat/completions` по схеме `ChatRequest` и запретить поля ключа и адреса провайдера (REQ-002-18): `parseChatRequest` возвращает разобранное тело или текст `message` для `invalid_request`.
- Посчитать стоимость вызова `costMicroUsd` по `usage` и ценам модели из каталога (REQ-002-6): поля стоимости из ответа LiteLLM не используются.
- Разобрать `usage` ответа OpenAI-формата в `LlmUsage`; без `prompt_tokens` или `completion_tokens` — `null`.
- Разобрать фактическую стоимость провайдера `usage.cost` в micro-USD для `providerCostMicroUsd` (REQ-002-19). На `costMicroUsd` она не влияет.

Фабрика ядра, поток, событие `llm.call` и остальные методы порта — следующие задачи спеки 002 (порт пока объявляет только `complete`). Проверка модели в каталоге и `invalid_caller` — T-14.

## Что внутри сейчас

- `costMicroUsd(usage, prices)` — формула 4.3 в `bigint`: цены из строк × 10⁴, `cached = min(cachedPromptTokens, promptTokens)`, округление вверх.
- `parseUsage(raw)` — `prompt_tokens` → `promptTokens`, `completion_tokens` → `completionTokens`, `prompt_tokens_details.cached_tokens` → `cachedPromptTokens` (нет поля — 0). Возвращает `null`, если нет `prompt_tokens` или `completion_tokens` или они не целые ≥ 0.
- `parseProviderCost(rawUsage)` — `usage.cost` как конечное число ≥ 0 → `Math.round(cost × 10⁶)`; иначе `null`.
- `ChatRequest` (zod `looseObject`: `model`, `messages` с минимум одним элементом, `stream`, `stream_options`; остальные поля проходят) и `CLIENT_CREDENTIAL_FIELDS` (7 полей из 4.2).
- Тип порта апстрима `LlmUpstream` (пока только `complete`), `UpstreamFailure` и `UpstreamResponse` (4.4). `signal` — структурный тип `UpstreamSignal`: `AbortSignal` без DOM не объявляется (D-47).
- `parseChatRequest(raw)` — сначала поля `CLIENT_CREDENTIAL_FIELDS` (`Client-side provider credentials are not allowed: <поле>`), потом схема; первые 3 ошибки Zod как `path: message` через `; ` (сегменты пути через `.`, при пустом пути — только текст; D-43).
- Тесты: `test/llm-gateway-core.test.ts` — AC-002-7, AC-002-29 (часть про `parseProviderCost`), разбор `parseUsage` в трёх случаях, блок «схема тела ChatRequest» (REQ-002-18).

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

## Спеки

- 002 — 4.3 ([стоимость](../../docs/spec/002-llm-gateway.md#43-стоимость)), 4.14 (пакеты).
