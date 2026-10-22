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
npm run up
npm run infra:check
```

`npm run up` собирает образы и ждёт, пока все контейнеры станут healthy. `.env` не коммитится: учётные данные в `.env.example` только для локальной разработки. Порты сервисов публикуются только на `127.0.0.1`.

## Команды

| Команда               | Что делает                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`       | Всё по порядку до первой ошибки: `format:check`, `lint`, `typecheck`, `arch:check`, `build`, `test`, `spec:check`. Её же запускает CI |
| `npm run build`       | `tsc -b` по всем пакетам                                                                                                              |
| `npm run typecheck`   | Типы пакетов, тестов и скриптов                                                                                                       |
| `npm run lint`        | ESLint                                                                                                                                |
| `npm run format`      | Prettier: исправить; `format:check` — только проверить                                                                                |
| `npm test`            | Vitest                                                                                                                                |
| `npm run arch:check`  | Границы ядер: зависимости и импорты `packages/*-core` против белого списка                                                            |
| `npm run spec:check`  | У каждого критерия приёмки спек в работе есть тест с его id                                                                           |
| `npm run up`          | Поднять систему в Docker                                                                                                              |
| `npm run dev`         | То же в режиме разработки: правка в `src` оболочки или ядра перезапускает сервис без пересборки образа                                |
| `npm run down`        | Остановить систему                                                                                                                    |
| `npm run infra:check` | Проверить с хоста Postgres, NATS, `/health` у `api` и `orchestrator`, доступность `ui`                                                |
| `npm run agent:image` | Собрать образ агента `swag-agent:dev` для песочниц                                                                                    |

`npm run up` сначала собирает образ агента (`npm run agent:image`, профиль `agent`: `docker compose --profile agent build agent`), затем поднимает `postgres`, `nats`, `orchestrator`, `api`, `ui`. Образ агента сам по себе не стартует.

## Как открыть личный кабинет и запустить рой

- Личный кабинет: <http://127.0.0.1:4200> (`UI_PORT`). Новый рой — кнопка «Новый рой», задача и агенты по порядку цепочки.
- API напрямую: <http://127.0.0.1:3000> (`POST /swarms`, `GET /swarms/:id`, `POST /swarms/:id/stop`).
- Оркестратор: <http://127.0.0.1:3001> (только для проверки, `api` обращается к нему по сети compose).

Песочницы агентов — контейнеры с меткой `swag.kind=agent`; после роя их не остаётся: `docker ps -a --filter label=swag.kind`.

## Ядро и оболочка

Логика пишется только в ядрах `packages/<имя>-core` — чистый TypeScript без фреймворков, Node API и env; всё внешнее приходит через порты, которые объявляет ядро. Оболочки `apps/<имя>` только читают конфигурацию, собирают адаптеры, вызывают фабрику `create<Имя>Core(deps)` и переводят вход и выход. Проверяемые правила — [спека 000, раздел 4.2](docs/spec/000-foundation.md#42-правила-ядра-и-оболочки); нарушения ловят `npm run arch:check` и `typecheck`.

```
apps/        оболочки: api, orchestrator (Fastify), agent (процесс в песочнице)
apps/ui/     фронтенды (npm workspaces apps/ui/*): cabinet — личный кабинет на Angular
packages/    ядра *-core (api, orchestrator, agent, ui); contracts и api-integration (общие схемы и проекция роя);
             adapter-* (Docker, NATS, память, HTTP-оркестратор); config (env, только для оболочек)
scripts/     arch-check, spec-check, infra-check
```

## Лицензия

Проприетарная, см. [LICENSE](LICENSE). Все пакеты `private`.
