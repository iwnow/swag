# @swag/adapter-orchestrator-http

Адаптер порта `OrchestratorClient` из `api-core` и порта `NodeInvoker` из `scheduler-core`: вызовы оркестратора по HTTP через `fetch` с передачей контекста трассировки.

## Задачи

- `launch(SwarmLaunch)` → `POST /swarms`, ожидается `202`.
- `stop(swarmId)` → `POST /swarms/:id/stop`, ожидается `202`.
- `invokeNode(NodeInvocation)` → `POST /node-invocations` (033, 4.10): тело — вызов узла, ответ `200` разбирается `NodeInvocationResult`; `ok: false` — результат, не исключение. Не-2xx — исключение.
- Любой другой ответ, сетевая ошибка или истёкший `timeoutMs` — исключение; ядро `api` превращает его в `swarm.failed` (`orchestrator_unavailable`).
- Каждый вызов — клиентский спан, `traceparent` текущего контекста уходит в заголовке (016, 4.5).
- Каждый запрос несёт `authorization: Bearer <token>` с `ORCHESTRATOR_TOKEN` (024, 4.13); оркестратор без него отвечает `401`, и клиент это считает ошибкой вызова.

## Что внутри сейчас

- `createOrchestratorHttpClient({ baseUrl, token, timeoutMs, fetch? })` — возвращает `OrchestratorClient & NodeInvoker`.
- `test/client.test.ts` — AC-024-22: заголовок `Authorization` на `launch` и `stop` (фейковый оркестратор на локальном порту); AC-013-21: молчащий оркестратор при `timeoutMs: 100` — `launch` падает быстрее 1 с; REQ-033-7: `invokeNode` (путь, тело, токен, `traceparent`, таймаут, `ok: false` как результат, не-2xx как исключение).
- Тест HTTP-цепочки с настоящими `api` и `orchestrator` — `apps/api/test/trace.test.ts` (AC-016-9).

## Ограничения

- Таймаут на каждый запрос задаёт вызывающий (`timeoutMs`); `apps/api` передаёт `ORCHESTRATOR_TIMEOUT_MS` (15 с, 013, 4.9). Таймаут должен быть больше `stop` оркестратора, который ждёт закрытия в gateway.
- Транспорт — HTTP по Q-6; смена на NATS request-reply не должна трогать `api-core`.

## Связи

- Порты: `OrchestratorClient` из `@swag/api-core`, `NodeInvoker` из `@swag/scheduler-core` (только типы).
- Использует: `@swag/contracts` (`NodeInvocation`, `NodeInvocationResult`), `@opentelemetry/api`.
- Dev: `@swag/adapter-telemetry` — тест `traceparent` поднимает глобальный пропагатор.
- Оболочка: `apps/api` (адрес — `ORCHESTRATOR_URL`, токен — `ORCHESTRATOR_TOKEN`).

## Ключевые решения

- Транспорт HTTP по Q-6, `fetch` из Node 24 — без внешних библиотек.
- Ответ, отличный от `202`, — исключение: ядро `api` трактует его как недоступность оркестратора (`swarm.failed`, `orchestrator_unavailable`).
- Контекст трассировки (016, 4.5) — явная передача заголовка через глобальный пропагатор `@opentelemetry/api`, а не автоинструментация `fetch`: без патчинга undici и без зависимости от SDK. Спан `POST` (`kind: client`) с атрибутами `http.request.method`, `url.full`, `server.address`, `server.port`, `http.response.status_code`; ответ `4xx`/`5xx` или сетевая ошибка — статус `ERROR`.
- Таймаут `AbortSignal.timeout(timeoutMs)` на `launch` и `stop` (013, 4.9, из N-25). Таймаут не отдельная ошибка: это исключение fetch, как при недоступности оркестратора, поэтому `api` ведёт себя одинаково.
- `invokeNode`: таймаут `(invocation.timeoutMs ?? timeoutMs) + 10000` (033, 4.10; без `invocation.timeoutMs` — таймаут клиента, D-186): запас на сеть и разбор ответа над лимитом вызова узла; один путь `post` для всех трёх маршрутов, `post` возвращает `Response`.

## Спеки

- 001 — 4.5.4, Q-6.
- 016 — 4.5, AC-016-9.
- 024 — 4.13, AC-024-22.
- 033 — 4.10, REQ-033-7.
- 013 — 4.9 (из N-25), AC-013-21.
