# @swag/adapter-gateway-http

Адаптер порта `LlmSwarms` оркестратора к внутреннему API `llm-gateway` (спека 004, 4.6): регистрация роя при запуске и закрытие при завершении. Ходит по сети compose на `LLM_GATEWAY_URL`.

## Задачи

- `createGatewaySwarms({ baseUrl, token, timeoutMs })` — объект `LlmSwarms` из `@swag/orchestrator-core`.
- `register(reg)` — `POST {baseUrl}/internal/swarms` с телом `LlmSwarmRegistration` (`@swag/contracts`) и заголовком `Authorization: Bearer <token>`. Успех — только `204`. Иначе — исключение `GatewayError`.
- `close(swarmId)` — `POST {baseUrl}/internal/swarms/:id/close`. Успех — `2xx` и `404` (рой уже не зарегистрирован). Иначе — исключение `GatewayError`.

## Что внутри сейчас

- `src/index.ts` — `GatewaySwarmsOptions`, `GatewayError` (`status`, `code`), `createGatewaySwarms`. Код ошибки берётся из `{ error: { message, code } }` тела ответа (4.2); если тела нет или оно не разобрано, код — `http_<статус>`.
- Таймаут каждого запроса — `AbortSignal.timeout(timeoutMs)`; при срабатывании `fetch` бросает `TimeoutError`.
- `test/gateway-swarms.test.ts` — фейковый HTTP-сервер на `127.0.0.1`: регистрация `204` с проверкой тела и заголовка; ошибки регистрации с кодом из тела; `close` `200`/`204`/`404` — успех, `500` — исключение; таймаут.

## Ключевые решения

- Повторов нет (4.6): рой с недоступным gateway падает сразу, оболочка переводит исключение в `swarm.failed` `gateway_unavailable`.
- `close` — успех при `2xx` и `404`; тело не читается.
- `content-type: application/json` — только у `register` (запрос с телом). Общий заголовок для `close` ломал его: gateway отвечает 400 на пустое JSON-тело (дефект, найден стек-тестом AC-004-34, исправлен в T-17; тест в `test/gateway-swarms.test.ts` проверяет отсутствие заголовка у `close`).
- Адаптер зависит от `@swag/orchestrator-core` только ради типа порта `LlmSwarms`, как `adapter-orchestrator-http` зависит от `@swag/api-core`.

## Ограничения

- Только два маршрута внутреннего API; `GET /v1/models` и вызовы моделей адаптер не делает.
- Таймаут задаёт оболочка (`apps/orchestrator`, константа `GATEWAY_TIMEOUT_MS`, D-99).

## Связи

- Потребитель: `apps/orchestrator` (`src/main.ts`) передаёт результат в `createOrchestratorCore` как `llmSwarms`.
- Порт: `LlmSwarms` в `@swag/orchestrator-core`. Тип регистрации: `LlmSwarmRegistration` в `@swag/contracts`.
- Сервер: `apps/llm-gateway` (`POST /internal/swarms`, `POST /internal/swarms/:swarmId/close`, спека 004, 4.2).

## Спеки

- 004, 4.6 (адаптер и поведение оркестратора), 4.2 (маршруты и коды), 4.11 (`LLM_GATEWAY_URL`, `LLM_GATEWAY_TOKEN`), REQ-004-3.
