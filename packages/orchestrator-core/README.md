# @swag/orchestrator-core

Ядро оркестратора: исполнение роя — песочница на агента, ожидание готовности, передача задачи, завершение и падение роя по агенту-входу, остановка, таймауты и уборка. Чистый TypeScript, без Docker и NATS: это делают адаптеры портов.

## Задачи

- `launch`: проверить `SwarmLaunch` строгой схемой, зарегистрировать рой в gateway (`llmSwarms.register`: бюджеты роя и агентов, `expiresAt` = часы + `swarmMs` + 60 с, при `swarmMs` 0 — `null`) до первой песочницы; сбой регистрации — `swarm.failed` `gateway_unavailable`, песочниц нет. Затем создать песочницу на агента (`AGENT_TEMPLATE`, env по 4.8 спеки 022, метки `swag.kind/swarm/agent`), опубликовать `agent.launched`.
- Дождаться `agent.started` от всех агентов не дольше `agentStartMs`, затем отправить задачу `agent-1` от `user` и опубликовать `swarm.started`.
- Завершить рой (4.9 спеки 022):
  - `agent.result` агента-входа (`ENTRY_AGENT_ID`) в `running` → `swarm.completed`; `agent.result` других агентов игнорируется;
  - `agent.failed` любого агента в `running` → `swarm.failed` с `reason: agent_failed`, `detail: "<agentId>: <reason>"`; причина `model_error:swarm_budget_exceeded` или `model_error:agent_budget_exceeded` → `swarm.failed` с `reason: budget_exceeded`, `detail: "<agentId>: <код>"` (004, 4.6);
  - `stop` → `swarm.stopped`; таймаут роя → `swarm.failed` (`swarm_timeout`).
    Везде: удалить песочницы, `agent.stopped` по каждому агенту, `llmSwarms.close` (сбой — лог `warn gateway_close_failed`, рой завершается), затем событие роя. Число из `close` (`spentMicroUsd`, 013, 4.6) попадает в `data` события роя; `null` (404) или сбой — поля нет.
- `cleanupOrphans`: удалить песочницы платформы прошлого запуска, в том числе песочницы узлов (`swag.kind=node`, 026, 4.10).
- `invokeNode(invocation)` (спека 026, 4.10): один вызов узла. Шаг 1 — проверки реестра до песочницы (тип, вид, вид вызова, операция, настройки, вход, набор `credentials`, секреты организации); далее песочница с метками, кадр `invoke` с секретами только из `credentials` манифеста, чтение кадров по 4.8, `abort` по дедлайну и грейсу, проверка выхода по схемам манифеста, `remove` в `finally`, вымарывание значений секретов в `msg`, ключах и значениях `data` и в сообщениях ошибок результата (до обрезки), лог `info node invoke` (пишется и при исключении, с `ok:false`). Код — `src/node-invoke.ts`, фабрика `createInvokeNode`.

## Что внутри сейчас

- `createOrchestratorCore(deps)` с портами `SandboxProvider`, `OrchestratorBus`, `Timers`, `Clock`, `IdGenerator`, `Logger` (`debug`/`info`/`warn`/`error` с `LogContext`), `TraceContext`.
- Порты узлов (спека 026, 4.5, 4.9, 4.10): `SecretReader` (`read(orgId, names)` — только найденные имена), `NodeStateStore` (`get`, `set` с `null` как удалением) и `NodeSandboxes` (`run`, `remove`, `list`; типы `NodeSandboxSpec`, `NodeSandboxSession`). Реализации — `createPostgresSecretStore`, `createPostgresNodeState` в `adapter-postgres` и `createDockerNodeSandboxes` в `adapter-docker`.
- Зависимости вызова узла — `NodeInvokeDeps` (`nodes`, `nodeSandboxes`, `secrets`, `nodeState`, `egressGrants`, `node`), входят в `OrchestratorCoreDeps`. `invokeNode` возвращает результат с кодом; исключение бросает только сбой чтения секретов (D-168): до броска пишутся `error node secrets read failed` и `info node invoke` с `ok:false`.
- Тесты узлов: `test/invoke-node.test.ts` — AC-026-12…17, AC-026-23 (проверки реестра, метки и шаблон песочницы, кадры и байты, `sandbox_failed`, сбой `remove`, выходы по схемам, `abort` в дедлайн, вымарывание); фейки портов узлов, ручные таймеры и часы, которые двигает `run` — `test/node-fakes.ts`.
- `deps.agent` — `{ template, maxSteps, maxTokens, llmGatewayToken, flushTimeoutMs }`: значения env агента, которые ставит ядро. `maxTokens` — умолчание `AGENT_MAX_TOKENS` оркестратора, используется, когда у агента и роя лимита нет (031, 4.4).
- Порт `LlmSwarms` (`register`, `close: Promise<number | null>`) — `deps.llmSwarms`; реализация — `@swag/adapter-gateway-http`.
- Env песочницы агента (4.8): `SWARM_ID`, `AGENT_ID`, `AGENT_NAME`, `AGENT_ROLE`, `AGENT_MODEL`, `AGENT_PEERS` (JSON `{id,name,role}` остальных агентов роя), `AGENT_ENTRY`, `AGENT_MAX_STEPS`, `AGENT_MAX_TOKENS` (031, 4.4: `maxTokens` агента, иначе роя, иначе `deps.agent.maxTokens`), `LLM_GATEWAY_TOKEN`, `TELEMETRY_FLUSH_TIMEOUT_MS`. Адресов NATS, OTLP и gateway ядро не знает — их добавляет адаптер.
- Логи по таблице 4.8 спеки 016: `info swarm launch`, `error sandbox create failed`, `error agent start timeout` (с `missing`), `error swarm timeout`, `info swarm finished` (со `status`), `warn sandbox remove failed`, `warn gateway_close_failed`; невалидное событие шины — `warn event dropped`.
- Тесты: `test/orchestrator-core.test.ts` — AC-000-16, AC-001-11…18 (AC-001-11 и AC-001-15 переписаны под 4.9; AC-001-12 — также в `apps/orchestrator/test`), AC-022-17, AC-022-18, AC-002-22, AC-016-5, AC-016-7, AC-004-21…24, AC-013-19 (`spentMicroUsd` в итоговых событиях; сбой и `null` — без поля), AC-004-33 (токен шлюза не попадает в логи, события и сообщения шины при `launch` и `stop`; токен в env песочниц проверяется отдельно), AC-031-4 (`AGENT_MAX_TOKENS`: агент → рой → умолчание). Фейк `LlmSwarms` по умолчанию успешен, `close` отдаёт `null`; `closeSpent` — число для `spentMicroUsd`; `registerError` и `closeError` — для сбоев.

## Ограничения

Правила ядра ([архитектура](../../docs/architecture.md), [спека 000, 4.2](../../docs/spec/000-foundation.md#42-правила-ядра-и-оболочки)):

- Зависимости — `@swag/contracts`, `@swag/api-integration` (тип реестра узлов), `zod` (форма выхода `poll`).
- Нет окружения и инфраструктуры. Шаблон песочницы и значения env приходят через `deps`; из запроса не принимаются.
- `agent.failed` отслеживается только в `running`. Падение агента до старта роя завершает рой по таймаутам.
- `TRACEPARENT` ядро не ставит: порт `TraceContext` отдаёт только `traceId`, см. решения.

## Связи

- Оболочка: `apps/orchestrator`.
- Адаптеры: `@swag/adapter-docker` (песочницы, добавляет `NATS_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `LLM_GATEWAY_URL`, `TRACEPARENT`), `@swag/adapter-nats` (шина).
- Использует: `@swag/contracts` (`ENTRY_AGENT_ID`, `SwarmLaunch`, `AgentSpec`, события).

## Ключевые решения

- Фазы роя внутри ядра: `creating` → `waiting` → `running` → `finished`. Переход в `running` делается до первого `await`, поэтому параллельные `agent.started` не отправят задачу дважды (T-6).
- Завершение — одна функция `finish`: песочницы → `agent.stopped` по всем агентам запуска → событие роя; повторный вызов ничего не делает (4.6.2).
- Песочница, созданная уже после `finish`, удаляется сразу (гонка остановки с созданием).
- Длина кадра в байтах UTF-8 считается функцией без `Buffer` и `TextEncoder`: этих типов нет в `lib` ядра (D-167). `arch:check` проверяет только импорты, глобалы он не видит.
- Таймауты вызова узла — порт `Timers`: `abort` уходит ровно в `deadline` по часам ядра, задержка `max(0, deadline - now)`, а не через `timeoutMs` после старта таймера (часы могут уйти вперёд во время `run`); сбой отправки `abort` пишется `warn node abort send failed`, грейс-таймер всё равно ставится; по истечении `abortGraceMs` — `timeout`; `result` в грейсе принимается (AC-026-15).
- Кадры после первого `result` не читаются и не дают `protocol_error`: результат уже принят (D-173).
- Строка кадра, которую оболочка песочницы не смогла разбить по лимиту, приходит маркером и даёт `protocol_error` (D-172).
- Лимиты состояния 4.5 считаются по `length` строки; `state.set` с `null` удаляет ключ (AC-026-17).
- `cleanupOrphans` удаляет сначала песочницы узлов, затем агентские: агентская выборка по `swag.kind` в Docker их уже не видит, счёт без двойного учёта (D-169).
- Итог роя — только от агента-входа (022, 4.9, Q-3). Ответы остальных агентов ядро не учитывает: их ждёт агент-вход через `agent-core`.
- Падение любого агента в `running` — `swarm.failed` с `agent_failed` (022, Q-3); `detail` — `"<agentId>: <reason>"` буквально из 4.9.
- Отказ по бюджету (`model_error:*_budget_exceeded` из gateway) — `swarm.failed` `budget_exceeded` (004, 4.6, REQ-004-16); остальные `model_error:<код>` остаются `agent_failed`.
- Регистрация до песочниц: `register` вызывается после `swarm_exists` и до таймеров роя; при сбое таймеров нет, `finish` сразу отдаёт `swarm.failed` `gateway_unavailable`. `finish` вызывает `close` и при этом сбое регистрации (D-98).
- `stop` или таймаут во время `register`: `finish` уже закрыл рой, поэтому после успешной регистрации `launch` закрывает его ещё раз и выходит без таймеров и песочниц (ответ gateway мог прийти после закрытия).
- Env песочницы строится из `AgentSpec`: `AGENT_MODEL` — модель из плана, `AGENT_PEERS` — все агенты роя кроме самого агента. Ключи провайдеров, `LITELLM_MASTER_KEY` и эстафета (`AGENT_NEXT`, `AGENT_STEP_DELAY_MS`) в env не попадают (022, 4.8).
- `TRACEPARENT` не в env ядра: 016 (AC-016-10) оставляет его адаптеру Docker, а порт `TraceContext` не даёт текущий traceparent. Противоречие 4.8 и 016 вынесено в D-83 `questions.md`.
- `handleEvent` принимает `agent.result` только в `running`, `agent.failed` — тоже только в `running`.
- Таймеры — порт; в тестах управляются вручную (AC-001-14, 17).
- `traceId` в конверте — из обязательного порта `TraceContext` в момент публикации (016, Q-1). Таймауты публикуют события в контексте запуска роя, потому что адаптер контекста (AsyncLocalStorage) переносит его в колбэки таймеров; события после `agent.started`/`agent.result` — в контексте сообщения шины. Ядро значение не разбирает.
- В логах только id, числа и перечисления, ошибка — в `err` (016, Q-4).
- Отклонение: `launch` ждёт создания всех песочниц до ответа (202 приходит после создания); при долгом Docker ответ `api` задерживается. Вынесено в журнал.

## Спеки

- 000 — заглушка.
- 004 — 4.6 (регистрация и закрытие роя в gateway, причины `budget_exceeded` и `gateway_unavailable`); REQ-004-3, REQ-004-15, REQ-004-16, AC-004-21…24.
- 001 — 4.6 (ядро и порядок запуска); AC-001-11 и AC-001-15 — по 022 (текст 001 обновлён в T-16).
- 002 — AC-002-22: env песочниц роя не содержит ключей провайдеров и LiteLLM (тест на фейке `SandboxProvider`).
- 016 — порты `Logger` и `TraceContext`, логи 4.8.
- 022 — 4.8 (env агента), 4.9 (завершение и падение роя), REQ-022-10, REQ-022-11, AC-022-17, AC-022-18.
- 031 — 4.4 (выбор `AGENT_MAX_TOKENS` агента: агент → рой → умолчание оркестратора); REQ-031-4, AC-031-4.
- 026 — 4.9 (порт `NodeSandboxes`), 4.10 (`invokeNode`, `cleanupOrphans`); REQ-026-1…5, REQ-026-9…12, AC-026-12…17, AC-026-23.
- 005 — тёплый пул, лимиты, reaper; 007 — изоляция шины; 008 — устойчивость агента.
