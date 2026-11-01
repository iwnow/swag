# Swag

Платформа роёв агентов: оркестратор поднимает песочницы, агентам подключаются скиллы из реестра, агенты общаются через изолированную шину роя, пользователь видит граф роя и расходы в реальном времени.

- Что и зачем — [AI_PLATFORM_ROADMAP.md](AI_PLATFORM_ROADMAP.md).
- Как именно — спецификации в [docs/spec/](docs/spec/README.md).
- Устройство кода — [docs/architecture.md](docs/architecture.md).

## Требования

- Node 24 LTS — точная версия в [.nvmrc](.nvmrc), npm 11+. Менеджер пакетов — только npm (`engine-strict=true`).
- Docker с Compose v2.22+ (`docker compose watch` для `npm run dev`).

## Запуск с нуля

```bash
nvm use
npm ci
cp .env.example .env
cp .env.llm.example .env.llm
npm run up
npm run infra:check
```

`npm run up` собирает образы и ждёт, пока все контейнеры станут healthy. `.env` и `.env.llm` не коммитятся: учётные данные в `.env.example` и `.env.llm.example` только для локальной разработки. Ключи провайдеров моделей лежат только в `.env.llm`, его читают `litellm` и `llm-gateway` (спека 002). Порты сервисов публикуются только на `127.0.0.1`.

## LLM Gateway (спека 002)

Все вызовы моделей идут через `llm-gateway`: OpenAI-совместимый API на `127.0.0.1:${LLM_GATEWAY_PORT}` (по умолчанию 3002), за ним LiteLLM. Сервисы compose:

- `llm-gateway` — оболочка `apps/llm-gateway` и ядро `packages/llm-gateway-core`; в сетях `default` и `llm`; наружу — только `127.0.0.1`. Зависит от `postgres` (спека 004): бюджеты, ledger и цены, миграции при старте; `DATABASE_URL` — общая переменная из `.env`.
- `litellm` — только в сети `llm`, порт не публикуется. Переводит форматы провайдеров, виртуальные ключи и БД не используются (D-21).
- `llm-fake` — фейковый провайдер `infra/llm/fake-provider/server.ts`, в той же сети `llm`, порт не публикуется. Compose поднимает его при любом профиле (`litellm` ждёт его в `depends_on`), но модели ходят в него только в профиле `test`.

Сеть `llm` не `internal`: LiteLLM нужен выход к провайдерам. Из сети `default` (роя, `api`, `orchestrator`, песочниц) до `litellm` не дойти.

**`.env.llm`** — ключи провайдеров и мастер-ключ LiteLLM. Файл в `.gitignore` (`.env.*`), в git не попадает; шаблон — `.env.llm.example`.

| Переменная              | Кто читает                                                                      | Что это                                           |
| ----------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------- |
| `LITELLM_MASTER_KEY`    | `litellm`, `llm-gateway`                                                        | мастер-ключ LiteLLM (`sk-…`)                      |
| `FAKE_PROVIDER_API_KEY` | `litellm` (вызов провайдера), `llm-gateway` (только для redact ошибок апстрима) | ключ фейкового провайдера, для `test`             |
| `OPENROUTER_API_KEY`    | `litellm` (вызов провайдера), `llm-gateway` (только для redact ошибок апстрима) | ключ OpenRouter для профилей `dev` и `prod` (Q-2) |

Только контейнеры `litellm` и `llm-gateway` получают `.env.llm`. `api`, `orchestrator`, `ui` и песочницы агентов его не получают и ключей не видят (AC-002-21, AC-002-22). `api` и `orchestrator` получают из `.env` только переменные, которые читает их конфиг: в `compose.yaml` — явный `environment` вместо `env_file: .env` (D-73), поэтому чужие ключи, например `CONTEXT7_API_KEY`, в них не попадают. В `.env.llm.example` значения фейковые; `OPENROUTER_API_KEY` пуст.

**Профили `LLM_PROFILE`** (в `.env`, по умолчанию `test`) выбирают каталог `infra/llm/<профиль>/`: `litellm.yaml` (маршруты моделей и ключи только через `os.environ/…`) и `models.json` (каталог и цены). Имена моделей платформы одни и те же во всех профилях — `chat-small` и `chat-large` (Q-4), поэтому код при смене профиля не меняется.

- `test` — фейк из compose; цены условные (`chat-small` 3.00 / 0.30 / 15.00 USD за 1 млн токенов, нужны для проверки формулы). `npm run check` и CI работают на `test` без ключей.
- `dev` — бесплатные модели OpenRouter с суффиксом `:free`, цены `0`. Суточные лимиты бесплатных моделей допустимы для разработки.
- `prod` — платные модели OpenRouter, цены из `models.json`. Модели, даты и источники цен — в [README `apps/llm-gateway`](apps/llm-gateway/README.md).

Цены моделей `dev` и `prod` обновляются из OpenRouter без ключа: `llm-gateway` читает `OPENROUTER_MODELS_URL` (по умолчанию `https://openrouter.ai/api/v1/models`) каждые `LLM_PRICES_REFRESH_MS` мс (по умолчанию 3600000; `0` — выключено; профиль `test` запросов не делает). Переменные — в `.env` (спека 004, 4.9, 4.11).

Профиль `dev` или `prod` требует `OPENROUTER_API_KEY` в `.env.llm`. Ключ должен быть обычным API-ключом: management-ключ OpenRouter модели не вызывает (журнал спеки 002, T-31).

**Проверка.**

- `npm run llm:ping [model] [-- --stream]` — с хоста регистрирует рой со случайным `swarmId` (бюджет 1000000, `agent-1`, истекает через 5 минут), делает один вызов через gateway, печатает ответ, `usage` и задержку, затем закрывает рой (спека 004, 4.13).
- `npm run money:report -- [--swarm <uuid>] [--since <ISO>]` — сверка ledger: сколько списано по тарифу, сколько вызовы стоили у провайдера и разница по тем же вызовам; читает `DATABASE_URL` из `.env`, без фильтров — весь ledger (спека 004, 4.5, 4.13). Пример вывода:

  ```
  calls 12 · charged $0.0421 (usage 11 / $0.0418, estimate 1 / $0.0003, none 0)
  provider $0.0415 по 11 вызовам · без факта 1
  charged vs provider по тем же вызовам: $0.0418 vs $0.0415 · +0.72%
  ```

  Суммы — в долларах с четырьмя знаками, округление вверх; при `provider = 0` разница — `n/a`. Формат строк — спека 004, 4.13.

- `npm run infra:check` — проверяет `/health` у `llm-gateway` (`service: llm-gateway`).
- Замер задержки NFR-002-1 (p95 поверх апстрима, порог 20 мс в спеке, в CI не проверяется): `LLM_GATEWAY_BENCH=1 npx vitest run apps/llm-gateway/test/nfr-latency.test.ts`. Без переменной тест пропускается.
- Стек-тесты `apps/llm-gateway/test/stack.test.ts` идут против поднятого стека при `STACK_TEST_GATEWAY_URL=http://127.0.0.1:3002`; без неё пропускаются.

## Команды

| Команда                 | Что делает                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`         | Всё по порядку до первой ошибки: `format:check`, `lint`, `typecheck`, `arch:check`, `build`, `test`, `spec:check`. Её же запускает CI                                                                                                                                                                                                                           |
| `npm run build`         | `tsc -b` по всем пакетам                                                                                                                                                                                                                                                                                                                                        |
| `npm run typecheck`     | Типы пакетов, тестов и скриптов                                                                                                                                                                                                                                                                                                                                 |
| `npm run lint`          | ESLint                                                                                                                                                                                                                                                                                                                                                          |
| `npm run format`        | Prettier: исправить; `format:check` — только проверить                                                                                                                                                                                                                                                                                                          |
| `npm test`              | Vitest                                                                                                                                                                                                                                                                                                                                                          |
| `npm run arch:check`    | Границы ядер: зависимости и импорты `packages/*-core` против белого списка                                                                                                                                                                                                                                                                                      |
| `npm run spec:check`    | У каждого критерия приёмки спек в review и done есть тест с id                                                                                                                                                                                                                                                                                                  |
| `npm run up`            | Поднять систему в Docker                                                                                                                                                                                                                                                                                                                                        |
| `npm run dev`           | То же в режиме разработки: правка в `src` оболочки или ядра перезапускает сервис без пересборки образа                                                                                                                                                                                                                                                          |
| `npm run down`          | Остановить систему                                                                                                                                                                                                                                                                                                                                              |
| `npm run infra:check`   | Проверить с хоста Postgres, NATS, `/health` у `api` и `identity`, доступность `ui` и remote кабинета через прокси каркаса (`/mf/cabinet/remoteEntry.json`), `/api/health` у Grafana, UI Mailpit; `/health` у `orchestrator` — изнутри контейнера, `otel-collector` — из сети compose (порты не публикуются); `/health` у `llm-gateway` с `service: llm-gateway` |
| `npm run db:migrate`    | Применить миграции схемы роёв (`packages/adapter-postgres`) к базе из `DATABASE_URL`, адрес хоста — `127.0.0.1`, как у `infra:check` (спека 003, 4.6)                                                                                                                                                                                                           |
| `npm run llm:ping`      | Регистрирует рой, один вызов через LLM Gateway с хоста и закрытие роя: `npm run llm:ping [model] [-- --stream]`, печатает ответ, `usage` и задержку; модель по умолчанию `chat-small` (спека 002, 4.13; регистрация и закрытие — спека 004, 4.13)                                                                                                               |
| `npm run money:report`  | Сверка ledger: списано по тарифу, стоимость провайдера и разница по тем же вызовам; фильтры `--swarm <uuid>` и `--since <ISO>` (спека 004, 4.5, 4.13)                                                                                                                                                                                                           |
| `npm run identity:keys` | Выпускает ключ подписи токенов identity (Ed25519). Без аргументов печатает пару: base64 от PEM PKCS8/SPKI; `-- --write-env` без пути пишет `IDENTITY_JWT_PRIVATE_KEY` и `IDENTITY_JWT_PUBLIC_KEY` в `.env` в корне (с путём — в указанный файл) и в консоль ключи не выводит (спека 012, 4.11; спека 024, 4.14)                                                 |
| `npm run agent:image`   | Собрать образ агента `swag-agent:dev` для песочниц                                                                                                                                                                                                                                                                                                              |
| `npm run images:prune`  | Удалить старые образы swag без тега (`<none>`), оставшиеся от пересборок                                                                                                                                                                                                                                                                                        |

Тесты `adapter-postgres` и `apps/api` (хранилище роёв, спека 003) идут против Postgres при заданной `POSTGRES_TEST_URL` (в `.env.example` — база из compose на `127.0.0.1`); без неё пропускаются. Замер NFR-003-2 (p50 и p95 `appendEvent` на 1000 событий): `POSTGRES_BENCH=1 npx vitest run packages/adapter-postgres/test/bench.test.ts`.

`npm run up` сначала собирает образ агента (`npm run agent:image`, профиль `agent`: `docker compose --profile agent build agent`), затем поднимает `postgres`, `nats`, `lgtm`, `otel-collector`, `orchestrator`, `api`, `identity`, `ui` (каркас) и `ui-cabinet` (микрофронтенд кабинета, порт не публикуется), а также `litellm`, `llm-fake` и `llm-gateway` (спека 002, профиль моделей `LLM_PROFILE`, по умолчанию `test`). Образ агента сам по себе не стартует. `orchestrator` ждёт `llm-gateway` (`service_healthy`): агенты ходят в модель только через него (спека 022, 4.8). В конце `npm run up` удаляет образы swag, которые остались без тега после пересборки (`npm run images:prune`): `npm run down` образы не трогает, и без чистки они копятся, примерно по 450 МБ на каждую пересборку сервиса. Чистка затрагивает только образы с меткой проекта compose `swag`; кэш сборки не трогается (`docker builder prune`). `api` ждёт `postgres` (`service_healthy`) и при старте применяет миграции схемы роёв до приёма запросов, затем закрывает рои, прерванные перезапуском (спека 003, 4.5).

## Как открыть личный кабинет и запустить рой

- Открывать в браузере — каркас: <http://127.0.0.1:4200> (`UI_PORT`): вход, шапка и разделы. Экраны роёв и баланса (личный кабинет) каркас подгружает из сервиса `ui-cabinet` (Native Federation remote, `/mf/cabinet/`); порт 4201 наружу не публикуется, проверка — `npm run infra:check`. Без входа страницы роёв ведут на `/login` (спека 024, вход по учётной записи из identity). Роли: `user` видит свои рои, `admin` — рои своей организации, супервизор — все рои платформы. Новый рой — кнопка «Новый рой»: задача, агенты с ролями и модель каждого (`chat-small` по умолчанию, `chat-large`). Первый агент в списке — вход: получает задачу, пишет остальным через `send_message` и завершает рой инструментом `finish` (спека 022).
- Каждый шаг агента — вызов модели через `llm-gateway`; токены и стоимость видны в ленте как `llm.call`. Профиль моделей — `LLM_PROFILE` в `.env`: `test` (фейковый провайдер, без ключей, он же в CI), `dev` (бесплатные модели OpenRouter, нужен `OPENROUTER_API_KEY` в `.env.llm`) или `test-pay` (дешёвые платные модели OpenRouter без reasoning для платных проверок, спека 032; команда `LLM_PROFILE=test-pay npm run up`, тот же ключ). `prod` для платных проверок не используется.
- Лимиты агентов — в `.env`: `AGENT_MAX_STEPS` (вызовов модели на агента), `AGENT_MAX_TOKENS` (`max_tokens` вызова), `SWARM_TIMEOUT_MS` (таймаут роя). Адрес gateway для песочниц — `DOCKER_AGENT_LLM_GATEWAY_URL`.
- API напрямую: <http://127.0.0.1:3000> (`POST /swarms`, `GET /swarms`, `GET /swarms/:id`, `GET /swarms/:id/events`, `POST /swarms/:id/stop`). Каждый запрос, кроме `/health`, несёт `Authorization: Bearer <accessToken>` из `POST /auth/login` (identity, `127.0.0.1:3003`); без токена — `401 unauthorized`, токен заблокированного или отозванного — `401`, при недоступных отзывах — `503 auth_unavailable`. Создание роя супервизором — `403` (роёв он не создаёт), чтение роя вне своей области — `404`.
- Оркестратор наружу не публикуется: `api` обращается к нему по сети compose.

Песочницы агентов — контейнеры с меткой `swag.kind=agent`; после роя их не остаётся: `docker ps -a --filter label=swag.kind`.

## Наблюдаемость: трейсы и логи роя

Каждый рой — один трейс OpenTelemetry от `POST /swarms` через оркестратор, песочницы, агентов и сообщения NATS ([спека 016](docs/spec/016-observability.md)). Сервисы и агенты пишут JSON-логи одной схемы (`LogRecord`) в stdout (`docker compose logs api`) и вместе с трейсами шлют их в OpenTelemetry Collector, тот — в Grafana LGTM (Tempo, Loki).

- Grafana: <http://127.0.0.1:3300/grafana/> (`GRAFANA_PORT`, только `127.0.0.1`, без входа). Из каркаса — через прокси: <http://127.0.0.1:4200/grafana/>.
- Трейс роя из UI: в ленте события ссылка «Трейс» открывает Explore с трейсом этого события.
- Найти рой по `traceId` вручную: `traceId` есть в каждом событии (`GET /swarms/:id/events`). В Grafana → Explore → источник Tempo → запрос TraceQL — сам `traceId`. Логи трейса: из спана — кнопка «Related logs» в деталях спана, или Explore → Loki → `{service_name=~"api|orchestrator|agent"} | trace_id = "<traceId>"`. Из записи лога в Loki трейс открывается по полю `trace_id`.
- Без Collector сервисы работают: пустой `OTEL_EXPORTER_OTLP_ENDPOINT` — логи только в stdout.
- Срок хранения телеметрии — `TELEMETRY_RETENTION` в `.env`: часы, не меньше `24h` (спека 003, 4.7). Одно значение для Loki, Tempo и Prometheus в `lgtm`; конфиги Loki и Tempo — `infra/lgtm/`. Dev — `24h` (в `.env.example`), прод — `168h`. Переменная обязательна: без неё `npm run infra:check` падает с ошибкой конфигурации, а compose подставляет пустое значение.

## Регистрация и вход: identity и Mailpit (спека 012)

Сервис `identity` — регистрация компании, подтверждение по письму, вход, обновление и выход. Почту в dev отдаёт `mailpit`.

- Разовая подготовка: `npm run identity:keys -- --write-env` пишет пару ключей подписи токенов `IDENTITY_JWT_PRIVATE_KEY` и `IDENTITY_JWT_PUBLIC_KEY` в `.env` (ключи в консоль не выводятся). Без приватного ключа `identity` не стартует; публичный нужен `api` для проверки токенов (спека 024, 4.14).
- Запуск: `npm run up` поднимает `identity` и `mailpit`; `identity` ждёт Postgres, миграции и супервизора выполняются до приёма запросов.
- Порты только на `127.0.0.1`: `identity` — <http://127.0.0.1:3003> (`IDENTITY_PORT`, эндпоинты под `/auth`, `GET /health`); Mailpit UI и API писем — <http://127.0.0.1:8025> (`MAILPIT_UI_PORT`); SMTP — `127.0.0.1:1025`.
- Письма: все регистрационные письма видны в UI Mailpit. Ссылка подтверждения ведёт на `IDENTITY_CONFIRM_URL` (страница UI из спеки 014 ещё не готова). Письма живут до перезапуска `mailpit`, у сервиса нет volume.
- Супервизор: `IDENTITY_SUPERVISOR_EMAIL` и `IDENTITY_SUPERVISOR_PASSWORD` задаются вместе или оба пусты. При старте супервизор создаётся, если его ещё нет. Значения — в `.env`.
- Стек-тесты: `STACK_TEST_IDENTITY_URL` и `STACK_TEST_MAILPIT_URL` в `.env`; `set -a; . ./.env; set +a; npx vitest run apps/identity/test/stack.test.ts`.
- Стек-тест доступа (спека 024, T-17): `apps/api/test/stack.test.ts` (AC-024-24) против поднятого `npm run up`. Нужны `STACK_TEST_API_URL` (`http://127.0.0.1:3000`, в `.env.example` и `.env`), `STACK_TEST_IDENTITY_URL`, `STACK_TEST_MAILPIT_URL`, `IDENTITY_SUPERVISOR_EMAIL`, `IDENTITY_SUPERVISOR_PASSWORD`; без `STACK_TEST_API_URL` пропускается. Тест регистрирует две компании через Mailpit, создаёт рой и блокирует пользователя; замер блокировки печатается как `NFR-024-1`. Тест использует адреса `@example.test` со случайным суффиксом и регистрирует две компании: лимит регистраций 4.8 (10 в час с IP) считается в памяти процесса identity, поэтому после частых прогонов помогает перезапуск `identity`.
- Порядок запуска с нуля: `npm run identity:keys -- --write-env` (ключи подписи), `npm run up` (образы `api` и `orchestrator` требуют `IDENTITY_*`, `ORCHESTRATOR_TOKEN` из `.env`, compose передаёт их явно), затем стек-тесты из этого раздела.

## Ядро и оболочка

Логика пишется только в ядрах `packages/<имя>-core` — чистый TypeScript без фреймворков, Node API и env; всё внешнее приходит через порты, которые объявляет ядро. Оболочки `apps/<имя>` только читают конфигурацию, собирают адаптеры, вызывают фабрику `create<Имя>Core(deps)` и переводят вход и выход. Проверяемые правила — [спека 000, раздел 4.2](docs/spec/000-foundation.md#42-правила-ядра-и-оболочки); нарушения ловят `npm run arch:check` и `typecheck`.

```
apps/        оболочки: api, orchestrator (Fastify), agent (процесс в песочнице), llm-gateway (Fastify)
apps/ui/     фронтенды (npm workspaces apps/ui/*): shell — каркас входа и навигации (Angular, Native Federation), cabinet — личный кабинет на Angular
packages/    ядра *-core (api, orchestrator, agent, ui, llm-gateway); contracts и api-integration (общие схемы и проекция роя);
             adapter-* (Docker, NATS, память, Postgres, HTTP-оркестратор); config (env, только для оболочек)
scripts/     arch-check, spec-check, infra-check, llm-ping, db-migrate, identity-keys
```

## Лицензия

Проприетарная, см. [LICENSE](LICENSE). Все пакеты `private`.
