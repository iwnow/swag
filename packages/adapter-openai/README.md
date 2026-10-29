# @swag/adapter-openai

Порт `ChatModel` из `@swag/agent-core` поверх OpenAI SDK (спека 022, 4.3): один вызов `chat.completions.create` в `llm-gateway`. Адаптер ходит только в шлюз (`LLM_GATEWAY_URL`), ключей провайдеров не знает.

## Задачи

- `createOpenAiChatModel(options)` — `ChatModel` с методом `complete`: собирает запрос из `ChatModelRequest` (`tools` идут в запрос только если непустые, `max_tokens`, `stream: false`), возвращает `ChatModelResult`.
- Заголовки: `x-swag-swarm-id` и `x-swag-agent-id` из `caller` (через `defaultHeaders`), `traceparent` на каждый вызов из `options.traceparent()` (если `null` — заголовка нет).
- Ошибки: все отказы возвращаются как `ok: false`, `complete` не бросает. Коды — по 4.3: `timeout`, `network`, код шлюза из тела, `invalid_response` при пустом `choices`, `max_tokens` при `finish_reason: 'length'`.

## Что внутри сейчас

- `src/index.ts` — `OpenAiChatModelOptions`, `createOpenAiChatModel`; внутри — `toolCalls` (ответ → `ToolCall[]`), `errorCode` (ошибка SDK → `ChatModelErrorCode`), `redact` (токен в `message` заменяется на `***`).
- `test/chat-model.test.ts` — AC-022-19 и ветки кодов: запрос к `startFakeProvider` (путь, `authorization`, заголовки вызывающего, `traceparent`, тело, `tool_calls` из маркера), без `traceparent`, `rate_limited`, `model_not_found` с редактированием токена, `network`, `timeout`, `upstream_error`, `invalid_response`, `max_tokens` (обрезка с `content` и с `tool_calls`, подставной HTTP-сервер).

## Ключевые решения

- SDK: `openai` 7.33.0 (точная версия) — последняя стабильная, опубликованная не позже 2026-10-14 (за 2 недели до реализации 2026-10-28), по 4.3.
- Повторы — встроенные в SDK (`maxRetries`, Q-4); тесты используют `maxRetries: 0`, чтобы код ошибки был виден сразу.
- `APIConnectionTimeoutError` проверяется раньше `APIConnectionError` (наследник), `APIError` — последним.
- Код ошибки: `error.code` тела, если он в `GatewayErrorCode`. Без такого кода: HTTP `429` → `rate_limited`, прочее → `upstream_error`. Отступление от буквы 4.3, нужное для AC-022-19: фейк отдаёт `429` без `code`.
- `tool_calls` с типом, отличным от `function`, отбрасываются: порт описывает только function-вызовы.
- Исключение, не похожее на ошибку SDK (например, сбой разбора ответа), переводится в `invalid_response`, чтобы `complete` не бросал.
- Токен не попадает в `message`: все вхождения заменяются на `***`; пустой токен не редактируется (иначе `***` вставлялся бы между всеми символами).
- Тест `model_not_found` идёт на подставной HTTP-сервер в самом тесте: фейк кодов в теле не отдаёт.
- `finish_reason: 'length'` — ошибка `max_tokens` до разбора содержимого: обрезанный ответ неполон и с текстом, и с `tool_calls`, поэтому ни текст, ни вызовы не отдаются в цикл (решение приёмки D-85, 4.3). Сообщение называет лимит `request.maxTokens`.

## Ограничения

- Только обычный ответ (`stream: false`), поток — по Q-4 не делается.
- Не сохраняет историю и не знает о рое; таймаут и число повторов приходят снаружи (`AGENT_LLM_TIMEOUT_MS`, `AGENT_LLM_MAX_RETRIES` — T-9, T-10).

## Связи

- Порт и типы: `ChatModel`, `ChatModelRequest`, `ChatModelResult`, `ChatModelErrorCode`, `ChatMessage`, `ToolCall`, `ToolDefinition` из `@swag/agent-core`.
- Контракты: `GatewayErrorCode`, `LlmCaller`, имена заголовков из `@swag/contracts`.
- Оболочка: `apps/agent` (T-10) собирает адаптер и передаёт `currentTraceparent` из `@swag/adapter-telemetry`.
- Фейк: `infra/llm/fake-provider/server.ts` (правила 4.7 спеки 022, профиль `test`).

## Спеки

- 022 — 4.2 (порт), 4.3 (адаптер), REQ-022-9, AC-022-19 (T-8).
