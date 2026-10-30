# @swag/api-core

Ядро API платформы: рои — создание, список, состояние, события, остановка, приём событий и сообщений шины. Чистый TypeScript, не знает про HTTP, Fastify, NATS, Postgres и Docker.

## Задачи

- Создать рой: проверить запрос (`SwarmCreateRequest`) и бюджеты (004, 4.7), лимит активных роёв, записать `swarm.created`, вызвать оркестратор; при отказе оркестратора — `swarm.failed` (`orchestrator_unavailable`).
- Принять события роя (`swarm.*.events`) и сообщения агентов (`swarm.*.agent.*.inbox`): валидировать, назначить сквозной `seq`, превратить сообщение в `bus.message`. Событие `llm.call` от `llm-gateway` (спека 002) принимается и хранится так же, как остальные события из шины.
- Отдать события с `seq > after` и подписать на новые (поток WebSocket) без пропусков и повторов.
- Остановить рой; рой в финальном статусе — `swarm_finished`.

Пользователи, вход и роли — будущие ядра `identity-core` (спека 012), пока роя принадлежат единственному локальному пользователю.

## Что внутри сейчас

- `createApiCore(deps)` с портами `SwarmStore` (асинхронный), `OrchestratorClient`, `Clock`, `IdGenerator`, `Logger` (`debug`/`info`/`warn`/`error` с `LogContext`), `TraceContext`.
- Операции (все асинхронные): `createSwarm`, `listSwarms`, `getSwarm`, `getEvents`, `stopSwarm`, `ingestEvent`, `ingestMessage`, `subscribe`, `closeInterrupted`; синхронная `info`.
- Бюджеты (004, 4.7): `deps.limits.maxBudgetMicroUsd` (из `SWARM_MAX_BUDGET_MICRO_USD`). Бюджет роя больше предела — `validation_error` `budget exceeds SWARM_MAX_BUDGET_MICRO_USD`; бюджет агента больше бюджета роя — `validation_error` `agent budget exceeds swarm budget`. Обе проверки идут до лимита активных роёв. Бюджеты пишутся в `swarm.created` и в `SwarmLaunch`.
- `closeInterrupted()` (REQ-003-6): вызывается оболочкой при старте, до подписок NATS (T-7). Для каждого роя в `starting` или `running` вызывает `orchestrator.stop` и записывает `swarm.failed` с `reason: 'api_restarted'` (`source: 'api'`, `agentId` и `traceId` — `null`). Ошибка `stop` пишется `warn` `interrupted stop failed` и не мешает закрытию. Возвращает число закрытых роёв (записи, которые не прошли, не считаются); в конце — `info` `interrupted swarms closed` с `count`. Закрытые рои не держат лимит `MAX_ACTIVE_SWARMS`.
- Логи по таблице 4.8 спеки 016: `info swarm created`, `error orchestrator unavailable`, `warn event dropped` / `message dropped` с `reason` (`invalid_schema`, `created_from_bus`, `unknown_swarm`, `not_applicable`); `warn interrupted stop failed`, `info interrupted swarms closed`.
- Тесты: `test/api-core.test.ts` — AC-000-16, AC-001-3…8, AC-001-10, AC-002-26, AC-003-4…6, AC-004-2, AC-016-4, AC-016-7.

## Ограничения

Правила ядра ([архитектура](../../docs/architecture.md), [спека 000, 4.2](../../docs/spec/000-foundation.md#42-правила-ядра-и-оболочки)):

- Зависимости — `@swag/contracts`, `@swag/api-integration`.
- Нет Node API, `process`, env, файлов, сети: `tsconfig` без `@types/node` и DOM.
- Всё внешнее — через порты; реализации передаёт оболочка.

Нарушения ловят `npm run arch:check` и `npm run typecheck`.

Очередь записи живёт в памяти одного процесса: несколько экземпляров `api` её не объединяют (спека 003, «Не входит»).

## Связи

- Оболочка: `apps/api`.
- Адаптеры: `@swag/adapter-memory` (хранилище для тестов ядра), `@swag/adapter-orchestrator-http` (оркестратор). Хранилище на Postgres — `@swag/adapter-postgres` (спека 003, T-6).
- Использует: `@swag/contracts`, `@swag/api-integration` (проекция роя, `FINAL_SWARM_STATUSES`).

## Ключевые решения

- Порт `SwarmStore` асинхронный (003, Q-1): `appendEvent` — reject на недопустимое событие; `events` — по возрастанию `seq`.
- Номер события `seq` назначает ядро при записи (`lastSeq + 1`), издатели его не знают (4.3, 4.5.4).
- Очередь записи (003, REQ-003-3): все записи одного роя — цепочка `Promise` (`commit`), внутри звена: прочитать `lastSeq`, записать событие, разослать подписчикам. Ошибка записи — `warn` (`event dropped` / `message dropped`, `reason: not_applicable`), цепочка не рвётся. Записи разных роёв идут параллельно. Рассылка идёт вне блока записи: сбой слушателя — `warn` `listener failed` с `swarmId`, остальные подписчики события получают его (`deliver` ловит исключение каждого слушателя).
- Подписка с буфером (003, REQ-003-4): `subscribe` сначала проверяет рой, затем регистрирует подписчика, затем читает историю `seq > after`. События, записанные во время чтения, копятся в буфере подписчика; после истории отдаются буфер и новые события. Подписчик отслеживает последний отданный `seq`, поэтому каждое событие уходит ровно один раз и по возрастанию. Флаг `closed` не даёт доставлять события после отписки, в том числе во время чтения истории.
- Порядок проверок `createSwarm` (004, D-100): схема, бюджеты, лимит активных роёв. Рой с неверным бюджетом не занимает место в лимите.
- `createSwarm`: `swarm.created` пишется до вызова оркестратора; ошибка оркестратора → `swarm.failed` (`orchestrator_unavailable`), ответ остаётся 201 (4.5.1, AC-001-6).
- Лимит активных роёв (`MAX_ACTIVE_SWARMS`): активные рои считаются по `store.views()`, плюс счётчик `reserving` — роёв, для которых `createSwarm` ещё пишет `swarm.created`. Проверка и `reserving += 1` идут без `await` между ними, поэтому параллельные вызовы не пройдут лимит вдвоём (поведение 001). Счётчик уменьшается в `finally` после записи.
- Сбой записи `swarm.created` (хранилище отклонило событие, `commit` вернул `null`): `createSwarm` бросает `Error('swarm.created не записан')` — оболочка отвечает 500 через `setErrorHandler`; оркестратор не вызывается (D-86: код `internal_error` против отдельного `store_unavailable` с 503 — на приёмке 003).
- `traceId` (016, Q-1): ядро берёт его из обязательного порта `TraceContext` для событий, которые строит само (`swarm.created`, `swarm.failed`, `bus.message`), и переносит в конверт как непрозрачную строку. Событие из шины хранится с тем `traceId`, с которым его опубликовали. OpenTelemetry ядро не знает.
- Итоговый статус роя окончательный (003, REQ-003-7): `stopSwarm` и проверка финальности используют `FINAL_SWARM_STATUSES` из `api-integration`.
- В логах только id, числа и перечисления: текст задачи, ролей и сообщений в контекст не попадает (016, Q-4). Ошибка — в поле `err`.
- Отклонение: `stopSwarm` при ошибке оркестратора (например, 404) отдаёт исключение, а не код ошибки API — в 4.5.3 такого кода нет. Вопрос к приёмке.

## Спеки

- 000 — заглушка.
- 004 — бюджеты в `createSwarm` (4.7, REQ-004-1, REQ-004-2, AC-004-2).
- 001 — 4.5 ([REST и WebSocket](../../docs/spec/001-walking-skeleton.md#45-api)).
- 002 — `llm.call` от `llm-gateway`: приём, `seq`, `unknown_swarm` (REQ-002-15, AC-002-26).
- 003 — асинхронный порт, очередь записи, подписка с буфером (REQ-003-3, REQ-003-4, AC-003-4, AC-003-5); закрытие прерванных роёв — T-4.
- 016 — порты `Logger` и `TraceContext`, логи 4.8.
