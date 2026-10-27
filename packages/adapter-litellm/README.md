# @swag/adapter-litellm

Адаптер LiteLLM для LLM Gateway (спека 002): порт `LlmUpstream` поверх `POST {LITELLM_URL}/v1/chat/completions` и `GET {LITELLM_URL}/v1/models` у LiteLLM Proxy. Реализованы `complete`, `listModels`, таймаут простоя и `redact`; поток — T-11, спан `litellm.chat` — T-12.

## Задачи

- `createLiteLlmUpstream(options)` — порт `LlmUpstream` (методы `complete` и `listModels`): `Authorization: Bearer <masterKey>`, `traceparent` из активного контекста, разбор `2xx`, не-`2xx` (`message` из `error.message` или `HTTP <статус>`, обрезка до 1000 символов, затем `redact`), сеть недоступна или тело `2xx` не читается как JSON → `network`.
- Таймаут простоя (REQ-002-10): нет куска тела дольше `idleTimeoutMs` → `timeout`; внешний `signal` прерван → `network`.
- `listModels` — `{ data: [{ id }] }` → `ids`; другая форма ответа → `network` (D-50).
- `redact(text, secrets)` — замена каждого вхождения секрета на `***`; пустые строки в `secrets` игнорируются (REQ-002-11).

## Что внутри сейчас

- `src/index.ts` — `LiteLlmOptions`, `redact`, `createLiteLlmUpstream`; внутри — `idleGuard` (таймер и `AbortSignal.any`), `readText` (тело куском за куском), `callUpstream` (общий путь `complete` и `listModels`).
- `test/complete.test.ts` — обычный ответ и заголовок `Authorization`, `__fail_400__` / `__fail_500__` / `__fail_429__`, недоступный порт, `traceparent` в спане `startTelemetry`, `redact` (AC-002-17); через подставной `fetch`: `2xx` с не-JSON телом → `network` (D-49), не-`2xx` без JSON → `HTTP <статус>`, обрезка `message` до 1000 и `redact` (D-48).
- `test/idle-timeout.test.ts` — `__hang__` при `idleTimeoutMs` 200 → `timeout` за 200–1000 мс; таймер перезапускается на каждом куске тела; внешний abort → `network`; `listModels` с зависшим сервером. Без AC-id (AC-002-16 про ответ шлюза).
- `test/list-models.test.ts` — `listModels` на фейке, путь и `Authorization`, `http`, `2xx` не по форме (D-50).
- `test/helpers.ts` — общие `MASTER_KEY`, `upstreamFor`, `chatRequest`, `stubFetch` и `useFake` (подъём и закрытие фейка) для тестов пакета; vitest его не запускает (`**/*.test.ts`), `tsconfig.dev.json` типизирует.
- `test/fake-provider.test.ts` — тесты фейкового провайдера из `infra/llm/fake-provider/server.ts` (спека 002, 4.12): без потока и с потоком.

## Ограничения

- Спан `litellm.chat` не создаётся (T-12).
- Поток (`stream`) не реализован (T-11).
- Фейк не проверяет модели.

## Связи

- Порт и типы отказа: `LlmUpstream`, `UpstreamFailure`, `UpstreamModels` из `@swag/llm-gateway-core`.
- Трассировка: глобальный пропагатор из `@swag/adapter-telemetry` (ставит `startTelemetry`); в тестах — `@swag/adapter-telemetry` как devDependency.
- Оболочка: `apps/llm-gateway` (спека 002, T-20).
- Фейк: `infra/llm/fake-provider/server.ts`, профиль `test` в compose.

## Ключевые решения

- Трассировка — через `propagation.inject` из `@opentelemetry/api`, как в `adapter-nats`: без зарегистрированного SDK заголовка нет, код не зависит от `adapter-telemetry`. `adapter-telemetry` — devDependency (нужен тестам). Отклонение от 4.14, где он указан как зависимость.
- `redact` вызывается после обрезки до 1000 символов, как в 4.5. Риск частичного секрета на границе обрезки — D-48 в `docs/spec/questions.md`.
- Тело `2xx`, которое не читается как JSON, — `network` (4.5 этого случая не описывает; `UpstreamFailure` не знает «плохой ответ»; D-49). Ядро переведёт в `upstream_error` (502).
- Таймер простоя взводится до запроса (нет ни байта дольше `idleTimeoutMs` — тоже таймаут) и перезапускается на каждом куске тела, любого статуса. Тело читается через `getReader`, а не `res.json()`, иначе перезапуск по кускам невозможен. Срабатывание во время чтения тела не-2xx даёт `timeout`, а не `http` (D-51).
- Получение заголовков таймер не перезапускает: он взведён с момента вызова `fetch`, перезапуск — только на кусках тела (буква 4.5).
- Внешний `signal` и таймер объединяются в `AbortSignal.any`; таймер отменяет свой контроллер с маркером `TIMEOUT_REASON`, и `callUpstream` по `reason` сигнала отличает таймаут от внешнего abort.
- Тип сигнала в порте — структурный, см. D-47.
- Ответы не-`2xx` без JSON-тела — `message` `HTTP <статус>`.
- Тесты фейка лежат в этом пакете, потому что фейк нужен адаптеру (4.12), а `infra/llm/fake-provider` — не пакет.

## Спеки

- 002 — 4.4, 4.5, 4.12, 4.14; T-7, T-8, T-9, T-10; REQ-002-10 (без потока), REQ-002-11, AC-002-17.
