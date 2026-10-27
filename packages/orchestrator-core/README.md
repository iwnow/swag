# @swag/orchestrator-core

Ядро оркестратора: исполнение роя — песочница на агента, ожидание готовности, передача задачи, завершение, остановка, таймауты и уборка. Чистый TypeScript, без Docker и NATS: это делают адаптеры портов.

## Задачи

- `launch`: проверить `SwarmLaunch` строгой схемой, создать песочницу на агента (`AGENT_TEMPLATE`, env 4.7.1 без `NATS_URL`, метки `swag.kind/swarm/agent`), опубликовать `agent.launched`.
- Дождаться `agent.started` от всех агентов не дольше `agentStartMs`, затем отправить задачу `agent-1` от `user` и опубликовать `swarm.started`.
- Завершить рой: `agent.result` последнего агента → `swarm.completed`; `stop` → `swarm.stopped`; таймаут роя → `swarm.failed` (`swarm_timeout`). Везде: удалить песочницы, `agent.stopped` по каждому агенту, затем событие роя.
- `cleanupOrphans`: удалить песочницы платформы прошлого запуска.

## Что внутри сейчас

- `createOrchestratorCore(deps)` с портами `SandboxProvider`, `OrchestratorBus`, `Timers`, `Clock`, `IdGenerator`, `Logger` (`debug`/`info`/`warn`/`error` с `LogContext`), `TraceContext`.
- Логи по таблице 4.8 спеки 016: `info swarm launch`, `error sandbox create failed`, `error agent start timeout` (с `missing`), `error swarm timeout`, `info swarm finished` (со `status`), `warn sandbox remove failed`; невалидное событие шины — `warn event dropped`.
- Тесты: `test/orchestrator-core.test.ts` — AC-001-11, 13…18, AC-002-22, AC-016-5, AC-016-7; `apps/orchestrator/test` — AC-001-12.

## Ограничения

Правила ядра ([архитектура](../../docs/architecture.md), [спека 000, 4.2](../../docs/spec/000-foundation.md#42-правила-ядра-и-оболочки)):

- Зависимости — `zod`, `@swag/contracts`.
- Нет окружения и инфраструктуры. Шаблон песочницы — только из конфигурации; из запроса не принимается.
- Упавший агент (`agent.failed`) в 001 не отслеживается: рой завершится по таймауту (спека 008).

## Связи

- Оболочка: `apps/orchestrator`.
- Адаптеры: `@swag/adapter-docker` (песочницы), `@swag/adapter-nats` (шина).
- Использует: `@swag/contracts`.

## Ключевые решения

- Фазы роя внутри ядра: `creating` → `waiting` → `running` → `finished`. Переход в `running` делается до первого `await`, поэтому параллельные `agent.started` не отправят задачу дважды (T-6).
- Завершение — одна функция `finish`: песочницы → `agent.stopped` по всем агентам запуска → событие роя; повторный вызов ничего не делает (4.6.2).
- Песочница, созданная уже после `finish`, удаляется сразу (гонка остановки с созданием).
- `handleEvent` принимает `agent.result` только от последнего агента и только в `running`.
- Таймеры — порт; в тестах управляются вручную (AC-001-14, 17).
- `traceId` в конверте — из обязательного порта `TraceContext` в момент публикации (016, Q-1). Таймауты публикуют события в контексте запуска роя, потому что адаптер контекста (AsyncLocalStorage) переносит его в колбэки таймеров; события после `agent.started`/`agent.result` — в контексте сообщения шины. Ядро значение не разбирает.
- В логах только id, числа и перечисления, ошибка — в `err` (016, Q-4).
- Отклонение: `launch` ждёт создания всех песочниц до ответа (202 приходит после создания); при долгом Docker ответ `api` задерживается. Вынесено в журнал.

## Спеки

- 000 — заглушка.
- 001 — 4.6 (ядро и порядок запуска).
- 002 — AC-002-22: env песочниц роя не содержит ключей провайдеров и LiteLLM (тест на фейке `SandboxProvider`).
- 016 — порты `Logger` и `TraceContext`, логи 4.8.
- 005 — тёплый пул, лимиты, reaper; 007 — изоляция шины; 008 — устойчивость агента.
