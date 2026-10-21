---
id: "000"
title: Каркас проекта
status: blocked
roadmap_stage: 0
depends_on: []
superseded_by: null
updated: 2026-10-21
---

# 000. Каркас проекта

> **Коротко.** Пустой, но рабочий репозиторий Swag, в котором агент может разрабатывать по спекам.
> - **Ядро отдельно от оболочки.** Логика каждого сервиса — в пакете-ядре `packages/<имя>-core` на чистом TypeScript, без фреймворков, Node API и инфраструктуры. Оболочка в `apps/<имя>` (Fastify, процесс агента в песочнице, позже UI) только подключает ядро и даёт к нему вход. Правило проверяется автоматически (`arch:check`).
> - **Монорепо на npm workspaces**, пакеты `@swag/<имя>`: ядра `api-core`, `orchestrator-core`, `agent-core`; оболочки `apps/api`, `apps/orchestrator`, `apps/agent`; общие `contracts`, `config`. Пока это заглушки.
> - **Всё работает в Docker**: `npm run up` поднимает Postgres, MinIO, NATS, `api` и `orchestrator`; `npm run dev` делает то же с перезапуском сервиса при правке кода.
> - **Рантайм — Node 24 LTS везде**, включая агента в песочнице. Время холодного старта агента замеряется как точка отсчёта.
> - **Одна команда проверки** `npm run check`: формат → линтер → типы → границы ядер → сборка → тесты → `spec:check`. Её запускают агент перед сдачей и GitHub Actions на каждый push.
> - **Лицензия**: все пакеты `private`, ссылаются на проприетарный `LICENSE`.
> - **Вопросы закрыты**, спека готова к запуску: `/implement-spec 000`. Для AC-000-15 нужен репозиторий на GitHub и push.

## 1. Контекст и цель

Этап 0 [роадмапа](../../AI_PLATFORM_ROADMAP.md#этапы). Сейчас в репозитории только документация. Нужен монорепо, в котором одной командой поднимается вся система в Docker, а проверки запускаются одной командой локально и в CI. На этом каркасе агент реализует остальные спеки.

Главное архитектурное правило закладывается здесь, пока кода нет: логика живёт в ядрах, которые не знают, кто их вызывает. Одно и то же ядро можно подключить к Fastify, к консольной команде, к eval-прогону или к UI на любом фреймворке.

## 2. Объём

**Входит:**
- монорепо на npm workspaces со структурой из 4.1;
- ядра-заглушки и оболочки-заглушки по правилам из 4.2;
- `npm run arch:check` — автоматическая проверка границ ядер;
- общая конфигурация TypeScript, линтера, форматтера, тестов;
- `compose.yaml`: Postgres, MinIO (+ создание бакета), NATS с JetStream, сервисы `api` и `orchestrator`;
- Dockerfile для `api`, `orchestrator` и `agent` (Node);
- эндпоинт `GET /health` у `api` и `orchestrator`;
- скрипты `infra:check`, `spec:check`, `arch:check`, `check`;
- GitHub Actions;
- `.env.example`, правила работы с секретами;
- поля лицензии в `package.json`.

**Не входит:**
- схемы БД, событий и ledger (спека 001);
- LiteLLM (спека 003);
- доступ `orchestrator` к Docker socket и создание песочниц (спека 004);
- любая бизнес-логика: в ядрах только заглушка `info()` со smoke-тестом;
- адаптеры инфраструктуры (Postgres, NATS, Docker, S3) — появляются в спеках, где нужны;
- UI: ни `apps/ui`, ни `packages/ui-core` (спека 010), в 000 только `apps/ui/README.md`;
- консольная оболочка: основной вход — UI, консоль добавим, если понадобится (Q-5);
- Bun и Deno (Q-4);
- production-сборки образов и деплой.

## 3. Требования

| ID | Требование | Приоритет |
|---|---|---|
| REQ-000-1 | Репозиторий MUST быть монорепо на **npm workspaces** со структурой из 4.1. pnpm, yarn и bun как менеджер пакетов не используются; lock-файл — только `package-lock.json`. | MUST |
| REQ-000-2 | TypeScript MUST работать в режиме `strict`, ESM, с общим `tsconfig.base.json`. | MUST |
| REQ-000-3 | Версии MUST быть зафиксированы: Node 24 LTS (`.nvmrc`, `engines.node`), npm (`engines.npm`), `engine-strict=true` в `.npmrc`; базовый образ Docker — `node:24.x` с точным тегом. | MUST |
| REQ-000-4 | `api`, `orchestrator` и `agent` MUST работать на Node 24 в Docker. | MUST |
| REQ-000-5 | `compose.yaml` в корне MUST поднимать `postgres`, `minio`, `minio-init` (создаёт бакет), `nats` (JetStream), `api`, `orchestrator` с healthcheck. Версии образов — точный тег, `latest` запрещён. | MUST |
| REQ-000-6 | `npm run dev` MUST поднимать систему в режиме разработки: при изменении файла в `src` оболочки или ядра сервис перезапускается в контейнере без пересборки образа. Способ (нативный type stripping Node 24, `tsx`, `tsc --watch`) выбирает агент и фиксирует в журнале. | MUST |
| REQ-000-7 | Корневые npm-скрипты MUST работать из чистого клона: `build`, `lint`, `typecheck`, `arch:check`, `test`, `format:check`, `spec:check`, `check`, `up`, `dev`, `down`, `infra:check`. | MUST |
| REQ-000-8 | `npm run check` MUST запускать по порядку `format:check`, `lint`, `typecheck`, `arch:check`, `build`, `test`, `spec:check`, останавливаться на первой ошибке и завершаться с её кодом. | MUST |
| REQ-000-9 | Конфигурация сервисов MUST читаться из env и проверяться Zod-схемой в `packages/config`. Ошибка — сообщение с именем переменной и выход с кодом ≠ 0. `config` используют только оболочки; ядро получает уже проверенные значения аргументами. | MUST |
| REQ-000-10 | В репозитории MUST быть `.env.example` со всеми переменными; `.env` MUST быть в `.gitignore`. Compose читает `.env`. | MUST |
| REQ-000-11 | `npm run spec:check` MUST реализовывать проверку из 4.6. | MUST |
| REQ-000-12 | GitHub Actions MUST на каждый push и pull request выполнять `npm ci` и `npm run check` на Node из `.nvmrc`. | MUST |
| REQ-000-13 | Корневой и все workspace-`package.json` MUST содержать `"private": true` и `"license": "SEE LICENSE IN LICENSE"`. | MUST |
| REQ-000-14 | В каждом workspace SHOULD быть хотя бы один smoke-тест. | SHOULD |
| REQ-000-15 | Ядра (`packages/*-core`) MUST соблюдать правила из 4.2: зависимости и импорты только из белого списка, без Node API и глобалов окружения, вся связь с внешним миром — через порты, которые передаёт оболочка. | MUST |
| REQ-000-16 | Оболочки (`apps/*`) MUST NOT содержать бизнес-логики: только разбор входа, вызов ядра, преобразование результата в ответ, сборку зависимостей (адаптеров) для ядра. | MUST |
| REQ-000-17 | `npm run arch:check` MUST реализовывать проверку из 4.5. | MUST |

## 4. Контракты

### 4.1. Структура репозитория

```
apps/                     # оболочки: тонкий слой над ядром
  api/                    # Fastify, Node → @swag/api-core (заглушка с /health)
  orchestrator/           # Fastify, Node → @swag/orchestrator-core (заглушка с /health)
  agent/                  # процесс в песочнице, Node → @swag/agent-core (заглушка)
  ui/                     # только README, приложение и ui-core — спека 010
packages/
  api-core/               # ядро API: координатор, рои, расходы, позже пользователи и проекты
  orchestrator-core/      # ядро оркестратора: алгоритмы исполнения плана роя
  agent-core/             # ядро агента: агентный цикл
  contracts/              # общие Zod-схемы и типы (наполняется с 001)
  config/                 # загрузка и Zod-проверка env — только для оболочек
scripts/
  spec-check.ts
  arch-check.ts
  infra-check.ts
skills/                   # содержимое реестра скиллов (.gitkeep)
evals/                    # eval-набор (.gitkeep, наполняется в 002)
compose.yaml
.env.example
LICENSE
docs/
```

Имена пакетов: `@swag/<имя каталога>`, например `@swag/orchestrator-core`, `@swag/api`. Пакеты не публикуются в npm, поэтому занятость scope `@swag` в публичном реестре значения не имеет.

Пара «ядро — оболочка» называется одинаково: `apps/<имя>` подключает `packages/<имя>-core`. Новая оболочка для того же ядра (консоль, eval-прогон, другой фреймворк) — новый каталог в `apps/`, ядро при этом не меняется.

### 4.2. Правила ядра и оболочки

Принцип и мотивация — [docs/architecture.md](../architecture.md). Здесь — проверяемая часть.

**Ядро** (`packages/*-core`):
1. Зависимости в `package.json` — только из белого списка: `zod`, `@swag/contracts`. Расширение списка — правкой этой спеки или спеки, где понадобилось, с обоснованием.
2. Импорты в `src` — только относительные и пакеты из белого списка. Запрещены `node:*` и встроенные модули Node, фреймворки и клиенты инфраструктуры (Fastify, dockerode, NATS, pg, AWS SDK, Angular, React и т. п.).
3. Ядро не обращается к окружению: нет `process`, `Bun`, `Deno`, `window`, `document`, чтения файлов и env. `tsconfig` ядра: `"lib": ["ES2023"]` без DOM, `"types": []` — обращение к ним даёт ошибку `typecheck`.
4. Всё внешнее — через **порты**: интерфейсы, объявленные в ядре (например, `SandboxProvider`, `Clock`, `IdGenerator`, хранилища). Реализации портов — **адаптеры** — живут вне ядра и передаются оболочкой в фабрику ядра.
5. Точка входа ядра — фабрика `create<Имя>Core(deps)`, которая принимает порты и настройки и возвращает объект с операциями. Глобального состояния и синглтонов нет: два вызова фабрики дают два независимых ядра.
6. Ядро работает одинаково в Node, Bun и браузере.

**Оболочка** (`apps/*`):
1. Читает конфигурацию (`@swag/config`), собирает адаптеры, вызывает фабрику ядра.
2. Переводит вход (HTTP-запрос, аргументы команды, сообщение шины) в вызов ядра, а результат — в ответ. Решений, расчётов и правил предметной области в оболочке нет.

**Адаптеры инфраструктуры** (Postgres, NATS, Docker, S3, LiteLLM) появляются с 001 и дальше в пакетах `packages/adapter-<технология>`, чтобы одну реализацию порта могли использовать разные оболочки. В 000 их нет.

```ts
// packages/contracts/src/service-info.ts
export const ServiceInfo = z.object({
  service: z.enum(['api', 'orchestrator', 'agent']),
  version: z.string().min(1),
});
export type ServiceInfo = z.infer<typeof ServiceInfo>;

// packages/orchestrator-core/src/index.ts — так же api-core и agent-core
export interface OrchestratorCoreDeps {
  version: string; // передаёт оболочка: ядро не читает package.json
}
export interface OrchestratorCore {
  info(): ServiceInfo;
}
export function createOrchestratorCore(deps: OrchestratorCoreDeps): OrchestratorCore;
```

### 4.3. Переменные окружения

| Переменная | Пример в `.env.example` | Назначение |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `swag` / `swag-local` / `swag` | Postgres в compose |
| `DATABASE_URL` | `postgres://swag:swag-local@postgres:5432/swag` | для сервисов внутри compose |
| `S3_ENDPOINT` | `http://minio:9000` | MinIO |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | `swag` / `swag-local-secret` | MinIO, только локально |
| `S3_BUCKET` | `swag` | создаётся `minio-init` |
| `NATS_URL` | `nats://nats:4222` | NATS |
| `API_PORT` / `ORCHESTRATOR_PORT` | `3000` / `3001` | порты сервисов |

`infra:check` запускается с хоста и обращается к сервисам через `localhost` (переменные с суффиксом `_HOST_URL` или подстановка хоста — на выбор агента, зафиксировать в `.env.example`).

```ts
// packages/config/src/index.ts
export const BaseConfig = z.object({
  DATABASE_URL: z.string().url(),
  S3_ENDPOINT: z.string().url(),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  NATS_URL: z.string().url(),
});
export function loadConfig<T extends z.ZodTypeAny>(schema: T, env = process.env): z.infer<T>;
```

### 4.4. Сервисы

`GET /health` у `api` и `orchestrator` → `200 {"status":"ok", ...core.info()}`, то есть `{"status":"ok","service":"api"|"orchestrator","version":"<version из package.json оболочки>"}`. Контроллер только вызывает `info()` ядра. На этот эндпоинт ссылается healthcheck в compose.

Заглушка `apps/agent` при запуске вызывает `createAgentCore(...).info()` и печатает версию Node и `agent ok`.

Порты всех контейнеров публикуются только на `127.0.0.1`.

### 4.5. `npm run arch:check`

1. Находит все workspace-пакеты `packages/*-core`.
2. Проверяет `dependencies` и `peerDependencies` каждого ядра: всё вне белого списка из 4.2 — нарушение.
3. Разбирает импорты (`import`, `export … from`, динамический `import()`) в `src/**/*.ts` ядра через TypeScript compiler API, без регулярных выражений. Нарушение — спецификатор не относительный и не из белого списка.
4. Выход 0 — нарушений нет. Выход 1 — список `<пакет>: <файл>:<строка> — запрещённый импорт <спецификатор>` или `<пакет>: запрещённая зависимость <имя>`.

### 4.6. `npm run spec:check`

1. Читает все `docs/spec/[0-9][0-9][0-9]-*.md`, из YAML frontmatter берёт `id` и `status`.
2. Для спек со статусом `in-progress`, `review` или `done` собирает id критериев из строк вида `- **AC-NNN-n**`. Критерии с `` `[manual]` `` сразу после id пропускает.
3. Ищет каждый id как подстроку в файлах `**/*.test.ts` и `**/*.spec.ts` (без `node_modules`, `dist`).
4. Выход 0 — все найдены. Выход 1 — список `spec NNN: AC-NNN-n — нет теста`.
5. Спеки с другими статусами не проверяет.

### 4.7. `npm run infra:check`

Проверяет с хоста: Postgres (`select 1`), MinIO (бакет `S3_BUCKET` существует), NATS (подключение + JetStream `accountInfo`), `api` и `orchestrator` (`/health` → 200). Печатает статус каждого. Выход 0 — всё доступно, иначе 1.

## 5. Критерии приёмки

- **AC-000-1** — *Given* чистый клон и Node 24, *When* `npm ci && npm run build`, *Then* обе команды завершаются с кодом 0.
- **AC-000-2** — *Given* валидный env, *When* `loadConfig(BaseConfig)`, *Then* возвращается типизированный объект.
- **AC-000-3** — *Given* env без `DATABASE_URL`, *When* `loadConfig(BaseConfig)`, *Then* ошибка, в тексте которой есть `DATABASE_URL`.
- **AC-000-4** — *Given* запущенный `api`, *When* `GET /health`, *Then* `200` и тело по контракту 4.4. (Тест — через `fastify.inject`, без Docker.)
- **AC-000-5** — то же для `orchestrator`.
- **AC-000-6** — *Given* спека-фикстура в статусе `review` с AC без теста, *When* `spec:check`, *Then* выход 1 и в выводе есть id этого AC.
- **AC-000-7** — *Given* спека-фикстура в статусе `review`, у всех AC есть тесты, кроме `[manual]`, *When* `spec:check`, *Then* выход 0.
- **AC-000-8** — *Given* спека-фикстура в статусе `draft` без тестов, *When* `spec:check`, *Then* она не влияет на результат.
- **AC-000-9** — *Given* репозиторий, *When* проверяются все `package.json`, *Then* у каждого `"private": true` и `"license": "SEE LICENSE IN LICENSE"`.
- **AC-000-10** — *Given* репозиторий, *When* проверка, *Then* `.env` есть в `.gitignore` и не отслеживается git.
- **AC-000-11** `[manual]` — *Given* Docker запущен и `.env` скопирован из `.env.example`, *When* `npm run up`, затем `npm run infra:check`, *Then* все контейнеры healthy не позже 90 с, `infra:check` завершается с кодом 0. Проверка: приложить вывод в журнал.
- **AC-000-12** `[manual]` — *Given* `npm run dev`, *When* изменить `version` или ответ `info()` в `packages/api-core/src`, *Then* через ≤ 5 с `GET /health` возвращает новое значение без пересборки образа. Проверка: описать шаги и время в журнале.
- **AC-000-13** `[manual]` — *Given* образ `agent`, *When* `docker run --rm` образа, *Then* заглушка печатает версию Node и `agent ok`, выход 0.
- **AC-000-14** `[manual]` — *Given* ошибка линтера в коде, *When* `npm run check`, *Then* выход ≠ 0 на шаге `lint`, следующие шаги не запускаются; после исправления — выход 0. Проверка: оба прогона в журнал.
- **AC-000-15** `[manual]` — *Given* push в GitHub, *When* отработал workflow, *Then* `npm ci` и `npm run check` зелёные. Проверка: ссылка на прогон в журнале.
- **AC-000-16** — *Given* каждое ядро (`api-core`, `orchestrator-core`, `agent-core`), *When* тест вызывает `create<Имя>Core({ version: 'test' })` без Fastify и Docker, *Then* `info()` возвращает объект, проходящий `ServiceInfo.parse`, с `version: 'test'`.
- **AC-000-17** — *Given* ядро-фикстура с `import Fastify from 'fastify'` или `import { readFile } from 'node:fs'`, *When* `arch:check`, *Then* выход 1, в выводе файл, строка и спецификатор.
- **AC-000-18** — *Given* ядро-фикстура с `fastify` в `dependencies`, *When* `arch:check`, *Then* выход 1 и в выводе имя зависимости.
- **AC-000-19** — *Given* ядро-фикстура только с относительными импортами, `zod` и `@swag/contracts`, *When* `arch:check`, *Then* выход 0.
- **AC-000-20** `[manual]` — *Given* в `src` любого ядра добавлено обращение к `process.env`, *When* `npm run typecheck`, *Then* ошибка типов в этом ядре. Проверка: вывод в журнал, правку откатить.

Тесты `spec:check` и `arch:check` работают на временных фикстурах, а не на реальных файлах репозитория.

## 6. Нефункциональные требования

| ID | Требование | Как измеряется |
|---|---|---|
| NFR-000-1 | `npm test` на каркасе — быстрее 30 с локально | время команды |
| NFR-000-2 | Workflow GitHub Actions — быстрее 5 мин | время прогона |
| NFR-000-3 | Замер холодного старта заглушки `agent` на Node 24: `docker run --rm` готового образа, 10 прогонов, медиана и p95, отдельно время до старта процесса и до вывода `agent ok`. Порога нет: это точка отсчёта, с которой сравним тёплый пул (спека 004) и, если старт окажется узким местом, другой рантайм. | таблица в журнале |

## 7. Безопасность: что не должно сломаться

- Секреты не попадают в git → AC-000-10.
- Порты контейнеров публикуются только на `127.0.0.1` → ревью `compose.yaml`.
- Учётные данные в `.env.example` — только локальные, с комментарием «только для локальной разработки».
- Docker socket ни в один контейнер не монтируется (появится в спеке 004 с отдельными мерами защиты).
- Пакеты нельзя случайно опубликовать в npm → AC-000-9 (`private: true`).
- Ядро не может само обратиться к сети, файлам или env — только через порты, которые дала оболочка → AC-000-17…20.

## 8. Задачи для агента

- [x] **T-1.** Корень: `package.json` (workspaces, `engines`, `private`, `license`, скрипты), `.npmrc`, `.nvmrc`, `tsconfig.base.json`, `.gitignore`, `.editorconfig`. Закрывает: REQ-000-1…3, REQ-000-13. Готово, когда `npm install` проходит.
- [x] **T-2.** Линтер, форматтер, Vitest; workspaces из 4.1 с заглушкой и smoke-тестом; `npm run check`; тест полей лицензии. Закрывает: REQ-000-7, REQ-000-8, REQ-000-14, AC-000-1, AC-000-9, AC-000-14.
- [x] **T-3.** `packages/contracts` (`ServiceInfo`) и ядра `api-core`, `orchestrator-core`, `agent-core` по 4.2: фабрика, `info()`, `tsconfig` без DOM и `types`, тесты. Закрывает: REQ-000-15, AC-000-16, AC-000-20.
- [x] **T-4.** `scripts/arch-check.ts` и тесты на фикстурах; включить в `npm run check`. Закрывает: REQ-000-17, AC-000-17…19.
- [x] **T-5.** `packages/config`: `BaseConfig`, `loadConfig`, тесты. Закрывает: REQ-000-9, AC-000-2, AC-000-3.
- [x] **T-6.** Оболочки `apps/api` и `apps/orchestrator` на Fastify: конфиг → фабрика ядра → контроллер `/health`; тесты через `inject`. Оболочка `apps/agent` на Node. Закрывает: REQ-000-16, AC-000-4, AC-000-5.
- [ ] **T-7.** Dockerfile `api`, `orchestrator`, `agent` (Node), `compose.yaml`, `.env.example`, `npm run up/dev/down`, `infra:check`. Закрывает: REQ-000-4…6, REQ-000-10, AC-000-10…13.
- [x] **T-8.** Замер холодного старта `agent`. Закрывает: NFR-000-3.
- [x] **T-9.** `scripts/spec-check.ts` и тесты на фикстурах. Закрывает: REQ-000-11, AC-000-6…8.
- [x] **T-10.** GitHub Actions. Закрывает: REQ-000-12, AC-000-15.
- [x] **T-11.** Корневой README: требования (Docker, Node 24), запуск с нуля, список команд, правило «ядро и оболочка» со ссылкой на 4.2, ссылка на `LICENSE`.

## 9. Открытые вопросы

- [x] **Q-1.** Линтер и форматтер: ESLint (flat config) + Prettier или Biome? *(Claude, 2026-10-21)*
  **Ответ:** ESLint (flat config) + Prettier. *(человек, 2026-10-21)*
- [x] **Q-2.** Тестовый раннер? *(Claude, 2026-10-21)*
  **Ответ:** Vitest. *(человек, 2026-10-21)*
- [x] **Q-3.** Инструмент миграций и работы с Postgres? *(Claude, 2026-10-21)*
  **Ответ:** решается в спеке 001 вместе с моделью данных; в 000 БД не используется. *(человек, 2026-10-21)*
- [x] **Q-4.** Рантаймы: Node 24 для сервисов и Bun для агента, или один рантайм? *(Claude, 2026-10-21)*
  **Ответ:** Node 24 везде, включая агента; Bun и Deno не используем. Bun вернёмся рассматривать, только если замер старта агента (NFR-000-3 и тёплый пул в 004) покажет, что рантайм — узкое место. *(человек, 2026-10-21)*
- [x] **Q-5.** Консольная оболочка (`apps/cli`) в 000? *(Claude, 2026-10-21)*
  **Ответ:** нет. Основной вход для пользователя — UI; консоль — просто ещё один адаптер к платформе, добавим, если понадобится. *(человек, 2026-10-21)*
- [ ] **Q-6.** Из какого образа поднимать MinIO (REQ-000-5)? Официальные образы недоступны: `docker pull minio/minio` → «repository does not exist», `quay.io/minio/minio` → «unauthorized» (проверено 2026-10-21; MinIO прекратил публикацию community-образов, minio/minio#21647). Варианты: **(а)** `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` + `pgsty/mc:RELEASE.2026-10-18T00-00-00Z` — community-форк Pigsty, 2,3 млн загрузок, API MinIO без изменений, правка спеки минимальна (рекомендую); **(б)** `alpine/minio:RELEASE.2025-10-15T17-29-55Z` — сборка из исходников, но последняя от 2025-10 и нет образа `mc`, бакет пришлось бы создавать другим клиентом; **(в)** собирать MinIO из исходников своим Dockerfile — полный контроль, но сборка Go в `npm run up` и поддержка на нас; **(г)** заменить MinIO на другое S3-совместимое хранилище (SeaweedFS, Garage, RustFS) — меняет роадмап и спеку 005; **(д)** Docker Hardened Image `dhi.io/minio` — отдаёт «unauthorized» без `docker login dhi.io`, то есть логин в Docker нужен каждому, кто запускает `npm run up` с чистого клона; **(е)** убрать MinIO из 000 и перенести выбор в спеку 005 (там он впервые нужен): из REQ-000-5, 4.3 (`S3_*` в `BaseConfig`), 4.7 и AC-000-11 уходит MinIO. От ответа зависят только `minio`/`minio-init` в `compose.yaml` и AC-000-11. *(Claude, 2026-10-21)*

## 10. Журнал реализации

| Дата | Ветка / коммит | Что сделано | Отклонения от спеки |
|---|---|---|---|
| 2026-10-21 | `spec/000-foundation` / `0707479` | T-1…T-6, T-8…T-11 готовы, `npm run check` зелёный. T-7 сделана без `minio` и `minio-init` — спека в `blocked` по Q-6. | См. строки ниже. |
| 2026-10-21 | — | **Версии.** Node 24.20.0 (`.nvmrc`, образ `node:24.20.0-alpine3.23`), npm 11.19, TypeScript 6.0.3, ESLint 9.39.5 + typescript-eslint 8.72, Prettier 3.9.10, Vitest 5.0.5, zod 4.6.7, Fastify 5.12.7; образы `postgres:17.11-alpine3.23`, `nats:2.15.1-alpine3.22`. | TypeScript 6, а не 7: в TypeScript 7.0 (порт на Go) нет compiler API, а он нужен `arch:check` (4.5); typescript-eslint поддерживает TS < 6.1. |
| 2026-10-21 | — | **Исполнение TypeScript (REQ-000-6).** Код в контейнерах и скрипты запускаются из исходников нативным type stripping Node 24 (`node apps/api/src/main.ts`), пакеты экспортируют `./src/index.ts`. `build` = `tsc -b` по project references (результат в `dist`, нужен для проверки сборки). `npm run dev` = `docker compose watch` с `action: sync+restart`: изменённые файлы копируются в контейнер, контейнер перезапускается, образ не пересобирается. | `node --watch` внутри контейнера не годится: sync подменяет файл, и Node перезапускался только на первую правку (проверено с `--watch` и с `--watch-path`). |
| 2026-10-21 | — | **Раскладка тестов.** Тесты пакетов — в `<пакет>/test/`, не в `src`: `arch:check` проверяет все импорты в `src` ядра, а тесты импортируют `vitest`; типы тестов (с `@types/node`) проверяет отдельный `tsconfig.dev.json`, чтобы `process` не стал виден в ядрах. `typecheck` = `tsc -b && tsc -p tsconfig.dev.json`, поэтому тоже пишет `dist` (project references не работают с `noEmit`). | — |
| 2026-10-21 | — | **Решения на выбор агента.** `infra:check` берёт адреса из `.env` и подставляет `127.0.0.1` вместо имени сервиса: порты опубликованы с теми же номерами (комментарий в `.env.example`). Схемы `ApiConfig` и `OrchestratorConfig` (`BaseConfig` + порт) лежат в `@swag/config`, чтобы оболочкам не нужен был zod. Оболочки слушают `0.0.0.0` внутри контейнера, наружу порт опубликован только на `127.0.0.1`. Образ `agent` собирается сервисом compose с `profiles: [agent]` и в `npm run up` не стартует. `/health` пишет в лог только предупреждения: healthcheck опрашивает его каждые 2 с. | — |
| 2026-10-21 | — | **Трактовки 4.5 и 4.6.** `arch:check` разрешает подпути пакетов белого списка (`zod/v4`); помимо `import`, `export … from` и `import()` проверяет `import x = require()` и `import('x').T` в типах; `import()` с вычисляемым спецификатором считает нарушением (`<не литерал>`). `spec:check` кроме `node_modules` и `dist` пропускает скрытые каталоги (`.git`, `.claude`): в основном чекауте в `.claude/worktrees` лежат чужие worktree с тестами, они давали бы ложные совпадения. AC-000-1 закрыт тестом `scripts/build.test.ts` (`npm run build` из рабочей копии); «чистый клон + `npm ci`» проверяет CI. | Расширения, а не изменения поведения из 4.5–4.6. |
| 2026-10-21 | — | **AC-000-11 `[manual]`, частично.** `npm run up` без MinIO: postgres, nats, api, orchestrator healthy за 24 с (лимит 90 с). `infra:check`: `ok postgres`, `fail minio: connect ECONNREFUSED 127.0.0.1:9000`, `ok nats`, `ok api`, `ok orchestrator`, выход 1. `GET /health` → `{"status":"ok","service":"api","version":"0.0.0"}` и `{"status":"ok","service":"orchestrator","version":"0.0.0"}`. Порты: `127.0.0.1:3000`, `127.0.0.1:3001`, `127.0.0.1:4222`, `127.0.0.1:5432`. Полная проверка — после Q-6. | Не пройден: нет MinIO. |
| 2026-10-21 | — | **AC-000-12 `[manual]`.** `npm run dev`, затем скрипт меняет в `packages/api-core/src/index.ts` `version: deps.version` на `` `${deps.version}-reloaded` `` и опрашивает `GET /health` раз в 100 мс; потом откатывает правку. Три цикла: новое значение через 1391, 1402, 1356 мс, откат через 1402, 1470, 1480 мс (лимит 5 с). Образ не пересобирался, `Config.Cmd` контейнера — `node apps/api/src/main.ts`. | — |
| 2026-10-21 | — | **AC-000-13 `[manual]`.** `docker build -f apps/agent/Dockerfile -t swag-agent:dev .` и `docker run --rm swag-agent:dev` выводят `node v24.20.0`, `agent 0.0.0`, `agent ok`, выход 0. | — |
| 2026-10-21 | — | **AC-000-14 `[manual]`.** В `apps/api/src/app.ts` добавлена отформатированная функция с неиспользуемой переменной. `npm run check`: выполнены `format:check`, затем `lint`; ошибка `'unused' is assigned a value but never used … @typescript-eslint/no-unused-vars`, `typecheck` и следующие шаги не запускались, выход 1. После отката: все семь шагов, выход 0. | — |
| 2026-10-21 | — | **AC-000-15 `[manual]`.** Не проверен: нужен push в GitHub (`origin` = github.com/iwnow/swag), push — только по команде человека. Workflow: `.github/workflows/ci.yml`, `ubuntu-24.04`, `setup-node` с `.nvmrc`, `npm ci`, `npm run check`. | — |
| 2026-10-21 | — | **AC-000-20 `[manual]`.** В `packages/api-core/src/index.ts` добавлено `export const leak = process.env.SECRET;`. `npm run typecheck` → `packages/api-core/src/index.ts(16,21): error TS2591: Cannot find name 'process'`, выход ≠ 0. Правка откачена, `typecheck` снова зелёный. | — |
| 2026-10-21 | — | **NFR-000-1.** `npm test`: 12 файлов, 23 теста, 1,9 с (лимит 30 с). **NFR-000-2** не измерен: нужен прогон в GitHub Actions. | — |
| 2026-10-21 | — | **NFR-000-3.** Образ `swag-agent:dev`, Windows 10, Docker Desktop 29.4.1, 10 запусков `docker run --rm` подряд. «Старт процесса» — метка `Date.now()` первой строкой `node -e` в контейнере (Node уже загрузился, до импорта заглушки) минус момент вызова на хосте; «agent ok» — когда строка пришла на stdout хоста; «всего» — до завершения `docker run`. Часы хоста и VM Docker Desktop могут расходиться на единицы мс. | Через `node -e` с импортом `main.ts`, а не через entrypoint образа: в BusyBox `date` нет миллисекунд. |
|  |  | старт процесса: медиана 257 мс, p95 261 мс (249…261) |  |
|  |  | вывод `agent ok`: медиана 300,5 мс, p95 310 мс (289…310) |  |
|  |  | завершение `docker run`: медиана 428,5 мс, p95 462 мс (416…462) |  |
