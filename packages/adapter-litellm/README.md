# @swag/adapter-litellm

Адаптер LiteLLM для LLM Gateway (спека 002): вызов `POST /v1/chat/completions` и `GET /v1/models` у LiteLLM Proxy, таймаут простоя, разбор SSE. Пока каркас: реализация — следующие задачи спеки 002.

## Задачи

Запланировано по 4.5 спеки 002 (не реализовано):

- `createLiteLlmUpstream(options)` — порт `LlmUpstream` с методами `complete`, `stream`, `listModels`.
- `redact(text, secrets)` — замена секретов на `***` в тексте ошибки.

## Что внутри сейчас

- `src/index.ts` — пустой индекс (`export {}`).
- `test/fake-provider.test.ts` — тесты фейкового провайдера из `infra/llm/fake-provider/server.ts` (спека 002, 4.12, часть без потока): ответ по умолчанию, `tools`, маркеры `__no_usage__`, `__no_cost__`, `__fail_500__`, `__fail_429__`, `__fail_400__`, `GET /v1/models`. Тесты без AC-id: у задачи T-7 критериев нет.

## Ограничения

- Зависимостей нет (см. «Ключевые решения»).
- Фейк не проверяет модели и поток: поток в T-8, с `stream: true` фейк отвечает `501`.

## Связи

- Порт: `LlmUpstream` из `@swag/llm-gateway-core` (появится в T-9 вместе с адаптером).
- Оболочка: `apps/llm-gateway` (спека 002, T-20).
- Фейк: `infra/llm/fake-provider/server.ts`, профиль `test` в compose.

## Ключевые решения

- Зависимости по 4.14 (`@swag/llm-gateway-core`, `@swag/adapter-telemetry`) не добавлены: текущие тесты используют только `fetch` и фейк, а индекс пустой. Добавятся вместе с кодом, которому они нужны (YAGNI).
- Тесты фейка лежат в этом пакете, потому что фейк нужен адаптеру (4.12), а `infra/llm/fake-provider` — не пакет, у него нет своего `test`.
- Фейк слушает все интерфейсы (`server.listen(port)`), а не только `127.0.0.1`: в compose `llm-fake` не публикуется наружу и должен быть доступен `litellm` по имени в сети `llm`. Порт на хосте не публикуется.

## Спеки

- 002 — 4.5, 4.12, 4.14; T-7.
