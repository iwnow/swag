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

## Команды

| Команда               | Что делает                                                                                                                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`       | Всё по порядку до первой ошибки: `format:check`, `lint`, `typecheck`, `arch:check`, `build`, `test`, `spec:check`. Её же запускает CI                                                                                                                          |
| `npm run build`       | `tsc -b` по всем пакетам                                                                                                                                                                                                                                       |
| `npm run typecheck`   | Типы пакетов, тестов и скриптов                                                                                                                                                                                                                                |
| `npm run lint`        | ESLint                                                                                                                                                                                                                                                         |
| `npm run format`      | Prettier: исправить; `format:check` — только проверить                                                                                                                                                                                                         |
| `npm test`            | Vitest                                                                                                                                                                                                                                                         |
| `npm run arch:check`  | Границы ядер: зависимости и импорты `packages/*-core` против белого списка                                                                                                                                                                                     |
| `npm run spec:check`  | У каждого критерия приёмки спек в review и done есть тест с id                                                                                                                                                                                                 |
| `npm run up`          | Поднять систему в Docker                                                                                                                                                                                                                                       |
| `npm run dev`         | То же в режиме разработки: правка в `src` оболочки или ядра перезапускает сервис без пересборки образа                                                                                                                                                         |
| `npm run down`        | Остановить систему                                                                                                                                                                                                                                             |
| `npm run infra:check` | Проверить с хоста Postgres, NATS, `/health` у `api`, доступность `ui`, `/api/health` у Grafana; `/health` у `orchestrator` — изнутри контейнера, `otel-collector` — из сети compose (порты не публикуются); `/health` у `llm-gateway` с `service: llm-gateway` |
| `npm run llm:ping`    | Один вызов через LLM Gateway с хоста: `npm run llm:ping [model] [-- --stream]`, печатает ответ, `usage` и задержку; модель по умолчанию `chat-small` (спека 002, 4.13)                                                                                         |
| `npm run agent:image` | Собрать образ агента `swag-agent:dev` для песочниц                                                                                                                                                                                                             |

`npm run up` сначала собирает образ агента (`npm run agent:image`, профиль `agent`: `docker compose --profile agent build agent`), затем поднимает `postgres`, `nats`, `lgtm`, `otel-collector`, `orchestrator`, `api`, `ui`, а также `litellm`, `llm-fake` и `llm-gateway` (спека 002, профиль моделей `LLM_PROFILE`, по умолчанию `test`). Образ агента сам по себе не стартует.

## Как открыть личный кабинет и запустить рой

- Личный кабинет: <http://127.0.0.1:4200> (`UI_PORT`). Новый рой — кнопка «Новый рой», задача и агенты по порядку цепочки.
- API напрямую: <http://127.0.0.1:3000> (`POST /swarms`, `GET /swarms/:id`, `POST /swarms/:id/stop`).
- Оркестратор наружу не публикуется: `api` обращается к нему по сети compose.

Песочницы агентов — контейнеры с меткой `swag.kind=agent`; после роя их не остаётся: `docker ps -a --filter label=swag.kind`.

## Наблюдаемость: трейсы и логи роя

Каждый рой — один трейс OpenTelemetry от `POST /swarms` через оркестратор, песочницы, агентов и сообщения NATS ([спека 016](docs/spec/016-observability.md)). Сервисы и агенты пишут JSON-логи одной схемы (`LogRecord`) в stdout (`docker compose logs api`) и вместе с трейсами шлют их в OpenTelemetry Collector, тот — в Grafana LGTM (Tempo, Loki).

- Grafana: <http://127.0.0.1:3300/grafana/> (`GRAFANA_PORT`, только `127.0.0.1`, без входа). Из личного кабинета — через прокси: <http://127.0.0.1:4200/grafana/>.
- Трейс роя из UI: в ленте события ссылка «Трейс» открывает Explore с трейсом этого события.
- Найти рой по `traceId` вручную: `traceId` есть в каждом событии (`GET /swarms/:id/events`). В Grafana → Explore → источник Tempo → запрос TraceQL — сам `traceId`. Логи трейса: из спана — кнопка «Related logs» в деталях спана, или Explore → Loki → `{service_name=~"api|orchestrator|agent"} | trace_id = "<traceId>"`. Из записи лога в Loki трейс открывается по полю `trace_id`.
- Без Collector сервисы работают: пустой `OTEL_EXPORTER_OTLP_ENDPOINT` — логи только в stdout.

## Ядро и оболочка

Логика пишется только в ядрах `packages/<имя>-core` — чистый TypeScript без фреймворков, Node API и env; всё внешнее приходит через порты, которые объявляет ядро. Оболочки `apps/<имя>` только читают конфигурацию, собирают адаптеры, вызывают фабрику `create<Имя>Core(deps)` и переводят вход и выход. Проверяемые правила — [спека 000, раздел 4.2](docs/spec/000-foundation.md#42-правила-ядра-и-оболочки); нарушения ловят `npm run arch:check` и `typecheck`.

```
apps/        оболочки: api, orchestrator (Fastify), agent (процесс в песочнице), llm-gateway (Fastify)
apps/ui/     фронтенды (npm workspaces apps/ui/*): cabinet — личный кабинет на Angular
packages/    ядра *-core (api, orchestrator, agent, ui, llm-gateway); contracts и api-integration (общие схемы и проекция роя);
             adapter-* (Docker, NATS, память, HTTP-оркестратор); config (env, только для оболочек)
scripts/     arch-check, spec-check, infra-check
```

## Лицензия

Проприетарная, см. [LICENSE](LICENSE). Все пакеты `private`.
