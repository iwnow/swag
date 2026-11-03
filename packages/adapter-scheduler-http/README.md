# @swag/adapter-scheduler-http

Адаптер порта `SchedulerClient` из `api-core`: внутренний API планировщика по HTTP через `fetch` с передачей контекста трассировки. Клиент используется оболочкой `api` (`apps/api`), когда сохраняет процесс, включает его, выключает или ставит запуск.

## Задачи

- `putJob(processId, spec)` → `PUT /jobs/:processId`, тело `JobSpec`, ожидается `200 JobState`.
- `enable(processId)` → `POST /jobs/:processId/enable`: `200` — `JobState`, `404` — `'not_found'`, `409` — `'process_no_trigger'`.
- `disable(processId, reason)` → `POST /jobs/:processId/disable` с `{ reason }`: `200` — `JobState`, `404` — `'not_found'`.
- `deleteJob(processId)` → `DELETE /jobs/:processId`: `204` и `404` — успех (`void`).
- `states(processIds)` → `POST /jobs/states`, `200 JobStateList` → `items`.
- `createRun(processId, event)` → `POST /jobs/:processId/runs` с `{ event }`: `201` — `ProcessRunView`, `404` — `'not_found'`, `409` — `'queue_full'`.
- `runs(processId)` → `GET /jobs/:processId/runs`, `200 ProcessRunList` → `items`; `404` — исключение (в результатах порта нет `not_found`).
- Ответы разбираются zod-схемами из `@swag/contracts`. Сеть, таймаут и прочие не-2xx — исключение.
- Каждый вызов — клиентский спан, `traceparent` текущего контекста уходит в заголовке; каждый запрос несёт `authorization: Bearer <token>` (`SCHEDULER_TOKEN`).

## Что внутри сейчас

- `createSchedulerHttpClient({ baseUrl, token, timeoutMs, fetch? })` — возвращает `SchedulerClient`.
- `test/client.test.ts` — REQ-033-23 на фейковом планировщике (127.0.0.1): путь и метод каждого метода, тело, токен, `traceparent`, разбор ответа, `404`/`409` в результаты, `204`/`404` у `deleteJob`, не-2xx как исключение, экранирование `processId`.

## Ограничения

- Таймаут на каждый запрос задаёт вызывающий (`timeoutMs`); оболочка `api` передаёт константу 10000 мс (033, 4.9).
- Ошибки `400` и `401` от планировщика — исключение: это ошибка конфигурации или контракта, а не результат для ядра.

## Связи

- Порт: `SchedulerClient` из `@swag/api-core` (только тип).
- Использует: `@swag/contracts` (`JobState`, `JobStateList`, `ProcessRunView`, `ProcessRunList`), `@opentelemetry/api`.
- Dev: `@swag/adapter-telemetry` — тест `traceparent` поднимает глобальный пропагатор.
- Оболочка: `apps/api` (адрес — `SCHEDULER_URL`, токен — `SCHEDULER_TOKEN`).
- Парный клиент в обратную сторону: `@swag/adapter-api-http` (планировщик → `api`).

## Ключевые решения

- HTTP через `fetch` Node, без внешних библиотек; структура повторяет `@swag/adapter-orchestrator-http` (033, T-12).
- Небольшая обёртка запроса (`send`, `expectOk`) продублирована в `adapter-api-http`, а не вынесена в общий пакет: обёртка осознанно повторяет `adapter-orchestrator-http`, вынос — N-38 (033, T-13).
- Результаты `404`/`409` — значения порта по статусу, а не по коду тела: коды `job_not_found`/`process_no_trigger` в теле нужны логам планировщика, клиенту не нужны.
- `processId` в пути — `encodeURIComponent`.
- Заголовок `traceparent` передаётся явно через глобальный пропагатор `@opentelemetry/api`, а не автоинструментацией `fetch` (016, 4.5).

## Спеки

- 033 — 4.6 (порт `SchedulerClient`), 4.9 (маршруты), REQ-033-23.
- 016 — 4.5 (`traceparent`).
