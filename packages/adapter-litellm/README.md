# @swag/adapter-litellm

Адаптер LiteLLM для LLM Gateway (спека 002): вызов `POST /v1/chat/completions` и `GET /v1/models` у LiteLLM Proxy, таймаут простоя, разбор SSE. Пока каркас: реализация — следующие задачи спеки 002.

## Задачи

Запланировано по 4.5 спеки 002 (не реализовано):

- `createLiteLlmUpstream(options)` — порт `LlmUpstream` с методами `complete`, `stream`, `listModels`.
- `redact(text, secrets)` — замена секретов на `***` в тексте ошибки.

## Что внутри сейчас

- `src/index.ts` — пустой индекс (`export {}`).
- `test/fake-provider.test.ts` — тесты фейкового провайдера из `infra/llm/fake-provider/server.ts` (спека 002, 4.12, часть без потока): ответ по умолчанию, `tools`, маркеры `__no_usage__`, `__no_cost__`, `__fail_500__`, `__fail_429__`, `__fail_400__`, `GET /v1/models`, неизвестный путь — `404`, `requests` содержит только `POST /v1/chat/completions`. Тесты без AC-id: у задачи T-7 критериев нет.

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
- Сетевой интерфейс фейка (D-44): `startFakeProvider` (тесты) слушает `127.0.0.1`, запуск скриптом — `0.0.0.0`, чтобы `litellm` в сети `llm` достучался до `llm-fake` по имени. Порт на хосте не публикуется (4.8, раздел 7). Сигнатура `startFakeProvider(opts)` не менялась: общая неэкспортируемая `listenFakeProvider(opts, host)`.
- Поле `requests` пишет только `POST /v1/chat/completions` (трактовка T-7): `GET /v1/models` и неизвестные пути в журнал запросов не попадают, чтобы тесты проверяли только вызовы чата.
- `content: null` в ответе с `tool_calls` — формат OpenAI, решение D-45.

## Спеки

- 002 — 4.5, 4.12, 4.14; T-7.
