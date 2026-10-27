# @swag/adapter-litellm

Адаптер LiteLLM для LLM Gateway (спека 002): порт `LlmUpstream` поверх `POST {LITELLM_URL}/v1/chat/completions` и `GET {LITELLM_URL}/v1/models` у LiteLLM Proxy. Реализованы `complete`, `stream`, `listModels`, таймаут простоя, `redact` и спан `litellm.chat` у `complete` и `stream`.

## Задачи

- `createLiteLlmUpstream(options)` — порт `LlmUpstream` (методы `complete`, `stream`, `listModels`): `Authorization: Bearer <masterKey>`, `traceparent` из активного контекста, разбор `2xx`, не-`2xx` (`message` из `error.message` или `HTTP <статус>`, обрезка до 1000 символов, затем `redact`), сеть недоступна или тело `2xx` не читается как JSON → `network`.
- `stream` — payload'ы SSE без префикса `data:`, включая `[DONE]` (он последний): отказ до первого фрагмента — как у `complete`; сбой после старта — `UpstreamStreamError` с `timeout`, `aborted` (внешний `signal`) или `network` (тело без `[DONE]`, обрыв сети).
- Таймаут простоя (REQ-002-10): простой — ожидание куска от апстрима дольше `idleTimeoutMs` → `timeout`; пауза потребителя между payload'ами в простой не входит. Для `complete` внешний `signal` прерван → `network`.
- `listModels` — `{ data: [{ id }] }` → `ids`; другая форма ответа → `network` (D-50).
- `redact(text, secrets)` — замена каждого вхождения секрета на `***`; пустые строки в `secrets` игнорируются (REQ-002-11).
- Спан `litellm.chat` (вид `client`) у `complete` и `stream`: `gen_ai.request.model`, `swag.llm.stream`, `http.response.status_code` (если пришли заголовки ответа), `gen_ai.usage.input_tokens` и `gen_ai.usage.output_tokens` (если есть `usage`). Тела запроса и ответа в атрибуты не попадают.

## Что внутри сейчас

- `src/index.ts` — `LiteLlmOptions`, `redact`, `sseData`, `createLiteLlmUpstream`; внутри — `idleGuard` (таймер и `AbortSignal.any`), `textChunks` (тело куском за куском, отмена при раннем выходе), `open` и `readWhole` (общий путь запроса для `complete`, `stream` и `listModels`), `callUpstream` (без потока), `payloads` (генератор потока), `startChatSpan` и `observeStream` (спан `litellm.chat`).
- `test/complete.test.ts` — обычный ответ и заголовок `Authorization`, `__fail_400__` / `__fail_500__` / `__fail_429__`, недоступный порт, `traceparent` у спана `litellm.chat` (дочерний к спану вызывающего, в `startTelemetry`), `redact` (AC-002-17); через подставной `fetch`: `2xx` с не-JSON телом → `network` (D-49), не-`2xx` без JSON → `HTTP <статус>`, обрезка `message` до 1000 и `redact` (D-48).
- `test/span.test.ts` — спан `litellm.chat` в in-memory экспортёре: атрибуты у `complete` и `stream` (usage из фрагмента), без usage, конец спана при раннем выходе из потока, статус `500` и сетевой отказ (без `http.response.status_code`), обрыв потока после старта (`__cut__`) — `ERROR` без usage; в спанах всех видов (не только `litellm.chat`) нет текста сообщений. Без AC-id.
- `test/idle-timeout.test.ts` — `__hang__` при `idleTimeoutMs` 200 → `timeout` за 200–1000 мс; таймер перезапускается на каждом куске тела; внешний abort → `network`; `listModels` с зависшим сервером. Без AC-id (AC-002-16 про ответ шлюза).
- `test/list-models.test.ts` — `listModels` на фейке, путь и `Authorization`, `http`, `2xx` не по форме (D-50).
- `test/helpers.ts` — общие `MASTER_KEY`, `upstreamFor`, `chatRequest`, `stubFetch` и `useFake` (подъём и закрытие фейка) для тестов пакета; vitest его не запускает (`**/*.test.ts`), `tsconfig.dev.json` типизирует.
- `test/stream.test.ts` — `stream` на фейке: payload'ы по умолчанию и с `include_usage`, `__cut__`, `__slow_chunks__` при `idleTimeoutMs` 200 (с проверкой, что фейк видит закрытие соединения клиентом), внешний abort, ранний выход потребителя закрывает соединение, пауза потребителя дольше `idleTimeoutMs` не даёт `timeout`, не-2xx; тело без `[DONE]` и символ UTF-8, разрезанный между кусками тела (через подставной `fetch`); юнит-тесты `sseData` (многострочный `data:`, комментарий `:`, `\r\n`). Без AC-id: AC-002-10…13 описывают ответ шлюза (T-17…T-23).
- `test/fake-provider.test.ts` — тесты фейкового провайдера из `infra/llm/fake-provider/server.ts` (спека 002, 4.12): без потока и с потоком.

## Ограничения

- Фейк не проверяет модели.
- Спан потока заканчивается, когда генератор закончился. Если потребитель не начал итерацию, спан остаётся открытым (D-54).
- Спана у `listModels` нет: 4.5 задаёт спан только для чата.

## Связи

- Порт и типы: `LlmUpstream`, `UpstreamFailure`, `UpstreamModels`, `UpstreamStream` и класс `UpstreamStreamError` из `@swag/llm-gateway-core`.
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
- Спан `litellm.chat` создаётся внутри `complete` и `stream`, его контекст активен при инжекте `traceparent`: заголовок несёт контекст самого спана, а не внешнего (поправлен тест `traceparent` из T-9). Статус `ERROR` при любом отказе, включая `http` с любым статусом и `aborted`; `usage` потока адаптер берёт из фрагмента с `usage` тем же `parseUsage`, что ядро (D-54).
- Ответы не-`2xx` без JSON-тела — `message` `HTTP <статус>`.
- Поток: `sseData` склеивает строки `data:` через `\n`, один ведущий пробел убирается, `\r\n` поддержан, одиночный `\r` — нет; незавершённое событие на конце тела отбрасывается (D-52).
- Таймер простоя в потоке: до заголовков — как у `complete`; после заголовков таймер снимается до первого `next()`. Дальше он взводится перед каждым ожиданием куска от апстрима и снимается, как только кусок пришёл. Пауза потребителя между payload'ами в простой не входит: простой — ожидание куска от апстрима.
- Раннее закрытие потребителя (`return()` генератора, `break` в `for await`) и `throw()` отменяют чтение тела (`reader.cancel()`) и снимают таймер через `finally`: соединение с LiteLLM закрывается. `throw()` потребителя не превращается в `UpstreamStreamError`: `yield` стоит вне `try`.
- Отказ до потока при уже прерванном внешнем `signal` или abort до заголовков — `network`, как у `complete`, а не `aborted`; ядро проверяет `signal.aborted` само (D-53).
- Тесты фейка лежат в этом пакете, потому что фейк нужен адаптеру (4.12), а `infra/llm/fake-provider` — не пакет.

## Спеки

- 002 — 4.4, 4.5, 4.12, 4.14; T-7, T-8, T-9, T-10, T-11, T-12; REQ-002-10, REQ-002-11, REQ-002-14 (спан), AC-002-17.
