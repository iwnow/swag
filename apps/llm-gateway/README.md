# @swag/llm-gateway

Оболочка LLM Gateway (спека 002): Fastify-процесс. Читает конфигурацию и каталог моделей, собирает адаптеры LiteLLM и NATS, вызывает фабрику ядра `createLlmGatewayCore` и на старте сверяет каталог с апстримом. Решений здесь нет: логика живёт в `packages/llm-gateway-core`.

## Задачи

- Старт: конфигурация `LlmGatewayConfig` (env, `@swag/config`), каталог моделей из `LLM_CATALOG_PATH` (`readCatalog`, схема `ModelCatalog`), секреты адаптера (`upstreamSecrets`), адаптер LiteLLM (`createLiteLlmUpstream`), шина NATS для события `llm.call` в `swarm.<swarmId>.events`.
- Сверка при старте (REQ-002-13): `checkUpstream` повторяется раз в 1 с до `LLM_GATEWAY_STARTUP_TIMEOUT_MS`. Пока сверка не прошла, порт не слушается.
  - Модели каталога не хватает → `error` `upstream_models_mismatch` с `missing`, выход с кодом 1.
  - Апстрим не ответил → `error` `upstream_unavailable` с `reason`, выход с кодом 1 (D-64).
- `GET /health` → `200 { status: 'ok', service: 'llm-gateway', version }`.

## Что внутри сейчас

- `src/main.ts` — телеметрия (`startTelemetry`, сервис `llm-gateway`), конфигурация, каталог, NATS, адаптер, ядро, запуск, остановка по `SIGINT`/`SIGTERM`. Слушает `0.0.0.0` внутри контейнера.
- `src/start.ts` — `startGateway` (сверка, затем `listen`, либо выход 1), `waitForUpstream` (повтор раз в 1 с до таймаута), `upstreamSecrets`.
- `src/catalog.ts` — `readCatalog`: читает файл и проверяет его схемой `ModelCatalog`.
- `src/app.ts` — `buildApp(core, { token, bodyLimitBytes })`: Fastify с `GET /health` (без токена), `GET /v1/models` и `POST /v1/chat/completions` за проверкой токена в `onRequest`; заголовки вызывающего и тело уходят в ядро как есть; отказ ядра — статус и тело по 4.2; `kind: 'json'` отвечает `200` с телом ядра как есть; `kind: 'stream'` пишет SSE (`writeStream`: `200`, `content-type: text/event-stream`, `cache-control: no-cache`, каждый фрагмент — `data: <payload>\n\n` сразу после получения, `reply.hijack()` и `reply.raw`); вызов отменяется, если клиент ушёл до ответа; ошибка разбора тела (больше `bodyLimitBytes` — `413`, не JSON — `400`) — тело по 4.2 с `code: 'invalid_request'` (D-65).
- `test/routes.test.ts` — тесты на фейке через `app.inject`:
  - отказы до ядра: AC-002-2 (`401` без токена, с чужим и с токеном другой длины), AC-002-3 (`400 invalid_caller`), AC-002-4 (`model_not_found`), AC-002-5 (`invalid_request`: нет `messages`, пустой, тело-массив), AC-002-6 (`/v1/models`), AC-002-28 (поля провайдера в теле), тело больше лимита → `413`, валидный вызов доходит до фейка с телом;
  - ответ JSON: AC-002-1 (без потока с `tools`, `tool_choice`, `temperature`: `200`, тело как у фейка, фейк получил тело как отправлено), AC-002-9 (одно `llm.call` в шине с `traceId`, проходит `PlatformEventInput`), AC-002-14 (без `usage`: событие с `usage: null`, `warn` `usage_missing`), AC-002-15 без потока (`502 upstream_error`, `429 rate_limited`, `400 upstream_bad_request`), AC-002-16 (таймаут простоя 200 мс: `504 upstream_timeout`);
  - без AC-id: обычный вызов по сети (не `inject`) — `200`; клиент ушёл до ответа — отмена вызова апстрима.
  - Во всех отказах фейк не вызван и событий нет. События уходят в шину в памяти (`createMemoryBus` в `test/support.ts`) и читаются подпиской.
- `test/stream.test.ts` — поток по сети (`listen` на `127.0.0.1`, `fetch`, не `inject`): AC-002-10 (заголовки SSE, фрагменты, `usage`, `[DONE]`, событие `ok`), AC-002-11 (первый фрагмент раньше 300 мс, поток не раньше 500 мс), AC-002-12 (обрыв апстрима: `{"error":...}` последним, без `[DONE]`, событие `aborted` с `errorCode`), AC-002-13 (клиент рвёт соединение после первого фрагмента: фейк видит `closedByClient` за 1 с, событие `aborted` без `errorCode`, следующий вызов — `200`), AC-002-15 потоком (отказ до первого фрагмента — обычный JSON с кодом по 4.6).
- `test/start.test.ts` — AC-002-18 (в апстриме нет `chat-large`: порт не слушает, `upstream_models_mismatch` с `missing`, выход 1; полный список: `/health` → `200`), D-64 (апстрим недоступен: `upstream_unavailable`), REQ-002-13 (висящая сверка прерывается по дедлайну; первая сверка `missing`, вторая ок: порт до второй попытки не слушает), повтор сверки, `upstreamSecrets`, `readCatalog` (битый JSON и нарушение схемы: путь файла в сообщении, причина в `cause`). Апстрим — фейк `infra/llm/fake-provider/server.ts`, каталог — `test/fixtures/catalog.json`, битые каталоги — `catalog-broken.json`, `catalog-invalid.json`.

## Ограничения

- Поток SSE пишется без ожидания `drain`: медленный клиент копит фрагменты в памяти процесса (D-68).
- Телеметрия только для логгера и `TraceContext`: хуки Fastify и `tracedHttpServer` — T-24. Dockerfile — T-25.
- Каталог читается один раз при старте; смена каталога требует перезапуска.
- Полный запуск (`main.ts`) требует NATS и LiteLLM; в тестах не запускается, проверяется `startGateway` с фейком.

## Связи

- Ядро: `@swag/llm-gateway-core`. Адаптеры: `@swag/adapter-litellm`, `@swag/adapter-nats`, `@swag/adapter-telemetry`.
- Конфигурация: `@swag/config`. Контракт каталога и событий: `@swag/contracts`.
- Фреймворк: `fastify` 5.12.7 (как в `apps/api`).

## Ключевые решения

- Порт слушается только после успешной сверки (REQ-002-13): `startGateway` вызывает `listen` последним.
- Каждая попытка сверки получает `AbortSignal.timeout` с остатком срока старта (`LLM_GATEWAY_STARTUP_TIMEOUT_MS`, округлённым вверх до миллисекунд): висящий апстрим не продлевает старт. Попытка, оборванная дедлайном, даёт `network`/`timeout` и `upstream_unavailable` (D-64).
- Исключение из «последний результат»: если попытка, оборванная дедлайном, пришла после ответа «нет моделей», возвращается этот ответ (`upstream_models_mismatch`). Иначе последняя попытка после `delay` до дедлайна получала бы бюджет около 1 мс и всегда давала бы ложную недоступность (трактовка T-20, см. журнал спеки).
- Выход процесса внедряется в `startGateway` (`exit`): тесты не вызывают `process.exit`.
- Телеметрия поднимается первой, как в `apps/api`: ошибка конфигурации и каталога уходит логом `error` до выхода.
- Событие `llm.call` публикуется в `swarm.<swarmId>.events` через `connectNatsBus.publishJson`.
- Секреты адаптера (4.9): мастер-ключ LiteLLM и непустые значения переменных `*_API_KEY`; они редактируются в сообщениях ошибок адаптера.
- `version` берётся из `package.json`, как в `apps/api`.
- Токен (`LLM_GATEWAY_TOKEN`) проверяется в `onRequest`, до разбора тела; сравнение через `crypto.timingSafeEqual`, разная длина — `401` без сравнения (4.2).
- Лимит тела — `bodyLimit` Fastify из `LLM_GATEWAY_BODY_LIMIT_BYTES`. Тело ошибки — формат 4.2, `code: 'invalid_request'` для `413` и для тела не-JSON: 4.6 таких строк не задаёт (D-65).
- Отмена вызова по уходу клиента: `AbortController` прерывается по `close` у `reply.raw`, только если ответ не дописан (`writableFinished` ложно). Слушать `close` у `request.raw` нельзя: на Node 24 он приходит сразу после чтения тела, и каждый вызов отменялся бы (D-67).
- Заголовки `x-swag-swarm-id` и `x-swag-agent-id` передаются в ядро как есть; нет заголовка или он задан дважды — пустая строка, которую `LlmCaller` отклоняет как `invalid_caller`.
- Поток SSE (4.2): итерация ядра начинается сразу после ответа апстрима и идёт до конца или до ошибки, без `return()` до первого `next()`: событие и лог пишутся в `finally` генератора ядра (D-60). Ответ берётся через `reply.hijack()` и пишется в `reply.raw`, `flushHeaders` отдаёт заголовки до первого фрагмента.
- Уход клиента во время потока: отмена апстрима тем же `AbortController`, что у JSON-пути; ядро бросает `UpstreamStreamError` (D-62). Оболочка ловит его, ничего не пишет и не логирует как ошибку (`signal.aborted`). Прочие исключения после старта потока — `request.log.error` (`err`), ответ закрывается, процесс не падает.

## Спеки

- 002 — 4.2 (`/health`, `/v1/models`, `/v1/chat/completions`, тело ошибки), 4.6, 4.9, 4.14; REQ-002-3, REQ-002-13; AC-002-1, -2, -3, -4, -5, -6, -9, -10, -11, -12, -13, -14, -15, -16, -18, -28; задачи T-20, T-21, T-22, T-23.
