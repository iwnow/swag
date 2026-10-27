# @swag/llm-gateway

Оболочка LLM Gateway (спека 002): Fastify-процесс. Читает конфигурацию и каталог моделей, собирает адаптеры LiteLLM и NATS, вызывает фабрику ядра `createLlmGatewayCore` и на старте сверяет каталог с апстримом. Решений здесь нет: логика живёт в `packages/llm-gateway-core`.

## Задачи

- Старт: конфигурация `LlmGatewayConfig` (env, `@swag/config`; по умолчанию `LLM_GATEWAY_UPSTREAM_TIMEOUT_MS` 120000, `LLM_GATEWAY_STARTUP_TIMEOUT_MS` 60000, `LLM_GATEWAY_BODY_LIMIT_BYTES` 8388608), каталог моделей из `LLM_CATALOG_PATH` (`readCatalog`, схема `ModelCatalog`), секреты адаптера (`upstreamSecrets`), адаптер LiteLLM (`createLiteLlmUpstream`), шина NATS для события `llm.call` в `swarm.<swarmId>.events`.
- Сверка при старте (REQ-002-13): `checkUpstream` повторяется раз в 1 с до `LLM_GATEWAY_STARTUP_TIMEOUT_MS`. Пока сверка не прошла, порт не слушается.
  - Модели каталога не хватает → `error` `upstream_models_mismatch` с `missing`, выход с кодом 1.
  - Апстрим не ответил → `error` `upstream_unavailable` с `reason`, выход с кодом 1 (D-64).
- `GET /health` → `200 { status: 'ok', service: 'llm-gateway', version }`.
- Образ: `apps/llm-gateway/Dockerfile`, сборка и запуск:

  ```bash
  docker build -f apps/llm-gateway/Dockerfile -t swag-llm-gateway:t25 .
  docker run --rm swag-llm-gateway:t25        # без переменных: код 1, `Ошибка конфигурации` с LLM_GATEWAY_TOKEN
  ```

- Стек: `npm run up` поднимает `litellm`, `llm-fake`, `llm-gateway` и остальные сервисы (`compose.yaml`, 4.8). Профиль моделей — `LLM_PROFILE` в `.env` (по умолчанию `test`). Проверка — `npm run infra:check` (строка `llm-gateway`: `GET /health` → `service: 'llm-gateway'`). Остановка — `npm run down`.
  - Образ LiteLLM: `ghcr.io/berriai/litellm:main-v1.83.14-stable.patch.3` (`compose.yaml`, сервис `litellm`). Выбран по шаблону 4.8 с поправкой решения приёмки D-71: патч `main-v1.83.14-stable.patch.3` (вместо `main-v1.83.14-stable`, с которым шаблон 4.8 взят при T-27). Конфиг монтируется из `infra/llm/${LLM_PROFILE}/litellm.yaml`, порт наружу не публикуется, сеть `llm`.
  - Проверено на стеке `test` (T-27): префикс `openai/` LiteLLM снимает (фейк получает `fake-small`); `usage.cost` фейка без потока доходит до клиента, в потоке LiteLLM его не передаёт (D-72), поэтому `providerCostMicroUsd` в потоке через стек — `null`.

## Что внутри сейчас

- `Dockerfile` — образ как у `apps/api`: `node:24.22.1-alpine3.23`, `npm ci --omit=dev --ignore-scripts`, запуск `src/main.ts` из исходников. Каталог моделей в образ не входит, его монтируют (`LLM_CATALOG_PATH`).
- `src/main.ts` — телеметрия (`startTelemetry`, сервис `llm-gateway`), конфигурация, каталог, NATS, адаптер, ядро (`trace: telemetry.trace`), приложение с опциями `telemetryAppOptions(telemetry)`, запуск, остановка по `SIGINT`/`SIGTERM` со сбросом телеметрии. Слушает `0.0.0.0` внутри контейнера.
- `src/start.ts` — `startGateway` (сверка, затем `listen`, либо выход 1), `waitForUpstream` (повтор раз в 1 с до таймаута), `upstreamSecrets`.
- `src/catalog.ts` — `readCatalog`: читает файл и проверяет его схемой `ModelCatalog`.
- `src/app.ts` — `telemetryAppOptions(telemetry)`: опции Fastify телеметрии (логгер `telemetry.logger.pino`, `tracedHttpServer` с `ignorePaths: ['/health']`), общие для `main.ts` и `test/telemetry.test.ts`; `buildApp(core, { token, bodyLimitBytes }, options)`: Fastify с `GET /health` (без токена), `GET /v1/models` и `POST /v1/chat/completions` за проверкой токена в `onRequest`; заголовки вызывающего и тело уходят в ядро как есть; отказ ядра — статус и тело по 4.2; `kind: 'json'` отвечает `200` с телом ядра как есть; `kind: 'stream'` пишет SSE (`writeStream`: `200`, `content-type: text/event-stream`, `cache-control: no-cache`, каждый фрагмент — `data: <payload>\n\n` сразу после получения, `reply.hijack()` и `reply.raw`); вызов отменяется, если клиент ушёл до ответа; ошибка разбора тела (больше `bodyLimitBytes` — `413`, не JSON — `400`) — тело по 4.2 с `code: 'invalid_request'` (D-65); ошибка 5xx (исключение без `statusCode`) — `500` с телом 4.2, `message: 'Internal error'`, `code: 'upstream_error'`, текст исключения только в логе (D-66).
- `test/support.ts` — общие хелперы тестов: `openGateway(options)` (фейк, ядро, шина в памяти с подпиской на события, лог; порт не слушается), `makeCore(url, log, events, options)` (опции `traceId` — стаб трейса, `trace` — порт телеметрии, `secrets`, `masterKey` — ключ, уходящий апстриму), `listenUrl(app)` (`127.0.0.1` на свободном порту), `closeAll` (ставится в `afterEach` каждого файла), `caller`, `authorized`, `SWARM_ID`, фикстура каталога.
- `test/telemetry.test.ts` — оболочка с телеметрией, как в `apps/api`: `startTelemetry` с выводом строк в массив и спанами в памяти (`createMemoryExporters`), Fastify на `loggerInstance` и `tracedHttpServer`, сеть по `listen`: AC-002-23 (без потока и потоком: маркер нет в логах, спанах и событии; на каждый вызов одна `llm call` — `LogRecord` с `service: 'llm-gateway'`), AC-002-17 в двух проходах (`masterKey` — мастер-ключ и ключ фейка: ключ прохода реально уходит фейку в `Authorization`, в ответе `Bearer ***`, ни одного ключа в логах, спанах и событии), REQ-002-14 в двух вариантах — без потока и потоком (трейс из `traceparent`: запись, событие и серверный спан в трейсе запроса).
- `test/routes.test.ts` — тесты на фейке через `app.inject`:
  - отказы до ядра: AC-002-2 (`401` без токена, с чужим и с токеном другой длины), AC-002-3 (`400 invalid_caller`), AC-002-4 (`model_not_found`), AC-002-5 (`invalid_request`: нет `messages`, пустой, тело-массив), AC-002-6 (`/v1/models`), AC-002-28 (поля провайдера в теле), тело больше лимита → `413`, валидный вызов доходит до фейка с телом;
  - ответ JSON: AC-002-1 (без потока с `tools`, `tool_choice`, `temperature`: `200`, тело как у фейка, фейк получил тело как отправлено), AC-002-9 (одно `llm.call` в шине с `traceId`, проходит `PlatformEventInput`), AC-002-14 (без `usage`: событие с `usage: null`, `warn` `usage_missing`), AC-002-15 без потока (`502 upstream_error`, `429 rate_limited`, `400 upstream_bad_request`), AC-002-16 (таймаут простоя 200 мс: `504 upstream_timeout`);
  - без AC-id: обычный вызов по сети (не `inject`) — `200`; клиент ушёл до ответа — отмена вызова апстрима.
  - Во всех отказах фейк не вызван и событий нет. События уходят в шину в памяти (`createMemoryBus` в `test/support.ts`) и читаются подпиской.
- `test/stream.test.ts` — поток по сети (`listen` на `127.0.0.1`, `fetch`, не `inject`): AC-002-10 (заголовки SSE, фрагменты, `usage`, `[DONE]`, событие `ok`), AC-002-11 (первый фрагмент раньше 300 мс, поток не раньше 500 мс), AC-002-12 (обрыв апстрима: `{"error":...}` последним, без `[DONE]`, событие `aborted` с `errorCode`), AC-002-13 (клиент рвёт соединение после первого фрагмента: фейк видит `closedByClient` за 1 с, событие `aborted` без `errorCode`, следующий вызов — `200`), AC-002-15 потоком (отказ до первого фрагмента — обычный JSON с кодом по 4.6).
- `test/start.test.ts` — AC-002-18 (в апстриме нет `chat-large`: порт не слушает, `upstream_models_mismatch` с `missing`, выход 1; полный список: `/health` → `200`), D-64 (апстрим недоступен: `upstream_unavailable`), REQ-002-13 (висящая сверка прерывается по дедлайну; первая сверка `missing`, вторая ок: порт до второй попытки не слушает), повтор сверки, `upstreamSecrets`, `readCatalog` (битый JSON и нарушение схемы: путь файла в сообщении, причина в `cause`). Апстрим — фейк `infra/llm/fake-provider/server.ts`, каталог — `test/fixtures/catalog.json`, битые каталоги — `catalog-broken.json`, `catalog-invalid.json`.
- `test/nfr-latency.test.ts` — замер NFR-002-1 (спека 002, раздел 6): прогрев 20 вызовов, затем 200 вызовов через шлюз и 200 напрямую к фейку, порядок в паре меняется по чётности. Шлюз собран как в `src/main.ts`: `startTelemetry` без OTLP, логи в null-поток, `telemetryAppOptions` (серверный спан через `tracedHttpServer`), шина — `createMemoryBus` из `test/support.ts`. Печатается строка `NFR-002-1 {...}` с p50/p95 обоих путей и разницей p95. Порога нет, в `npm run check` не входит: без `LLM_GATEWAY_BENCH=1` тест пропускается.
  Ограничения: OTLP-коллектора нет (спаны создаются и не экспортируются, как в проде без `OTEL_EXPORTER_OTLP_ENDPOINT`); NATS не подключён, событие `llm.call` уходит в память; фейк без задержки на loopback 127.0.0.1, сеть и стек не нужны.

  ```bash
  LLM_GATEWAY_BENCH=1 npx vitest run apps/llm-gateway/test/nfr-latency.test.ts
  ```

  Результаты и окружение — в журнале спеки 002, T-32.

## Профили моделей (`infra/llm/`)

Профиль выбирается `LLM_PROFILE` (`test`, `dev`, `prod`); каталог — `infra/llm/<профиль>/models.json` (путь в `LLM_CATALOG_PATH`), конфиг LiteLLM — `infra/llm/<профиль>/litellm.yaml`. Модели платформы одинаковые во всех профилях: `chat-small` и `chat-large` (Q-4). Наборы `id` трёх профилей совпадают (REQ-002-12). Ключи — только ссылки `os.environ/…`, значений в git нет.

- `test` — фейковый провайдер `llm-fake` (`openai/fake-small`, `openai/fake-large`); цены по 4.7: `chat-small` `3.00 / 0.30 / 15.00`, `chat-large` `0 / 0 / 0`.
- `dev` — OpenRouter, бесплатные модели `:free` (Q-2), цены `0`. Ключ — `OPENROUTER_API_KEY`.
- `prod` — OpenRouter, платные модели (Q-2), цены OpenRouter. Ключ — `OPENROUTER_API_KEY`.

Проверено 2026-10-27 по `https://openrouter.ai/api/v1/models` (поле `pricing` в USD за токен, в таблице пересчитано в USD за 1 млн токенов; `supported_parameters` — поддержка `tools`) и по `https://openrouter.ai/models`. Поток: `stream: true` поддерживается для любой модели (`https://openrouter.ai/docs/api/reference/streaming`). `usage` в потоке приходит в последнем SSE-сообщении без параметров запроса, `stream_options.include_usage` объявлен устаревшим и не действует (`https://openrouter.ai/docs/use-cases/usage-accounting`). Стоимость провайдера — `usage.cost`.

| Профиль | Имя          | Модель OpenRouter                          | `tools` | Вход / кэш / выход, USD за 1 млн | Дата создания в API |
| ------- | ------------ | ------------------------------------------ | ------- | -------------------------------- | ------------------- |
| dev     | `chat-small` | `openrouter/free` (роутер по free-моделям) | да      | 0 / 0 / 0                        | 2026-02-01          |
| dev     | `chat-large` | `nvidia/nemotron-3-ultra-550b-a55b:free`   | да      | 0 / 0 / 0                        | 2026-06-04          |
| prod    | `chat-small` | `anthropic/claude-haiku-5.5`               | да      | 0.10 / 0.01 / 0.50               | 2026-10-07          |
| prod    | `chat-large` | `anthropic/claude-sonnet-5.5`              | да      | 2.00 / 0.10 / 10.00              | 2026-09-28          |

Выбор моделей внутри класса и `:free`-суффикс — D-69 в `docs/spec/questions.md`. `chat-small` в dev — роутер `openrouter/free`: OpenRouter сам выбирает доступную бесплатную модель с нужными параметрами запроса, поэтому лимит одной free-модели у провайдера не останавливает вызовы; модель от вызова к вызову может отличаться (решение человека 2026-10-28, D-69). `chat-large` в dev — конкретная модель. Бесплатные модели имеют суточные лимиты OpenRouter (Q-2). Цены и поддержка меняются у провайдера: при смене профиля сверять заново.

Тесты профилей: `scripts/repo.test.ts` (AC-002-8, вторая часть; AC-002-19).

## Ограничения

- Поток SSE пишется без ожидания `drain`: медленный клиент копит фрагменты в памяти процесса (D-68).
- Каталог читается один раз при старте; смена каталога требует перезапуска.
- Каталог хранит одну цену на модель. У `prod` `chat-small` (`anthropic/claude-haiku-5.5`) OpenRouter задаёт вторую ценовую ступень от 100 000 входных токенов (вход 0.50, кэш 0.05, выход 2.50 USD за 1 млн, в 5 раз дороже): для длинных запросов `costMicroUsd` занижен (D-70).
- Полный запуск (`main.ts`) требует NATS и LiteLLM; в тестах не запускается, проверяется `startGateway` с фейком.
- В потоке через LiteLLM `usage.cost` провайдера не приходит (D-72): `providerCostMicroUsd` в потоке при работе со стеком `null`; тесты адаптера с фейком напрямую проверяют поток.

## Связи

- Ядро: `@swag/llm-gateway-core`. Адаптеры: `@swag/adapter-litellm`, `@swag/adapter-nats`, `@swag/adapter-telemetry`.
- Конфигурация: `@swag/config`. Контракт каталога и событий: `@swag/contracts`.
- Фреймворк: `fastify` 5.12.7 (как в `apps/api`).

## Стек-тесты

`apps/llm-gateway/test/stack.test.ts` — AC-002-20 и AC-002-21 против поднятого стека. Без `LLM_GATEWAY_URL` тесты пропускаются.

```bash
npm run up                                   # профиль LLM_PROFILE=test из .env
LLM_GATEWAY_URL=http://127.0.0.1:3002 node --env-file-if-exists=.env node_modules/vitest/vitest.mjs run apps/llm-gateway/test/stack.test.ts
npm run down
```

- `LLM_GATEWAY_TOKEN` — из `.env`; адрес `api` — `STACK_API_URL` (по умолчанию `http://127.0.0.1:3000`), для него тест создаёт рой через `POST /swarms`.
- AC-002-21: в env `api`, `orchestrator`, `ui` не должно быть `LITELLM_MASTER_KEY` и `*_API_KEY` из `.env.llm`, без исключений (D-73: `api` и `orchestrator` получают явный `environment`, не весь `.env`); значения секретов из `.env.llm` тоже не должны встречаться. Нужен `.env.llm` — его читает compose.
- Пример вызова, который проверяет тест (ответ `fake reply`, usage 1000/200/500):

  ```bash
  curl -s -X POST "$LLM_GATEWAY_URL/v1/chat/completions" -H "authorization: Bearer $LLM_GATEWAY_TOKEN" -H "x-swag-swarm-id: <uuid роя>" -H "x-swag-agent-id: agent-1" -H "content-type: application/json" -d '{"model":"chat-small","messages":[{"role":"user","content":"ping"}]}'
  ```

## Ключевые решения

- Телеметрия как в `apps/api` (4.10): `startTelemetry` с сервисом `llm-gateway`; логгер ядра (`telemetry.logger`) и логгер Fastify (`loggerInstance: telemetry.logger.pino`) — один pino, одна схема `LogRecord`. Ошибка потока после старта по-прежнему пишется `request.log.error` (T-23) — это тот же логгер, отдельного не заводим.
- Трейс запроса: `tracedHttpServer` открывает серверный спан на каждый запрос (родитель — `traceparent`), кроме `/health`; `TraceContext` ядра — `telemetry.trace`, поэтому `traceId` события и записи `llm call` совпадают с трейсом запроса (REQ-002-14). Заголовки, тело и текст сообщений в логи и спаны не попадают: адаптер логгера пишет только id, числа и перечисления.
- Секреты в логах и спанах (REQ-002-11): оболочка ничего не маскирует сама. Ошибки апстрима уже очищены `redact` адаптера LiteLLM, а `llm call` и событие несут только поля 4.10.
- Порт слушается только после успешной сверки (REQ-002-13): `startGateway` вызывает `listen` последним.
- Каждая попытка сверки получает `AbortSignal.timeout` с остатком срока старта (`LLM_GATEWAY_STARTUP_TIMEOUT_MS`, округлённым вверх до миллисекунд): висящий апстрим не продлевает старт. Попытка, оборванная дедлайном, даёт `network`/`timeout` и `upstream_unavailable` (D-64).
- Исключение из «последний результат»: если попытка, оборванная дедлайном, пришла после ответа «нет моделей», возвращается этот ответ (`upstream_models_mismatch`). Иначе последняя попытка после `delay` до дедлайна получала бы бюджет около 1 мс и всегда давала бы ложную недоступность (трактовка T-20, см. журнал спеки).
- Выход процесса внедряется в `startGateway` (`exit`): тесты не вызывают `process.exit`.
- Телеметрия поднимается первой, как в `apps/api`: ошибка конфигурации и каталога уходит логом `error` до выхода.
- Событие `llm.call` публикуется в `swarm.<swarmId>.events` через `connectNatsBus.publishJson`.
- Секреты адаптера (4.9): мастер-ключ LiteLLM и непустые значения переменных `*_API_KEY`; они редактируются в сообщениях ошибок адаптера.
- `version` берётся из `package.json`, как в `apps/api`.
- Токен (`LLM_GATEWAY_TOKEN`) проверяется в `onRequest`, до разбора тела; сравнение через `crypto.timingSafeEqual`, разная длина — `401` без сравнения (4.2).
- Лимит тела — `bodyLimit` Fastify из `LLM_GATEWAY_BODY_LIMIT_BYTES`. Тело ошибки — формат 4.2, `code: 'invalid_request'` для `413` и для тела не-JSON: 4.6 таких строк не задаёт (D-65). Ошибка 5xx — `500`, `message: 'Internal error'`, текст исключения пишется в лог `request.log.error` и клиенту не уходит (D-66). В `GatewayErrorCode` кода для 500 нет, взят ближайший `upstream_error` — решение приёмки D-66; сам код ответа 500, не 502.
- Отмена вызова по уходу клиента: `AbortController` прерывается по `close` у `reply.raw`, только если ответ не дописан (`writableFinished` ложно). Слушать `close` у `request.raw` нельзя: на Node 24 он приходит сразу после чтения тела, и каждый вызов отменялся бы (D-67).
- Заголовки `x-swag-swarm-id` и `x-swag-agent-id` передаются в ядро как есть; нет заголовка или он задан дважды — пустая строка, которую `LlmCaller` отклоняет как `invalid_caller`.
- Поток SSE (4.2): итерация ядра начинается сразу после ответа апстрима и идёт до конца или до ошибки, без `return()` до первого `next()`: событие и лог пишутся в `finally` генератора ядра (D-60). Ответ берётся через `reply.hijack()` и пишется в `reply.raw`, `flushHeaders` отдаёт заголовки до первого фрагмента. Если записать заголовки не удалось, ошибка логируется, а итерация всё равно запускается и `finally` закрывает ответ: поток ядра дочитывается (D-60).
- Уход клиента во время потока: отмена апстрима тем же `AbortController`, что у JSON-пути; ядро бросает `UpstreamStreamError` (D-62). Оболочка ловит его, ничего не пишет и не логирует как ошибку (`signal.aborted`). Прочие исключения после старта потока — `request.log.error` (`err`), ответ закрывается, процесс не падает.
- Опции телеметрии Fastify собираются одной функцией `telemetryAppOptions` (`src/app.ts`): `main.ts` и тесты используют одну сборку, поэтому тесты проверяют то же подключение, что процесс (T-24).
- Сверка с документацией (T-33 спеки 002, 2026-10-28), Fastify 5.12.7 (https://fastify.dev/docs/latest/Reference/Server/):
  - `bodyLimit` по умолчанию 1 MiB, здесь задаётся из `LLM_GATEWAY_BODY_LIMIT_BYTES`.
  - `loggerInstance` — pino-инстанс.
  - `serverFactory(handler, opts)`.
  - `listen({ host, port })`.
  - `logLevel` маршрута — валидная опция (https://fastify.dev/docs/latest/Reference/Routes/).
  - `reply.hijack()` и `reply.raw` — по https://fastify.dev/docs/latest/Reference/Reply/.
  - Хук `onRequest`: в нём `request.body` не разобран (https://fastify.dev/docs/latest/Reference/Hooks/), поэтому токен проверяется до тела.
  - Async-хук, отправивший ответ и вернувший `reply`, останавливает цепочку, как написано в доке.
  - Документация не описывает, что делает `setErrorHandler`, если обработчик бросает исключение; обработчик 5xx не бросает исключение и отвечает сам (D-66).
- AC-002-17 проверяется в двух проходах: `masterKey` оболочки — мастер-ключ и ключ фейка (`FAKE_PROVIDER_API_KEY`). Во втором проходе ключ фейка реально приходит фейку в `Authorization`, поэтому отсутствие ключа в выводе проверено не пустым множеством (T-24).

## Спеки

- 002 — 4.2 (`/health`, `/v1/models`, `/v1/chat/completions`, тело ошибки), 4.6, 4.9, 4.10, 4.14; REQ-002-3, REQ-002-11 (оболочка), REQ-002-13, REQ-002-14; AC-002-1, -2, -3, -4, -5, -6, -9, -10, -11, -12, -13, -14, -15, -16, -17, -18, -23, -28; REQ-002-12; AC-002-8 (вторая часть), AC-002-19; REQ-002-5 (compose: сервисы и порты, `scripts/repo.test.ts`), REQ-002-16; задачи T-20, T-21, T-22, T-23, T-24, T-25, T-26, T-27.
