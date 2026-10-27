# @swag/llm-gateway-core

Ядро LLM Gateway (спека 002): расчёт стоимости вызова модели и разбор `usage` ответа провайдера. Чистый TypeScript, не знает про HTTP, Fastify, LiteLLM и env.

## Задачи

- Посчитать стоимость вызова `costMicroUsd` по `usage` и ценам модели из каталога (REQ-002-6): поля стоимости из ответа LiteLLM не используются.
- Разобрать `usage` ответа OpenAI-формата в `LlmUsage`; без `prompt_tokens` или `completion_tokens` — `null`.
- Разобрать фактическую стоимость провайдера `usage.cost` в micro-USD для `providerCostMicroUsd` (REQ-002-19). На `costMicroUsd` она не влияет.

Сами вызовы модели, фабрика ядра, поток и событие `llm.call` — следующие задачи спеки 002.

## Что внутри сейчас

- `costMicroUsd(usage, prices)` — формула 4.3 в `bigint`: цены из строк × 10⁴, `cached = min(cachedPromptTokens, promptTokens)`, округление вверх.
- `parseUsage(raw)` — `prompt_tokens` → `promptTokens`, `completion_tokens` → `completionTokens`, `prompt_tokens_details.cached_tokens` → `cachedPromptTokens` (нет поля — 0). Возвращает `null`, если нет `prompt_tokens` или `completion_tokens` или они не целые ≥ 0.
- `parseProviderCost(rawUsage)` — `usage.cost` как конечное число ≥ 0 → `Math.round(cost × 10⁶)`; иначе `null`.
- Тесты: `test/llm-gateway-core.test.ts` — AC-002-7, AC-002-29 (часть про `parseProviderCost`), разбор `parseUsage` в трёх случаях.

## Ограничения

Правила ядра ([архитектура](../../docs/architecture.md), [спека 000, 4.2](../../docs/spec/000-foundation.md#42-правила-ядра-и-оболочки)):

- Зависимости — `zod`, `@swag/contracts`.
- Нет Node API, `process`, env, файлов, сети: `tsconfig` без `@types/node` и DOM.

Нарушения ловят `npm run arch:check` и `npm run typecheck`.

## Связи

- Оболочка: `apps/llm-gateway` (спека 002, T-20).
- Адаптер: `@swag/adapter-litellm` (типы порта `LlmUpstream` из этого пакета, спека 002, 4.5).
- Использует: `@swag/contracts` (`LlmUsage`, `ModelPrices`).

## Ключевые решения

- Цены в `costMicroUsd` — строки `ModelPrices` и `bigint`-арифметика без `Number` с дробями (4.3): `"0.0001"` дает ровно 1 micro-USD за миллион токенов.
- `parseUsage` ограничивает `cachedPromptTokens` значением `promptTokens`: `LlmUsage` по контракту (4.1) не допускает больше. Трактовка 4.3, принята при реализации T-5 (спека 002).
- `parseProviderCost` округляет до ближайшего, а `costMicroUsd` — вверх: `providerCostMicroUsd` — факт расхода платформы, `costMicroUsd` — списание с клиента по тарифу (4.3).

## Спеки

- 002 — 4.3 ([стоимость](../../docs/spec/002-llm-gateway.md#43-стоимость)), 4.14 (пакеты).
