# @swag/adapter-litellm

Адаптер LiteLLM для LLM Gateway (спека 002): порт `LlmUpstream` поверх `POST {LITELLM_URL}/v1/chat/completions` у LiteLLM Proxy. Сейчас реализован обычный вызов `complete` и `redact`; таймаут простоя, `listModels` и поток — следующие задачи спеки 002 (T-10, T-11, T-12 для спана).

## Задачи

- `createLiteLlmUpstream(options)` — порт `LlmUpstream` (сейчас метод `complete`): `Authorization: Bearer <masterKey>`, `traceparent` из активного контекста, разбор `2xx`, не-`2xx` (`message` из `error.message` или `HTTP <статус>`, обрезка до 1000 символов, затем `redact`), сеть недоступна или тело `2xx` не читается как JSON → `network`.
- `redact(text, secrets)` — замена каждого вхождения секрета на `***`; пустые строки в `secrets` игнорируются (REQ-002-11).

## Что внутри сейчас

- `src/index.ts` — `LiteLlmOptions`, `redact`, `createLiteLlmUpstream`.
- `test/complete.test.ts` — обычный ответ и заголовок `Authorization`, `__fail_400__` / `__fail_500__` / `__fail_429__`, недоступный порт, `traceparent` в спане `startTelemetry`, `redact` (AC-002-17); через подставной `fetch`: `2xx` с не-JSON телом → `network` (D-49), не-`2xx` без JSON → `HTTP <статус>`, обрезка `message` до 1000 и `redact` (D-48).
- `test/fake-provider.test.ts` — тесты фейкового провайдера из `infra/llm/fake-provider/server.ts` (спека 002, 4.12): без потока и с потоком.

## Ограничения

- Таймаут простоя не реализован: `idleTimeoutMs` принимается, но не используется до T-10 (`complete` ждёт ответ без ограничения).
- Внешний `signal` передаётся в `fetch`; его прерывание сейчас даёт `network` через общий `catch`.
- Спан `litellm.chat` не создаётся (T-12).
- Фейк не проверяет модели.

## Связи

- Порт и типы отказа: `LlmUpstream`, `UpstreamFailure` из `@swag/llm-gateway-core`.
- Трассировка: глобальный пропагатор из `@swag/adapter-telemetry` (ставит `startTelemetry`); в тестах — `@swag/adapter-telemetry` как devDependency.
- Оболочка: `apps/llm-gateway` (спека 002, T-20).
- Фейк: `infra/llm/fake-provider/server.ts`, профиль `test` в compose.

## Ключевые решения

- Трассировка — через `propagation.inject` из `@opentelemetry/api`, как в `adapter-nats`: без зарегистрированного SDK заголовка нет, код не зависит от `adapter-telemetry`. `adapter-telemetry` — devDependency (нужен тестам). Отклонение от 4.14, где он указан как зависимость.
- `redact` вызывается после обрезки до 1000 символов, как в 4.5. Риск частичного секрета на границе обрезки — D-48 в `docs/spec/questions.md`.
- Тело `2xx`, которое не читается как JSON, — `network` (4.5 этого случая не описывает; `UpstreamFailure` не знает «плохой ответ»; D-49). Ядро переведёт в `upstream_error` (502).
- Тип сигнала в порте — структурный, см. D-47.
- Ответы не-`2xx` без JSON-тела — `message` `HTTP <статус>`.
- Тесты фейка лежат в этом пакете, потому что фейк нужен адаптеру (4.12), а `infra/llm/fake-provider` — не пакет.

## Спеки

- 002 — 4.4, 4.5, 4.12, 4.14; T-7, T-8, T-9; REQ-002-11, AC-002-17.
