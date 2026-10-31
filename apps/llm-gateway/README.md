# @swag/llm-gateway

Оболочка LLM Gateway (спеки 002 и 004): Fastify-процесс. Читает конфигурацию и каталог моделей, применяет миграции и подключает Postgres (бюджеты, ledger, цены), собирает адаптеры LiteLLM и NATS, вызывает фабрику ядра `createLlmGatewayCore` и на старте сверяет каталог с апстримом. Решений здесь нет: логика живёт в `packages/llm-gateway-core`.

## Задачи

- Старт: конфигурация `LlmGatewayConfig` (env, `@swag/config`; `DATABASE_URL` — Postgres для бюджетов, ledger и цен; по умолчанию `LLM_GATEWAY_UPSTREAM_TIMEOUT_MS` 120000, `LLM_GATEWAY_STARTUP_TIMEOUT_MS` 60000, `LLM_GATEWAY_BODY_LIMIT_BYTES` 8388608, `LLM_PRICES_REFRESH_MS` 3600000, `OPENROUTER_MODELS_URL` `https://openrouter.ai/api/v1/models`), каталог моделей из `LLM_CATALOG_PATH` (`readCatalog`, схема `ModelCatalog`), секреты адаптера (`upstreamSecrets`), адаптер LiteLLM (`createLiteLlmUpstream`), шина NATS для события `llm.call` в `swarm.<swarmId>.events`.
- Старт с Postgres (спека 004, 4.11, REQ-004-14): `startLlmGatewayCore` — `runMigrations` → пул `pg` → `createPostgresBudgetStore` в `deps.budgets` → каталог `models.json` с сохранёнными ценами поверх (`assembleCore`) → `PriceBook` → `core.releaseHolds()`. Только после этого `main.ts` строит приложение и слушает порт: резервы от прошлого процесса освобождаются до приёма запросов, без списания (`warn` `hold_released` на каждый).
- Внутренний API регистрации роёв (спека 004, 4.2): `POST /internal/swarms` (тело `LlmSwarmRegistration`: `204`, `409 swarm_registered`, `400 invalid_request`, `400 model_not_found`) и `POST /internal/swarms/:swarmId/close` (`200 LlmSwarmClosed`, повтор — тот же ответ, `404 not_found`). Токен — `LLM_GATEWAY_TOKEN`, как у `/v1/*`; без токена или с чужим — `401 unauthorized`, ядро не вызвано (REQ-004-7).
- `PriceBook` — цены моделей из текущего каталога процесса (`createCatalogHolder`). Каталог обновляется из OpenRouter по таймеру (`startPriceRefresh`, спека 004, 4.9).
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
- `src/main.ts` — телеметрия (`startTelemetry`, сервис `llm-gateway`), конфигурация, каталог, NATS, `startLlmGatewayCore` (Postgres, ядро с `trace: telemetry.trace`), приложение с опциями `telemetryAppOptions(telemetry)`, запуск, остановка по `SIGINT`/`SIGTERM` со сбросом телеметрии и закрытием пула. Слушает `0.0.0.0` внутри контейнера. Цены: `createOpenRouterPrices` (таймаут попытки `PRICES_TIMEOUT_MS` 10 с, D-97) и `startPriceRefresh` после `startGateway`; при `SIGINT`/`SIGTERM` таймер останавливается первым.
- `src/start.ts` — `startLlmGatewayCore` (миграции, пул, `BudgetStore`, `PriceStore`, `assembleCore`, `releaseHolds` до возврата; возвращает `holder` и `priceStore`; при сбое пул закрывается), `assembleCore` (`applyStoredPrices` поверх каталога → `createCatalogHolder` → ядро → `releaseHolds`; ошибка чтения цен — исключение), `startGateway` (сверка, затем `listen`, либо выход 1), `waitForUpstream` (повтор раз в 1 с до таймаута), `upstreamSecrets`.
- `src/catalog.ts` — `readCatalog`: читает файл и проверяет его схемой `ModelCatalog`; `createCatalogHolder` — текущий каталог процесса за `PriceBook`; `replace` подменяет его целиком (спека 004, 4.9).
- `src/prices.ts` — обновление цен из OpenRouter (спека 004, 4.9): `refreshPrices` (один цикл: запрос, `applyOpenRouterPrices`, `warn` по пропускам, `PriceStore.save`, подмена каталога, `info` по изменениям) и `startPriceRefresh` (первый цикл сразу, затем таймер; профиль `test` и интервал 0 — запросов нет; `stop` отменяет запрос в полёте и снимает таймер).
- `src/app.ts` — `telemetryAppOptions(telemetry)`: опции Fastify телеметрии (логгер `telemetry.logger.pino`, `tracedHttpServer` с `ignorePaths: ['/health']`), общие для `main.ts` и `test/telemetry.test.ts`; `buildApp(core, { token, bodyLimitBytes }, options)`: Fastify с `GET /health` (без токена), `GET /v1/models` и `POST /v1/chat/completions` за проверкой токена в `onRequest`, `POST /internal/swarms` и `POST /internal/swarms/:swarmId/close` за тем же `authorize` (вызовы `registerSwarm` и `closeSwarm` ядра, `InternalResult` → статус и тело `{ error: { message, code } }`, `204` и `200` при успехе); заголовки вызывающего и тело уходят в ядро как есть; отказ ядра — статус и тело по 4.2; `kind: 'json'` отвечает `200` с телом ядра как есть; `kind: 'stream'` пишет SSE (`writeStream`: `200`, `content-type: text/event-stream`, `cache-control: no-cache`, каждый фрагмент — `data: <payload>\n\n` сразу после получения, `reply.hijack()` и `reply.raw`); вызов отменяется, если клиент ушёл до ответа; ошибка разбора тела (больше `bodyLimitBytes` — `413`, не JSON — `400`) — тело по 4.2 с `code: 'invalid_request'` (D-65); ошибка 5xx (исключение без `statusCode`) — `500` с телом 4.2, `message: 'Internal error'`, `code: 'upstream_error'`, текст исключения только в логе (D-66).
- `test/support.ts` — общие хелперы тестов: `openGateway(options)` (фейк, ядро, фейк хранилища `budgets`, шина в памяти с подпиской на события, лог; порт не слушается), `makeCore(url, log, events, options)` (опции `traceId` — стаб трейса, `trace` — порт телеметрии, `secrets`, `masterKey` — ключ, уходящий апстриму, `budgets` — хранилище, по умолчанию `registeredBudgets()`; `prices` — из каталога фикстуры), `registeredBudgets()` и `TEST_REGISTRATION` (рой `SWARM_ID` с агентом `agent-1` зарегистрирован в фейке, как в тестах 002), `listenUrl(app)` (`127.0.0.1` на свободном порту), `closeAll` (ставится в `afterEach` каждого файла), `caller`, `authorized`, `SWARM_ID`, фикстура каталога. Фейк хранилища — `packages/llm-gateway-core/test/fake-budgets.ts`, переиспользуется, не копируется.
- `test/internal.test.ts` — внутренний API (спека 004, 4.2): AC-004-5 (без токена, с неверным — `401 unauthorized`, `register` и `close` фейка не вызваны; с верным — `204` без тела), REQ-004-6 через оболочку (`409 swarm_registered`, `400 model_not_found`, `400 invalid_request` для бюджета агента больше роя, для тела не по схеме и для битого JSON), закрытие (`200 { spentMicroUsd }`, повтор — тот же ответ, неизвестный и не UUID рой — `404 not_found`).
- `test/money-postgres.test.ts` — Postgres, `POSTGRES_TEST_URL` (без неё пропускается), схема на время файла: AC-004-18 (резервы от прошлого процесса в Postgres: после `startLlmGatewayCore` строк `budget_holds` нет, `held` роя и агентов 0, записей ledger нет, два `warn` `hold_released`), AC-004-19 (12 вызовов трёх агентов: без потока, потоком с обрывом клиентом, без ответа до обрыва, с ошибкой апстрима; затем `closeSwarm`; сумма `amount_micro_usd` в ledger = сумма `charge.microUsd` событий `llm.call` = `spentMicroUsd` ответа закрытия = `spentMicroUsd` проекции `projectSwarm` по тем же событиям (4.7; `@swag/api-integration` — `devDependencies`, только для теста)).
- `test/prices-support.ts` — фейк OpenRouter на `127.0.0.1` (`startFakeOpenRouter`, ответ меняется `reply`, счётчик запросов), `catalogWithOpenRouter()` (фикстура с `openRouterModel` у `chat-small`), `memoryPriceStore()` (хранилище цен в памяти, `setFailSave`), `gatewayDeps(catalog, log)`.
- `test/prices.test.ts` — AC-004-29 (до ответа — `models.json`, `price_updated` и новая цена, после `500` — последняя успешная, `price_refresh_failed`), профиль `test` и `LLM_PRICES_REFRESH_MS` 0 — ни одного запроса, ошибка `save` — `price_save_failed` и повтор `save` в следующем цикле, ошибка чтения цен на старте — исключение.
- `test/money-prices-postgres.test.ts` — Postgres, `POSTGRES_TEST_URL` (без неё пропускается): AC-004-40 (старт 1 пишет новую цену в `model_prices` с `openRouterModel`; старт 2 до первого запроса берёт цену из Postgres, `500` не меняет её; `save` бросает — `price_save_failed`, цена прежняя, `save` вызван снова).
- `test/telemetry.test.ts` — оболочка с телеметрией, как в `apps/api`: `startTelemetry` с выводом строк в массив и спанами в памяти (`createMemoryExporters`), Fastify на `loggerInstance` и `tracedHttpServer`, сеть по `listen`: AC-002-23 (без потока и потоком: маркер нет в логах, спанах и событии; на каждый вызов одна `llm call` — `LogRecord` с `service: 'llm-gateway'`), AC-002-17 в двух проходах (`masterKey` — мастер-ключ и ключ фейка: ключ прохода реально уходит фейку в `Authorization`, в ответе `Bearer ***`, ни одного ключа в логах, спанах и событии), REQ-002-14 в двух вариантах — без потока и потоком (трейс из `traceparent`: запись, событие и серверный спан в трейсе запроса).
- `test/routes.test.ts` — тесты на фейке через `app.inject`:
  - отказы до ядра: AC-002-2 (`401` без токена, с чужим и с токеном другой длины), AC-002-3 (`400 invalid_caller`), AC-002-4 (`model_not_found`), AC-002-5 (`invalid_request`: нет `messages`, пустой, тело-массив), AC-002-6 (`/v1/models`), AC-002-28 (поля провайдера в теле), тело больше лимита → `413`, валидный вызов доходит до фейка с телом;
  - ответ JSON: AC-002-1 (без потока с `tools`, `tool_choice`, `temperature`: `200`, тело как у фейка, фейк получил тело как отправлено), AC-002-9 (одно `llm.call` в шине с `traceId`, проходит `PlatformEventInput`), AC-002-14 (без `usage`: событие с `usage: null`, `warn` `usage_missing`), AC-002-15 без потока (`502 upstream_error`, `429 rate_limited`, `400 upstream_bad_request`), AC-002-16 (таймаут простоя 200 мс: `504 upstream_timeout`);
  - без AC-id: обычный вызов по сети (не `inject`) — `200`; клиент ушёл до ответа — отмена вызова апстрима, событие `llm.call` `aborted` (спека 030).
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

Профиль выбирается `LLM_PROFILE` (`test`, `dev`, `test-pay`, `prod`); каталог — `infra/llm/<профиль>/models.json` (путь в `LLM_CATALOG_PATH`), конфиг LiteLLM — `infra/llm/<профиль>/litellm.yaml`. Модели платформы одинаковые во всех профилях: `chat-small` и `chat-large` (Q-4). Наборы `id` четырёх профилей совпадают (REQ-002-12, 032).

- `test` — фейковый провайдер `llm-fake` (`openai/fake-small`, `openai/fake-large`); цены по 4.7: `chat-small` `3.00 / 0.30 / 15.00`, `chat-large` `0 / 0 / 0`.
- `dev` — OpenRouter, бесплатные модели `:free` (Q-2), цены `0`. Ключ — `OPENROUTER_API_KEY`.
- `test-pay` (спека 032) — OpenRouter, дешёвые платные модели без reasoning (`mistralai/mistral-nemo` для `chat-small`, `meta-llama/llama-3.1-8b-instruct` для `chat-large`) для платных проверок вместо `prod`; цены OpenRouter. Ключ — `OPENROUTER_API_KEY`.
- `prod` — OpenRouter, платные модели (Q-2), цены OpenRouter. Ключ — `OPENROUTER_API_KEY`.

Проверено 2026-10-27 по `https://openrouter.ai/api/v1/models` (поле `pricing` в USD за токен, в таблице пересчитано в USD за 1 млн токенов; `supported_parameters` — поддержка `tools`) и по `https://openrouter.ai/models`. Поток: `stream: true` поддерживается для любой модели (`https://openrouter.ai/docs/api/reference/streaming`). `usage` в потоке приходит в последнем SSE-сообщении без параметров запроса, `stream_options.include_usage` объявлен устаревшим и не действует (`https://openrouter.ai/docs/use-cases/usage-accounting`). Стоимость провайдера — `usage.cost`.

| Профиль | Имя          | Модель OpenRouter                          | `tools` | Вход / кэш / выход, USD за 1 млн | Дата создания в API |
| ------- | ------------ | ------------------------------------------ | ------- | -------------------------------- | ------------------- |
| dev     | `chat-small` | `openrouter/free` (роутер по free-моделям) | да      | 0 / 0 / 0                        | 2026-02-01          |
| dev     | `chat-large` | `nvidia/nemotron-3-ultra-550b-a55b:free`   | да      | 0 / 0 / 0                        | 2026-06-04          |
| prod    | `chat-small` | `deepseek/deepseek-v4-flash`               | да      | 0.047 / 0.0095 / 0.095           | 2026-04-24          |
| prod    | `chat-large` | `deepseek/deepseek-v4-pro`                 | да      | 0.877 / 0.073 / 1.754            | 2026-04-24          |

Цены `prod` — по API OpenRouter на 2026-10-28, модели выбраны на приёмке (Q-5 спеки 002, D-69, D-70). Обе модели поддерживают `tools` и `tool_choice`, ступеней цены нет. В каталоге цены округлены; точные значения API, USD за 1 млн токенов:

| Модель                       | `prompt` (вход) | `input_cache_read` (кэш) | `completion` (выход) |
| ---------------------------- | --------------- | ------------------------ | -------------------- |
| `deepseek/deepseek-v4-flash` | 0.04732         | 0.009464                 | 0.09464              |
| `deepseek/deepseek-v4-pro`   | 0.877134        | 0.0730945                | 1.754268             |

`chat-small` в dev — роутер `openrouter/free`: OpenRouter сам выбирает доступную бесплатную модель с нужными параметрами запроса, поэтому лимит одной free-модели у провайдера не останавливает вызовы; модель от вызова к вызову может отличаться (решение человека 2026-10-28, D-69). `chat-large` в dev — конкретная модель. Бесплатные модели имеют суточные лимиты OpenRouter (Q-2). Цены и поддержка меняются у провайдера: при смене профиля сверять заново.

### Обновление цен каталога

Цены обновляет сам gateway (спека 004, 4.9): `src/prices.ts`. Ручная правка `models.json` задаёт только стартовые цены до первого успешного ответа OpenRouter; дальше действуют сохранённые цены из Postgres (`model_prices`).

- Источник: `GET <OPENROUTER_MODELS_URL>` (по умолчанию `https://openrouter.ai/api/v1/models`), без ключа. Модель каталога с `openRouterModel` берёт цены из `data[]` с тем же `id`. В `dev` и `prod` `openRouterModel` равен `litellm_params.model` без `openrouter/` (тест AC-004-30). Модели без `openRouterModel` не обновляются.
- Перевод: строка за токен → USD за 1 млн; `prompt` → `inputPerMTokUsd`, `completion` → `outputPerMTokUsd`, `input_cache_read` → `cachedInputPerMTokUsd` (нет — цена `prompt`). Пропуск (`warn price_update_skipped`): модели нет в ответе, цена не разбирается, ненулевые `request`, `image`, `web_search`.
- Цикл: первый сразу после сверки с апстримом, приём запросов не ждёт; затем каждые `LLM_PRICES_REFRESH_MS` (0 — выключено). Профиль `test` запросов не делает. Следующий таймер взводится после окончания цикла, циклы не перекрываются.
- Порядок в цикле: изменённые цены сначала `PriceStore.save` (`updatedAt` — `Clock.now`), потом подмена каталога в памяти. Ошибка `save` — `warn price_save_failed`, цены в памяти прежние; следующий цикл увидит те же изменения и повторит запись.
- Логи: `info price_updated` (`model`, `from`, `to`) на каждую изменённую модель; `warn price_refresh_failed` — ошибка OpenRouter после повторов (4.10), цены прежние.
- Таймаут одной попытки — 10 с (`PRICES_TIMEOUT_MS` в `main.ts`, D-97); повторы — `retry` из `@swag/helpers` по 4.10.
- Старт: сохранённые цены ложатся поверх `models.json`; ошибка чтения `model_prices` — старт падает, как при миграциях.
- Цены `prod` в `models.json` — по API OpenRouter на 2026-10-28 (таблица выше); при смене цен у провайдера обновление идёт без перезапуска.

Тесты цен: `test/prices.test.ts` (AC-004-29), `test/money-prices-postgres.test.ts` (AC-004-40), разбор и перевод — `packages/llm-gateway-core/test/money-prices.test.ts` (AC-004-28).
Тесты профилей: `scripts/repo.test.ts` (AC-002-8, вторая часть; AC-002-19).

## Ограничения

- Поток SSE пишется без ожидания `drain`: медленный клиент копит фрагменты в памяти процесса (D-68).
- Файл `models.json` читается один раз при старте; список моделей и `openRouterModel` меняются только перезапуском. Цены меняются без перезапуска (4.9).
- Каталог хранит одну цену на модель. У моделей `prod` ступеней цены нет (D-70 снят).
- Полный запуск (`main.ts`) требует Postgres, NATS и LiteLLM; в тестах не запускается, проверяется `startGateway` с фейком и `startLlmGatewayCore` с Postgres.
- Один процесс gateway: освобождение резервов при старте (`releaseHolds`) рассчитано на один экземпляр (спека 004, 2). Несколько экземпляров — отдельная задача.
- `PriceBook` читает цены из текущего каталога процесса; таймер обновляет их из OpenRouter (спека 004, 4.9).
- В потоке через LiteLLM `usage.cost` провайдера не приходит (D-72): сверка с фактической стоимостью провайдера — в спеке 004. `providerCostMicroUsd` в потоке при работе со стеком `null`; тесты адаптера с фейком напрямую проверяют поток.

## Связи

- Ядро: `@swag/llm-gateway-core`. Адаптеры: `@swag/adapter-litellm`, `@swag/adapter-nats`, `@swag/adapter-openrouter`, `@swag/adapter-postgres` (бюджеты, ledger, цены, миграции), `@swag/adapter-telemetry`. Зависимость `pg` — как в `apps/api`.
- Конфигурация: `@swag/config`. Контракт каталога и событий: `@swag/contracts`.
- Тестовая зависимость: `@swag/api-integration` (`devDependencies`) — `projectSwarm` для сверки `spentMicroUsd` в AC-004-19; в коде оболочки не используется.
- Фреймворк: `fastify` 5.12.7 (как в `apps/api`).

## Стек-тесты

`apps/llm-gateway/test/stack.test.ts` — AC-002-20 и AC-002-21 против поднятого стека; `apps/llm-gateway/test/stack-money.test.ts` — AC-004-34 и AC-004-35 (деньги роя: `swarm_budgets`, `swarm_agents`, `ledger_entries` через `DATABASE_URL`, бюджет 1 и `docker ps` с меткой `swag.kind`). Без `STACK_TEST_GATEWAY_URL` тесты пропускаются (переменная оркестратора `LLM_GATEWAY_URL` их не включает, D-102). Общие хелперы (`run`, `containerId`, `apiUrl`) — `test/stack-support.ts`.

```bash
npm run up                                   # профиль LLM_PROFILE=test из .env
STACK_TEST_GATEWAY_URL=http://127.0.0.1:3002 node --env-file-if-exists=.env node_modules/vitest/vitest.mjs run --no-file-parallelism apps/llm-gateway/test/stack.test.ts apps/llm-gateway/test/stack-money.test.ts
npm run down
```

- `stack-money.test.ts` ждёт финального статуса роя опросом раз в 0,5 с до 240 с; его тесты идут до 5 минут. Без `--no-file-parallelism` рой из `stack.test.ts` может жить во время глобальной проверки `docker ps -a --filter label=swag.kind` в AC-004-35 и дать ложный провал, поэтому файлы идут по одному.
- AC-004-33 без стека — `apps/llm-gateway/test/security-postgres.test.ts` на Postgres (`POSTGRES_TEST_URL`): вызов с маркером через HTTP, логи и спаны в памяти, таблицы 4.5 и отчёт `money:report` сканируются на токен шлюза.

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
- Токен (`LLM_GATEWAY_TOKEN`) проверяется в `onRequest`, до разбора тела; сравнение через `crypto.timingSafeEqual`, разная длина — `401` без сравнения (4.2). Тот же `authorize` стоит на `/v1/*` и `/internal/*` (спека 004, REQ-004-7).
- Формат ошибки зависит от пути: `/v1/*` — как в 002 (`{ error: { message, type: 'swag_gateway_error', code } }`), `/internal/*` — `{ error: { message, code } }` без `type` (спека 004, 4.2). Выбор — в одной функции `errorBody`, ядро о формате не знает.
- Порядок старта (спека 004, REQ-004-14): миграции и `releaseHolds` до `listen`, поэтому вызов не может пройти, пока висят резервы прошлого процесса. Тест — `money-postgres.test.ts`.
- `PriceBook` — `createCatalogHolder(catalog).book`: цена модели из текущего каталога процесса; обновление цен меняет только цены, id моделей остаются. Ядро проверяет модель по каталогу раньше, чем просит цену, поэтому неизвестная модель в `prices` не доходит (4.4).
- Ядро на `closeSwarm` с id, который не UUID, отвечает `404 not_found` без обращения к Postgres (спека 004, 4.2): иначе приведение типа в `uuid` дало бы `500`. Сделано в `packages/llm-gateway-core` (T-6), тест — `test/money-register.test.ts` в ядре.
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

- 004 — 4.2 (внутренний API), 4.4 (порты ядра в оболочке), 4.9 (цены OpenRouter в оболочке), 4.10 (повтор), 4.11 (`DATABASE_URL`), 4.12 (ошибки `/internal/*`); REQ-004-7, REQ-004-14 (старт); AC-004-5, AC-004-18 (старт), AC-004-19; задача T-6. Пункты про регистрацию через оболочку, цены из OpenRouter и `[stack]` с регистрацией — T-6, T-9, T-17.
- 002 — 4.2 (`/health`, `/v1/models`, `/v1/chat/completions`, тело ошибки), 4.6, 4.9, 4.10, 4.14; REQ-002-3, REQ-002-11 (оболочка), REQ-002-13, REQ-002-14; AC-002-1, -2, -3, -4, -5, -6, -9, -10, -11, -12, -13, -14, -15, -16, -17, -18, -23, -28; REQ-002-12; AC-002-8 (вторая часть), AC-002-19; REQ-002-5 (compose: сервисы и порты, `scripts/repo.test.ts`), REQ-002-16; задачи T-20, T-21, T-22, T-23, T-24, T-25, T-26, T-27.
