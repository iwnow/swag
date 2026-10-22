# @swag/adapter-orchestrator-http

Адаптер порта `OrchestratorClient` из `api-core`: вызовы оркестратора по HTTP через `fetch`.

## Задачи

- `launch(SwarmLaunch)` → `POST /swarms`, ожидается `202`.
- `stop(swarmId)` → `POST /swarms/:id/stop`, ожидается `202`.
- Любой другой ответ или сетевая ошибка — исключение; ядро `api` превращает его в `swarm.failed` (`orchestrator_unavailable`).

## Что внутри сейчас

- `createOrchestratorHttpClient({ baseUrl, fetch? })`.

## Ограничения

- Таймаута на запрос нет: долгий `launch` (создание контейнеров) ждёт до ответа оркестратора.
- Транспорт — HTTP по Q-6; смена на NATS request-reply не должна трогать `api-core`.

## Связи

- Порт: `OrchestratorClient` из `@swag/api-core` (только типы).
- Использует: `@swag/contracts`.
- Оболочка: `apps/api` (адрес — `ORCHESTRATOR_URL`).

## Ключевые решения

- Транспорт HTTP по Q-6, `fetch` из Node 24 — без внешних библиотек.
- Ответ, отличный от `202`, — исключение: ядро `api` трактует его как недоступность оркестратора (`swarm.failed`, `orchestrator_unavailable`).
- Отклонение от спеки: таймаут на запрос не задан (4.5.4 его не требует); при зависании оркестратора `createSwarm` ждёт ответа. Заведено как вопрос к приёмке, см. журнал спеки 001.

## Спеки

- 001 — 4.5.4, Q-6.
