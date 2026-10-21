---
id: "000"
title: Каркас проекта
status: draft
roadmap_stage: 0
depends_on: []
superseded_by: null
updated: 2026-10-21
---

# 000. Каркас проекта

> **Коротко.** Пустой, но рабочий репозиторий, в котором агент может разрабатывать по спекам.
> - **Монорепо** pnpm: `apps/api`, `apps/orchestrator`, `apps/ui`, `packages/config`, `packages/contracts`, `packages/agent-runtime` — пока заглушки.
> - **Инфраструктура одной командой:** `pnpm infra:up` поднимает Postgres, MinIO и NATS в Docker, `pnpm infra:check` проверяет, что всё живо.
> - **Одна команда проверки:** `pnpm check` = формат → линтер → типы → сборка → тесты → `spec:check`. Её запускают и агент перед сдачей, и CI на каждый push.
> - **`spec:check`** не даёт сдать спеку, если у какого-то критерия приёмки нет теста.
> - **Конфиг** из env с проверкой через Zod, секреты — только в `.env`, который не попадает в git.
> - **Что нужно от вас, чтобы запустить:** ответить на 4 вопроса в разделе 9 (GitHub или GitLab, линтер, тест-раннер, миграции) и поставить `status: ready`.

## 1. Контекст и цель

Этап 0 [роадмапа](../../AI_PLATFORM_ROADMAP.md#этапы): основа, на которой агент будет реализовывать остальные спеки. Сейчас в репозитории только документация. Нужно получить монорепо, где одной командой поднимается локальная инфраструктура (Postgres, MinIO, NATS), а сборка, линтер, типы, тесты и проверка трассировки спек запускаются одной командой каждая и проходят в CI.

## 2. Объём

**Входит:**
- монорепо на pnpm workspaces со структурой пакетов из раздела 4;
- общая конфигурация TypeScript, линтера, форматтера, тестов;
- `infra/compose.yaml`: Postgres, MinIO, NATS с JetStream;
- скрипт проверки инфраструктуры `pnpm infra:check`;
- скрипт трассировки спек `pnpm spec:check`;
- CI-пайплайн;
- `.env.example` и правила работы с секретами.

**Не входит:**
- схемы БД, событий и ledger (спека 001);
- LiteLLM (спека 003);
- бизнес-логика любых сервисов: в пакетах только заглушки с smoke-тестом;
- Angular-приложение (спека 010), в 000 только пустое место `apps/ui/` с README;
- Dockerfile для сервисов и образ агента.

## 3. Требования

| ID | Требование | Приоритет |
|---|---|---|
| REQ-000-1 | Репозиторий MUST быть монорепо pnpm workspaces со структурой из раздела 4. | MUST |
| REQ-000-2 | TypeScript MUST работать в режиме `strict`, ESM, общий `tsconfig.base.json`. | MUST |
| REQ-000-3 | Node.js и pnpm MUST быть зафиксированы: `engines` и `packageManager` в корневом `package.json`, `.nvmrc`. Node — актуальная LTS-линия 24.x. | MUST |
| REQ-000-4 | Корневые команды MUST работать из чистого клона: `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check`, `pnpm spec:check`, `pnpm infra:up`, `pnpm infra:down`, `pnpm infra:check`. | MUST |
| REQ-000-11 | `pnpm check` MUST запускать по порядку `format:check`, `lint`, `typecheck`, `build`, `test`, `spec:check`, останавливаться на первой ошибке и завершаться с её кодом. Это единая команда проверки для агента и CI. | MUST |
| REQ-000-5 | `infra/compose.yaml` MUST поднимать Postgres, MinIO и NATS (JetStream включён) с healthcheck. Версии образов зафиксированы точным тегом, `latest` запрещён. | MUST |
| REQ-000-6 | Конфигурация сервисов MUST читаться из env и валидироваться Zod-схемой в `packages/config`. Ошибка валидации — понятное сообщение с именем переменной и выход с кодом ≠ 0. | MUST |
| REQ-000-7 | В репозитории MUST быть `.env.example` со всеми переменными. `.env` MUST быть в `.gitignore`. | MUST |
| REQ-000-8 | `pnpm spec:check` MUST реализовывать проверку из раздела 4.3. | MUST |
| REQ-000-9 | CI MUST на каждый push и merge request выполнять `pnpm install --frozen-lockfile` и `pnpm check`. | MUST |
| REQ-000-10 | В каждом пакете SHOULD быть хотя бы один smoke-тест, чтобы `pnpm test` проверял, что тестовая инфраструктура пакета работает. | SHOULD |

## 4. Контракты

### 4.1. Структура репозитория

```
apps/
  api/              # Fastify: API + Coordinator (заглушка)
  orchestrator/     # Orchestrator (заглушка)
  ui/               # Angular — только README, приложение в спеке 010
packages/
  config/           # загрузка и Zod-валидация env
  contracts/        # общие Zod-схемы и типы (наполняется в 001+)
  agent-runtime/    # агентный цикл внутри песочницы (заглушка)
infra/
  compose.yaml
scripts/
  spec-check.ts
  infra-check.ts
skills/             # содержимое реестра скиллов (пусто, .gitkeep)
evals/              # eval-набор (пусто, .gitkeep; наполняется в 002)
docs/
```

Имена пакетов: `@swarm/<имя>`.

### 4.2. Переменные окружения

| Переменная | Пример | Назначение |
|---|---|---|
| `DATABASE_URL` | `postgres://swarm:swarm@localhost:5432/swarm` | Postgres |
| `S3_ENDPOINT` | `http://localhost:9000` | MinIO |
| `S3_ACCESS_KEY` | `swarm` | MinIO |
| `S3_SECRET_KEY` | `swarm-secret` | MinIO, только локально |
| `S3_BUCKET` | `swarm` | бакет по умолчанию, создаётся при `infra:up` |
| `NATS_URL` | `nats://localhost:4222` | NATS |

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

### 4.3. `pnpm spec:check`

1. Читает все `docs/spec/[0-9][0-9][0-9]-*.md`, из YAML frontmatter берёт `id` и `status`.
2. Для спек со статусом `in-progress`, `review` или `done` собирает id критериев: строки вида `- **AC-NNN-n**`. Критерии с пометкой `` `[manual]` `` сразу после id пропускает.
3. Ищет каждый id как подстроку в файлах `**/*.test.ts` и `**/*.spec.ts` (без `node_modules`, `dist`).
4. Выход 0 — все найдены. Выход 1 — печатает список `spec NNN: AC-NNN-n — нет теста`.
5. Для спек с другими статусами ничего не проверяет.

### 4.4. `pnpm infra:check`

Подключается к Postgres (`select 1`), MinIO (наличие бакета `S3_BUCKET`), NATS (подключение + JetStream `accountInfo`). Печатает статус каждого. Выход 0 — всё доступно, иначе 1.

## 5. Критерии приёмки

- **AC-000-1** — *Given* чистый клон и установленные Node и pnpm нужных версий, *When* `pnpm install && pnpm build`, *Then* обе команды завершаются с кодом 0.
- **AC-000-2** — *Given* валидный env, *When* `loadConfig(BaseConfig)`, *Then* возвращается типизированный объект.
- **AC-000-3** — *Given* env без `DATABASE_URL`, *When* `loadConfig(BaseConfig)`, *Then* ошибка, в тексте которой есть `DATABASE_URL`.
- **AC-000-4** — *Given* спека в статусе `review` с критерием AC без теста, *When* `spec:check`, *Then* выход 1 и в выводе есть id этого критерия.
- **AC-000-5** — *Given* спека в статусе `review`, у всех критериев есть тесты, кроме помеченных `[manual]`, *When* `spec:check`, *Then* выход 0.
- **AC-000-6** — *Given* спека в статусе `draft` без тестов, *When* `spec:check`, *Then* она не влияет на результат.
- **AC-000-7** `[manual]` — *Given* Docker запущен, *When* `pnpm infra:up` и затем `pnpm infra:check`, *Then* все три сервиса healthy не позже чем через 60 с, `infra:check` завершается с кодом 0. Проверка: выполнить команды, приложить вывод в журнал реализации.
- **AC-000-8** `[manual]` — *Given* push в ветку, *When* CI отработал, *Then* все шаги из REQ-000-9 зелёные. Проверка: ссылка на прогон CI в журнале.
- **AC-000-10** `[manual]` — *Given* в коде есть ошибка линтера, *When* `pnpm check`, *Then* команда завершается с кодом ≠ 0 на шаге `lint`, следующие шаги не запускаются; после исправления `pnpm check` завершается с кодом 0. Проверка: выполнить оба прогона, приложить вывод в журнал.
- **AC-000-9** — *Given* репозиторий, *When* поиск по истории и рабочему дереву, *Then* нет файлов `.env` и значений секретов, кроме локальных значений-примеров в `.env.example`. Автотест: проверка, что `.env` в `.gitignore` и не отслеживается git.

Тесты `spec:check` (AC-000-4…6) работают на временных фикстурах спек, а не на реальных файлах `docs/spec`.

## 6. Нефункциональные требования

| ID | Требование | Как измеряется |
|---|---|---|
| NFR-000-1 | `pnpm test` на каркасе выполняется быстрее 30 с локально | время выполнения команды |
| NFR-000-2 | CI-пайплайн каркаса — быстрее 5 мин | время прогона CI |

## 7. Безопасность: что не должно сломаться

- Секреты не попадают в git → AC-000-9.
- Порты инфраструктуры в compose публикуются только на `127.0.0.1`, а не на `0.0.0.0`. Проверяется ревью `compose.yaml`.
- Учётные данные в compose и `.env.example` — только для локальной разработки и явно так подписаны комментарием.

## 8. Задачи для агента

- [ ] **T-1.** Корень монорепо: `package.json` (`packageManager`, `engines`, скрипты), `pnpm-workspace.yaml`, `.nvmrc`, `tsconfig.base.json`, `.gitignore`, `.editorconfig`. Закрывает: REQ-000-1…3. Готово, когда `pnpm install` проходит.
- [ ] **T-2.** Линтер, форматтер, тестовый раннер на корневом уровне; пакеты и приложения из 4.1 с заглушкой и smoke-тестом; команда `pnpm check`. Закрывает: REQ-000-4, REQ-000-10, REQ-000-11, AC-000-1, AC-000-10.
- [ ] **T-3.** `packages/config` с `BaseConfig` и `loadConfig`, тесты. Закрывает: REQ-000-6, AC-000-2, AC-000-3.
- [ ] **T-4.** `infra/compose.yaml`, `.env.example`, скрипты `infra:up/down/check`, создание бакета. Закрывает: REQ-000-5, REQ-000-7, AC-000-7, AC-000-9.
- [ ] **T-5.** `scripts/spec-check.ts` и тесты на фикстурах. Закрывает: REQ-000-8, AC-000-4…6.
- [ ] **T-6.** CI-пайплайн. Закрывает: REQ-000-9, AC-000-8.
- [ ] **T-7.** Корневой README: как поднять проект с нуля за 5 команд.

## 9. Открытые вопросы

- [ ] **Q-1.** Где хостится репозиторий: GitHub или GitLab? От этого зависит формат CI (GitHub Actions / `.gitlab-ci.yml`). *(Claude, 2026-10-21)*
- [ ] **Q-2.** Линтер и форматтер: ESLint (flat config) + Prettier или Biome? Предложение — ESLint + Prettier: шире экосистема правил для TypeScript и Angular. *(Claude, 2026-10-21)*
- [ ] **Q-3.** Тестовый раннер: Vitest? Предложение — да, Vitest: нативный ESM и TypeScript. *(Claude, 2026-10-21)*
- [ ] **Q-4.** Инструмент миграций БД (нужен с 001): node-pg-migrate, Drizzle или Kysely? Можно решить в 001, но если выбрать ORM (Drizzle) — это влияет на `packages/contracts`. *(Claude, 2026-10-21)*

## 10. Журнал реализации

| Дата | Ветка / коммит | Что сделано | Отклонения от спеки |
|---|---|---|---|
