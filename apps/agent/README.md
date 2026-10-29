# apps/agent

Оболочка агента: процесс в песочнице. Поднимает телеметрию, подключает `agent-core` к NATS, собирает модель через llm-gateway и пишет баннер запуска логом.

## Задачи

- Прочитать `AgentConfig` из env (спека 022, 4.8), подписаться на свой inbox, опубликовать `agent.started` и вести агентный цикл роя: ход по каждому входящему сообщению (спека 022, 4.4).
- Телеметрия до подключения к NATS; старт — в спане `agent.start` с родителем из `TRACEPARENT` (спека 016, 4.7).
- Ошибка конфигурации или подключения: `error`-лог `agent start failed` с `err`, сброс телеметрии, выход с кодом 1 (REQ-016-8).
- По `SIGTERM` закрыть соединение с NATS, сбросить телеметрию и выйти с кодом 0 (REQ-001-17).

## Что внутри сейчас

- `src/run.ts` — баннер: версия Node, версия агента, `agent ok`.
- `src/start.ts` — `startAgentProcess(deps)`: телеметрия, конфигурация, адаптер NATS, модель `createOpenAiChatModel` из `adapter-openai`, ядро `createAgentCore` и запуск в спане `agent.start`; зависимости (env, `startTelemetry`, `connect`, `exit`) внедряются.
- `src/main.ts` — сборка настоящих зависимостей и обработка `SIGTERM`.
- Тесты: `test/run.test.ts` (баннер), `test/start.test.ts` (AC-016-11 — NATS недоступен), `test/turn.test.ts` (AC-022-24 — два случая: успешный ход с маркерами и ошибка модели с `AGENT_LLM_MAX_RETRIES=0`).

## Ограничения

- Агент ходит в модель только через llm-gateway (`LLM_GATEWAY_URL`). Ключи провайдеров в песочнице не нужны и не передаются (спека 002).
- `LLM_GATEWAY_TOKEN` до 004 — общий токен gateway, он есть в песочнице (спека 022, 7). Токен не попадает в логи и тексты ошибок: `adapter-openai` заменяет его на `***`.
- Из переменных телеметрии агент получает только `TRACEPARENT` и `OTEL_EXPORTER_OTLP_ENDPOINT` (REQ-016-14).
- Уровень логов агента — `info`: `debug turn finished` из ядра в работе не выводится.
- Тексты задач, ответов модели и аргументы инструментов в логи и спаны не пишутся (REQ-022-13, спека 016 Q-4); в событиях платформы они есть.

## Связи

- Ядро: `@swag/agent-core`. Адаптеры: `@swag/adapter-nats`, `@swag/adapter-openai`, `@swag/adapter-telemetry`. Конфигурация: `@swag/config`.

## Ключевые решения

- Модель — `createOpenAiChatModel` (`adapter-openai`, 022, 4.3) с `baseUrl = LLM_GATEWAY_URL`, `caller = {swarmId, agentId}`, `timeoutMs = AGENT_LLM_TIMEOUT_MS`, `maxRetries = AGENT_LLM_MAX_RETRIES`. Оболочка не знает про OpenAI SDK, только про порт `ChatModel`.
- `traceparent` для вызова модели берётся из `telemetry.currentTraceparent()` (метод объекта `Telemetry`, в `trace`-контексте его нет). Так запрос к gateway попадает в тот же трейс, что и спан хода.
- Конфигурация 4.8 отображается в `AgentCoreDeps.config` без лишних полей: `peers` — из `AGENT_PEERS` (JSON `AgentPeer[]`), `entryAgentId` — из `AGENT_ENTRY`, `model` — из `AGENT_MODEL`. Эстафеты (`AGENT_NEXT`, `AGENT_STEP_DELAY_MS`, `timers`) в оболочке больше нет.
- Баннер `node/agent/agent ok` пишется до подключения к NATS: это старт процесса, а не готовность агента. Строки баннера — записи `info` схемы `LogRecord` (REQ-016-5).
- Переменные телеметрии и id агента разбираются отдельно от полной конфигурации (`AgentConfig.pick`): ошибка конфигурации тоже пишется логом с `swarmId`, `agentId` и `traceId`, если эти значения валидны.
- `agent start failed` пишется внутри спана `agent.start`, поэтому у записи `traceId` из `TRACEPARENT`; спан получает статус `ERROR`.
- Тест AC-016-11 — вызов `startAgentProcess` с внедрёнными зависимостями: настоящие `adapter-telemetry` и `adapter-nats` (NATS на закрытом порту), экспорт логов в память, `exit` — фейк.
- Тест AC-022-24 (`test/turn.test.ts`): модель — настоящий `adapter-openai` поверх локального HTTP-сервера, который отвечает фиксированным JSON (`content` с маркером и `send_message` с маркером в аргументах; `send_message` уступает ход, поэтому запрос к модели за ход один — спека 030). Выбран он, а не `infra/llm/fake-provider`: тому нужен `__tool_calls__` в тексте, а маркер в `content` ответа он не отдаёт. Шина — фейк `NatsBus`: `subscribeJson` оборачивает обработчик в `telemetry.inSpan` со спаном consumer по шаблону subject (атрибуты — `subjectAttributes` из `adapter-nats`, как в настоящем адаптере); исключение обработчика спан помечает ERROR. Шлюз проверяет заголовки `x-swag-swarm-id`, `x-swag-agent-id`, `authorization` и `traceparent` (trace-id совпадает со спаном хода). Маркеры и токен проверяются на прохождение (запрос модели, `agent.step`, сообщение агенту-2), затем — на отсутствие в логах, stdout и спанах (имя, атрибуты, события, статус, связи). Записей логов хода нет: ход пишет только `debug`, уровень агента — `info`.
- Образ агента `apps/agent/Dockerfile` собирается отдельно (`npm run agent:image`, профиль `agent`) и не стартует в `npm run up`.
- `SIGTERM` → закрытие NATS → сброс телеметрии → `exit(0)`.

## Спеки

- 000 — заглушка. 001 — 4.7, REQ-001-17. 002 — песочница не получает ключи провайдеров (AC-002-22 — в `orchestrator-core`). 016 — 4.7, REQ-016-8, AC-016-11. 022 — 4.4, 4.8, REQ-022-13, AC-022-24.
