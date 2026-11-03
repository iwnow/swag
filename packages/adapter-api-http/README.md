# @swag/adapter-api-http

Адаптер порта `ApiClient` из `scheduler-core`: внутренние маршруты `api` (`/internal/*`) по HTTP через `fetch` с передачей контекста трассировки. Клиент используется оболочкой планировщика (`apps/scheduler`), когда тот запускает процесс и сверяет статусы запусков.

## Задачи

- `launchRun(request)` → `POST /internal/process-runs`, тело `RunLaunchRequest`, ответ `200` разбирается `RunLaunchResult`. `launched`, `rejected`, `busy`, `process_not_found` — результаты, не исключения.
- `runStatuses(runIds)` → `POST /internal/process-runs/status`, тело `RunStatusRequest`, ответ `200 RunStatusList` превращается в `Map<runId, SwarmStatus | null>`; `null` — исполнения нет.
- Не-2xx и сеть — исключение (`api` ответил `401` или `400` — это ошибка конфигурации или контракта).
- Каждый вызов — клиентский спан, `traceparent` текущего контекста уходит в заголовке; каждый запрос несёт `authorization: Bearer <token>` (`API_INTERNAL_TOKEN`).

## Что внутри сейчас

- `createApiInternalHttpClient({ baseUrl, token, timeoutMs, fetch? })` — возвращает `ApiClient`.
- `test/client.test.ts` — REQ-033-23 на фейковом `api` (127.0.0.1): путь и метод, тело, токен, `traceparent`, разбор `RunLaunchResult` (включая `rejected` как результат), разбор `runStatuses` в `Map` с `null`, не-2xx как исключение.

## Ограничения

- Таймаут на каждый запрос задаёт вызывающий (`timeoutMs`); оболочка планировщика передаёт константу 10000 мс (033, 4.9).
- Тело `RunLaunchRequest` содержит событие триггера: клиент его не логирует, в спанах только адрес и статус (033, REQ-033-24).

## Связи

- Порт: `ApiClient` из `@swag/scheduler-core` (только тип).
- Использует: `@swag/contracts` (`RunLaunchRequest`, `RunLaunchResult`, `RunStatusList`), `@opentelemetry/api`.
- Dev: `@swag/adapter-telemetry` — тест `traceparent` поднимает глобальный пропагатор.
- Оболочка: `apps/scheduler` (адрес — `API_URL`, токен — `API_INTERNAL_TOKEN`).
- Парный клиент в обратную сторону: `@swag/adapter-scheduler-http` (`api` → планировщик).

## Ключевые решения

- HTTP через `fetch` Node, без внешних библиотек; структура повторяет `@swag/adapter-orchestrator-http` (033, T-12).
- Обёртка запроса продублирована из `adapter-scheduler-http`, а не вынесена в общий пакет: обёртка осознанно повторяет `adapter-orchestrator-http`, вынос — N-38 (033, T-13).
- `runStatuses` отдаёт `Map`, чтобы планировщик сверял статусы по `runId` без поиска по массиву.

## Спеки

- 033 — 4.7 (порт `ApiClient`), 4.10 (внутренние маршруты), REQ-033-23.
- 016 — 4.5 (`traceparent`).
