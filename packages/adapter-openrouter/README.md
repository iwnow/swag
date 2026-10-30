# @swag/adapter-openrouter

Источник цен OpenRouter для `llm-gateway` (спека 004, 4.9): один `GET` на список моделей без ключа, повтор по 4.10. Разбор ответа и перевод цен — в ядре (`applyOpenRouterPrices`, `@swag/llm-gateway-core`); адаптер ответ не разбирает.

## Задачи

- `createOpenRouterPrices({ url, timeoutMs, retry?, fetch? })` — объект с методом `fetchModels(signal)`, который возвращает тело ответа как есть (`unknown`).
- Повтор через `retry` из `@swag/helpers` с `httpRetryable` из `@swag/helpers/server`: сетевые ошибки, таймаут одной попытки, `408`, `429`, `5xx`. Остальные `4xx` — без повтора.
- Ответ не `2xx` — `HttpError` со `status` и `retryAfterMs` из заголовка `Retry-After` (`parseRetryAfter`).

## Что внутри сейчас

- `src/index.ts` — `OpenRouterPricesOptions`, `OpenRouterPrices`, `createOpenRouterPrices`. Каждая попытка: `fetch(url)` с сигналом «внешний `signal` или таймаут `timeoutMs`» (`AbortSignal.any`), заголовок `accept: application/json`.
- `test/openrouter-prices.test.ts` — фейковый HTTP-сервер на `127.0.0.1` (без сети): ответ `200`; `500` с повтором и паузами по формуле 4.10; `400` без повтора; `429` с `Retry-After: 2`; таймаут `TimeoutError`; прерванный `signal` — запроса нет.

## Ключевые решения

- Адаптер на `fetch`, без SDK: один эндпоинт, без ключа, зависимостей кроме `@swag/helpers`.
- Ответ отдаётся как `unknown`: форму проверяет ядро (`applyOpenRouterPrices` сам пропускает модели с неожиданной формой, спека 004, D-96).
- Параметры `retry` (попытки, задержки, `sleep`, `random`) — необязательные: по умолчанию 4 попытки и задержки 4.10, в тестах короче.
- `timeoutMs` задаёт оболочка (`PRICES_TIMEOUT_MS` в `apps/llm-gateway/src/main.ts`, D-97).

## Ограничения

- Только список моделей `GET /api/v1/models`; поток, ключ и другие эндпоинты не нужны.
- Тело успешного ответа не ограничено по размеру: список моделей OpenRouter читается целиком.

## Связи

- Потребитель: `apps/llm-gateway` (`main.ts`, `prices.ts`).
- Ядро: `@swag/llm-gateway-core` (`applyOpenRouterPrices`, `PriceStore`) — ядро адаптер не импортирует, порта в ядре нет: оболочка передаёт функцию `fetchModels` в `startPriceRefresh`.
- Хелперы: `@swag/helpers` (`retry`), `@swag/helpers/server` (`HttpError`, `httpRetryable`, `parseRetryAfter`).

## Спеки

- 004, 4.9 (источник цен, таймер и сохранение), 4.10 (повтор, `HttpError`), 4.11 (`OPENROUTER_MODELS_URL`, `LLM_PRICES_REFRESH_MS`).
