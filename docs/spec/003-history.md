---
id: "003"
title: История роёв
status: in-progress
roadmap_stage: 3
depends_on: ["001", "016", "022"]
superseded_by: null
updated: 2026-10-29
---

# 003. История роёв

> **Коротко.** Рои и их события переезжают из памяти `api` в Postgres: после перезапуска `api` и обновления страницы прошлые рои и их ленты видны.
> - **Что появится.**
>   - Адаптер `packages/adapter-postgres`: хранилище роёв `SwarmStore` на Postgres — таблицы `swarms` (проекция роя) и `swarm_events` (события), событие и проекция пишутся одной транзакцией.
>   - Миграции схемы: SQL-файлы в адаптере, `api` применяет их при старте, `npm run db:migrate` — вручную.
>   - Порт `SwarmStore` становится асинхронным; `api-core` пишет события роя строго по очереди, `seq` без пропусков и повторов.
>   - Рои, которые были `starting`/`running` в момент перезапуска `api`, при старте закрываются `swarm.failed` с причиной `api_restarted` и не держат лимит `MAX_ACTIVE_SWARMS`.
>   - Срок хранения телеметрии (из N-15): одна переменная `TELEMETRY_RETENTION` для Loki, Tempo и Prometheus в `lgtm`, по умолчанию `24h` (dev), для прода — `168h`.
> - **Ключевые решения (на подтверждение).** Порт асинхронный (Q-1); миграции — `node-pg-migrate` на SQL, запросы — `pg` без ORM (Q-2); список роёв без пагинации (Q-3); прерванные рои — `api_restarted` (Q-4); формат и минимум `TELEMETRY_RETENTION` (Q-5).
> - **Меняет спеку 001:** REQ-001-3 («замена на Postgres без правки `api-core`») — порт меняет сигнатуры на `Promise`, `api-core` правится (Q-1).
> - **Из бэклога:** N-15 → T-10. Вопросов `D-n` для 003 нет.
> - **Что нужно от человека:** ничего — Q-1…Q-5 решены по рекомендациям (2026-10-29).

## 1. Контекст и цель

Роадмап, этап 3 «История»: рои и события в Postgres, выбор инструмента миграций; после перезапуска `api` и обновления страницы прошлые рои видны ([роадмап](../../AI_PLATFORM_ROADMAP.md), «Этапы» и «6. Состояние агента и хранение данных»: «события — Postgres»).

Сейчас `api` хранит рои и события в памяти (`packages/adapter-memory`, спека 001, 4.10): перезапуск `api` стирает историю, а рой, шедший в момент перезапуска, навсегда остаётся `running` в UI. Postgres уже поднят в compose, `DATABASE_URL` уже в конфиге `api`, но `api` к базе не ходит. Логи, трейсы и метрики в `lgtm-data` копятся без срока.

Цель: события и проекции роёв живут в Postgres и переживают перезапуск `api`; схема управляется миграциями; прерванные рои закрываются явно; у телеметрии есть настраиваемый срок хранения.

## 2. Объём

**Входит:**
- асинхронный порт `SwarmStore`, очередь записи событий роя и подписка без потерь в `api-core`;
- `packages/adapter-postgres`: миграции, `SwarmStore` на Postgres;
- сборка `apps/api` с Postgres: миграции при старте, закрытие прерванных роёв;
- проекция роя: итоговый статус роя окончательный (Q-4);
- причина `swarm.failed` `api_restarted`;
- Postgres в CI для тестов адаптера;
- срок хранения телеметрии в `lgtm` (из N-15).

**Не входит:**
- ledger, бюджеты, ключи агентов — 004 (D-5, D-38);
- история с моделью, журнал инструментов, возобновление агента — 008;
- организации и доступ к роям по организации — 024 (S-1, шаг 8);
- сроки хранения самих роёв и событий в Postgres, аудит — этап 14 роадмапа;
- пагинация списка роёв и событий (Q-3);
- доставка событий, пропущенных `api`, пока он лежал (JetStream, durable-подписки) — спека надёжности шины, N-11;
- несколько экземпляров `api` (очередь записи — в памяти одного процесса);
- TimescaleDB и аналитика по событиям.

## 3. Требования

| ID | Требование | Приоритет |
|---|---|---|
| REQ-003-1 | `api` MUST хранить события и проекции роёв в Postgres: после перезапуска `api` `GET /swarms`, `GET /swarms/:id`, `GET /swarms/:id/events` и поток WebSocket отдают то же, что до перезапуска. | MUST |
| REQ-003-2 | Событие и проекция роя MUST записываться одной транзакцией: недопустимое событие (`applyEvent` бросает) не меняет ни события, ни проекцию; повтор `seq` игнорируется, как в адаптере в памяти. | MUST |
| REQ-003-3 | `api-core` MUST назначать `seq` событиям одного роя строго по очереди: при параллельных вызовах `ingestEvent`, `ingestMessage`, `createSwarm`, `stopSwarm` номера идут 1, 2, 3… без пропусков и повторов. | MUST |
| REQ-003-4 | Подписка на поток роя MUST отдавать каждое событие с `seq > after` ровно один раз и по возрастанию `seq`, включая события, записанные, пока читалась история. | MUST |
| REQ-003-5 | Схема MUST создаваться и обновляться миграциями из `packages/adapter-postgres/migrations`; `api` MUST применять их при старте до приёма запросов; повторное применение — без изменений. | MUST |
| REQ-003-6 | При старте `api` рои в `starting` или `running` MUST закрываться: `orchestrator.stop` (ошибка игнорируется) и событие `swarm.failed` с `reason: api_restarted`. Такие рои MUST NOT учитываться в `MAX_ACTIVE_SWARMS`. | MUST |
| REQ-003-7 | Итоговый статус роя (`completed`, `stopped`, `failed`) MUST быть окончательным: события после него сохраняются и двигают `lastSeq`, но статус роя и `result`/`failure` не меняют. | MUST |
| REQ-003-8 | Адаптер MUST использовать только параметризованные запросы; текст событий MUST NOT попадать в логи адаптера. | MUST |
| REQ-003-9 | Срок хранения Loki, Tempo и Prometheus в `lgtm` MUST задаваться одной переменной `TELEMETRY_RETENTION` из `.env`; по умолчанию в `.env.example` — `24h`. | MUST |
| REQ-003-10 | Адаптер в памяти MUST реализовывать тот же асинхронный порт и остаться для тестов ядра. | MUST |

## 4. Контракты

### 4.1. `@swag/contracts`

`swarm.failed.data.reason` дополняется `'api_restarted'` (Q-4):

```ts
reason: z.enum(['agent_start_timeout', 'swarm_timeout', 'orchestrator_unavailable', 'sandbox_error', 'agent_failed', 'api_restarted']),
```

### 4.2. Порт `SwarmStore` — `packages/api-core/src/index.ts`

```ts
export interface SwarmStore {
  appendEvent(event: PlatformEvent): Promise<void>; // seq назначен ядром; событие и проекция — атомарно; отказ на недопустимое событие — reject
  events(swarmId: string, afterSeq: number): Promise<PlatformEvent[]>; // по возрастанию seq
  view(swarmId: string): Promise<SwarmView | null>;
  views(): Promise<SwarmView[]>; // порядок не задан, сортирует ядро
}
```

`ApiCore` меняется так (остальное — как в 001 и 022):

```ts
export interface ApiCore {
  info(): ServiceInfo;
  createSwarm(body: unknown): Promise<Result<SwarmView>>;
  listSwarms(): Promise<SwarmSummary[]>;
  getSwarm(id: string): Promise<Result<SwarmView>>;
  getEvents(id: string, after: number): Promise<Result<PlatformEvent[]>>;
  stopSwarm(id: string): Promise<Result<void>>;
  ingestEvent(raw: unknown): Promise<void>;
  ingestMessage(raw: unknown): Promise<void>;
  subscribe(swarmId: string, after: number, listener: (e: PlatformEvent) => void): Promise<Result<() => void>>;
  closeInterrupted(): Promise<number>; // REQ-003-6; число закрытых роёв
}
```

Ядро:
- **Очередь записи.** `commit` выполняется в цепочке `Promise` своего роя (`Map<swarmId, Promise<unknown>>`): `seq = (await store.view(swarmId))?.lastSeq ?? 0) + 1`, затем `await store.appendEvent(event)`, затем рассылка слушателям. Ошибка `appendEvent` — `warn` как сейчас, цепочка продолжается. Запись в разные рои идёт параллельно.
- **Подписка.** Слушатель регистрируется до чтения истории, события из `commit` копятся в его буфере; затем `store.events(swarmId, after)` отдаются слушателю, затем буфер — только события с `seq` больше последнего отданного; дальше — напрямую. Неизвестный рой — `not_found` до регистрации.
- **`closeInterrupted`.** Для каждого вида из `store.views()` со статусом `starting` или `running`: `await orchestrator.stop(id)` в `try/catch` (ошибка — `warn` `interrupted stop failed`), затем `commit` события `swarm.failed` `{ reason: 'api_restarted' }` с `source: 'api'`, `agentId: null`, `traceId: null`. Возвращает число закрытых роёв, лог `info` `interrupted swarms closed` с `count`.

### 4.3. Проекция — `packages/api-integration/src/swarm-view.ts`

`applyEvent`: если `view.status` — `completed`, `stopped` или `failed`, событие только двигает `lastSeq` (и счётчики агентов не меняет); проверки `seq` и `swarm.created` — как сейчас.

### 4.4. `packages/adapter-postgres`

```ts
import type pg from 'pg';
export function createPostgresSwarmStore(pool: pg.Pool): SwarmStore;
export function runMigrations(databaseUrl: string, options?: { schema?: string }): Promise<void>; // node-pg-migrate, каталог migrations/
```

Миграция `migrations/0001_swarms.sql` (формат `node-pg-migrate` для SQL-миграций, `-- Up Migration` / `-- Down Migration`):

```sql
-- Up Migration
create table swarms (
  id uuid primary key,
  status text not null,
  created_at timestamptz not null,
  last_seq integer not null,
  view jsonb not null
);
create index swarms_created_at_idx on swarms (created_at desc);
create table swarm_events (
  swarm_id uuid not null references swarms (id) on delete cascade,
  seq integer not null,
  event jsonb not null,
  primary key (swarm_id, seq)
);
-- Down Migration
drop table swarm_events;
drop table swarms;
```

`appendEvent(event)` — одна транзакция:
1. `select view from swarms where id = $1 for update`;
2. `next = applyEvent(current, event)`; исключение — `rollback` и reject; `next === current` (повтор `seq`) — `commit`, ничего не пишется;
3. для `swarm.created` — `insert into swarms`, иначе `update swarms set status, last_seq, view`;
4. `insert into swarm_events (swarm_id, seq, event)`.

`events` — `select event from swarm_events where swarm_id = $1 and seq > $2 order by seq`; `view` — `select view from swarms where id = $1`; `views` — `select view from swarms`. `swarmId`, не являющийся UUID, — `view` даёт `null`, `events` — `[]`, без обращения к базе. Логи адаптер не пишет.

Зависимости пакета: `pg` 8.23.1 (уже в корне), `node-pg-migrate` — последняя стабильная версия, опубликованная не позже чем за 2 недели до реализации (Q-2); версия — в README и журнале.

### 4.5. `apps/api`

Порядок старта: `runMigrations(config.DATABASE_URL)` → `new pg.Pool({ connectionString: config.DATABASE_URL })` → `createPostgresSwarmStore(pool)` → `createApiCore(...)` → `await core.closeInterrupted()` → подписки NATS → `listen`. Остановка: `app.close()`, затем `pool.end()`. Ошибка миграций — выход с кодом 1 и лог `error` `migrations failed`. Маршруты Fastify ждут `Promise` ядра; коды ответов — как в 001.

### 4.6. Env и скрипты

| Переменная | Где | Значение по умолчанию | Назначение |
|---|---|---|---|
| `DATABASE_URL` | `api` (уже есть) | `postgres://swag:swag-local@postgres:5432/swag` | база роёв |
| `POSTGRES_TEST_URL` | тесты `adapter-postgres` и `apps/api`, CI | не задана — тесты пропускаются | база для тестов; каждый тест-файл создаёт схему `test_<uuid>` и удаляет её в `afterAll` |
| `TELEMETRY_RETENTION` | `lgtm` в compose, `ObservabilityConfig` | `24h` в `.env.example`; прод — `168h` | срок хранения Loki, Tempo, Prometheus; формат `<целое>h`, не меньше `24h` (Q-5) |

Скрипт `npm run db:migrate` — `runMigrations(process.env.DATABASE_URL)` для базы на `127.0.0.1` (адрес из `.env` с хостом `127.0.0.1`, как `infra-check`).

### 4.7. Срок хранения телеметрии — `compose.yaml`, `infra/lgtm/`

- `infra/lgtm/loki-config.yaml` — копия `/otel-lgtm/loki-config.yaml` образа `grafana/otel-lgtm:0.37.0` плюс:
  ```yaml
  compactor:
    working_directory: /data/loki/compactor
    retention_enabled: true
    delete_request_store: filesystem
  limits_config:
    retention_period: ${TELEMETRY_RETENTION}
  ```
- `infra/lgtm/tempo-config.yaml` — копия `/otel-lgtm/tempo-config.yaml` плюс `compactor: { compaction: { block_retention: ${TELEMETRY_RETENTION} } }`.
- Сервис `lgtm`: тома `./infra/lgtm/loki-config.yaml:/otel-lgtm/loki-config.yaml:ro` и `./infra/lgtm/tempo-config.yaml:/otel-lgtm/tempo-config.yaml:ro`; env `TELEMETRY_RETENTION: ${TELEMETRY_RETENTION}`, `LOKI_EXTRA_ARGS: -config.expand-env=true`, `TEMPO_EXTRA_ARGS: -config.expand-env=true`, `PROMETHEUS_EXTRA_ARGS: --storage.tsdb.retention.time=${TELEMETRY_RETENTION}`.
- `ObservabilityConfig` в `packages/config`: `TELEMETRY_RETENTION: z.string().regex(/^[1-9][0-9]*h$/)` с проверкой `>= 24` часов.

### 4.8. CI

`.github/workflows/ci.yml`: сервис `postgres:17.11-alpine3.23` с `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` из явно фейковых значений и портом `127.0.0.1:5432`; `POSTGRES_TEST_URL` в env шага `npm run check`.

## 5. Критерии приёмки

- **AC-003-1** — *Given* `POSTGRES_TEST_URL` и пустая схема, *When* `runMigrations` дважды, *Then* таблицы `swarms`, `swarm_events` есть, вторая попытка ничего не меняет и не падает.
- **AC-003-2** — *Given* `createPostgresSwarmStore`, *When* `swarm.created`, `swarm.started`, `bus.message` с `seq` 1…3, *Then* `events(id, 0)` — три события по порядку, `events(id, 2)` — одно, `view(id)` совпадает с `projectSwarm` тех же событий, `views()` содержит рой; повтор события с `seq` 2 ничего не меняет; событие до `swarm.created` — reject, в таблицах ничего нет; `view('не-uuid')` — `null`.
- **AC-003-3** — *Given* рой, записанный через один `pg.Pool`, *When* пул закрыт и создан новый пул и новый `createPostgresSwarmStore` на той же схеме, *Then* `view`, `views`, `events` отдают те же данные (REQ-003-1).
- **AC-003-4** — *Given* хранилище, у которого `appendEvent` и `view` отвечают с задержкой, *When* 20 параллельных `ingestEvent` одного роя и 5 — другого, *Then* у каждого роя `seq` 1…N без пропусков и повторов (REQ-003-3).
- **AC-003-5** — *Given* рой с событиями 1…3 и хранилище с задержкой `events`, *When* `subscribe(id, 1)` и во время чтения истории записано событие 4, *Then* слушатель получает 2, 3, 4 ровно по разу и по порядку; неизвестный рой — `not_found` (REQ-003-4).
- **AC-003-6** — *Given* рои в `running`, `starting` и `completed`, *When* `closeInterrupted`, *Then* для двух первых вызван `orchestrator.stop` и записан `swarm.failed` `api_restarted`, рой `completed` не тронут, результат — 2; если `orchestrator.stop` бросает, событие всё равно записано; после этого `createSwarm` не упирается в `MAX_ACTIVE_SWARMS` из-за этих роёв (REQ-003-6).
- **AC-003-7** — *Given* рой `failed` с `api_restarted`, *When* приходят `swarm.stopped` и `agent.stopped`, *Then* события сохранены, `lastSeq` вырос, статус роя `failed`, `failure` прежний (REQ-003-7).
- **AC-003-8** — *Given* `POSTGRES_TEST_URL`, `apps/api` с фейковым оркестратором, *When* `POST /swarms`, приём событий, затем приложение закрыто и поднято заново на той же схеме, *Then* `GET /swarms` и `GET /swarms/:id/events` отдают тот же рой и события, рой, бывший `running`, стал `failed` `api_restarted` (REQ-003-1, REQ-003-5, REQ-003-6).
- **AC-003-9** — *Given* адаптер в памяти, *When* тесты `api-core` 001 и 022 на асинхронном порте, *Then* они зелёные без изменения ожиданий (REQ-003-10).
- **AC-003-10** — *Given* `compose.yaml`, `infra/lgtm/*.yaml`, `.env.example`, *When* тест репозитория, *Then* у `lgtm` смонтированы оба конфига, `TELEMETRY_RETENTION` передан, в Loki — `retention_enabled: true` и `retention_period: ${TELEMETRY_RETENTION}`, в Tempo — `block_retention: ${TELEMETRY_RETENTION}`, `PROMETHEUS_EXTRA_ARGS` содержит `--storage.tsdb.retention.time=${TELEMETRY_RETENTION}`, оба `*_EXTRA_ARGS` — `-config.expand-env=true`; `.env.example` — `TELEMETRY_RETENTION=24h`; `ObservabilityConfig` принимает `24h`, `168h` и отклоняет `12h`, `1d`, `24` (REQ-003-9).
- **AC-003-11** `[manual]` — *Given* `npm run up` на профиле `test`, *When* рой доведён до `completed`, второй рой запущен с задачей «по кругу» и, пока он `running`, выполнен `docker compose restart api`, затем страница обновлена, *Then* оба роя в списке, у первого лента и результат на месте, второй — `failed` `api_restarted`, контейнеров агентов нет. Проверка: вывод API и текст страницы — в журнал (REQ-003-1, REQ-003-6).
- **AC-003-12** `[manual]` — *Given* `npm run up` с `TELEMETRY_RETENTION=24h`, *When* запрос к Loki `/config`, Tempo `/status/config`, Prometheus `/api/v1/status/flags` изнутри контейнера `lgtm`, *Then* `retention_period: 24h`, `retention_enabled: true`, `block_retention: 24h`, `storage.tsdb.retention.time: 24h`. Проверка: вывод команд — в журнал (REQ-003-9).

## 6. Нефункциональные требования

| ID | Требование | Как измеряется |
|---|---|---|
| NFR-003-1 | `npm test` без `POSTGRES_TEST_URL` и Docker остаётся быстрее 60 с. | время команды |
| NFR-003-2 | Точка отсчёта без порога: p50 и p95 `appendEvent` на локальном Postgres на 1000 событий одного роя. | тест-замер, пропускается без `POSTGRES_BENCH=1`, таблица в журнале |

## 7. Безопасность: что не должно сломаться

- Учётные данные Postgres — только в `.env` и секретах CI; в тестах, фикстурах и CI — явно фейковые → ревью, AC-003-1.
- SQL-инъекции: только параметризованные запросы → REQ-003-8, ревью.
- Тексты задач, сообщений и ответов моделей не попадают в логи адаптера → REQ-003-8, ревью.
- Порт Postgres — только `127.0.0.1` (уже так в compose) → тест репозитория 001.
- Прерванный рой не держит лимит активных роёв и не висит `running` → AC-003-6, AC-003-11.
- Срок хранения телеметрии не отключает сбор: трейсы и логи по-прежнему видны в Grafana → AC-003-12.

## 8. Задачи для агента

Выполняются по порядку. После каждой задачи — коммит. T-2…T-4 ломают сборку по отдельности, поэтому идут через промежуточную фича-ветку `spec/003-store` (правило [implement-spec](../../.claude/skills/implement-spec/SKILL.md#ветка-на-этап)).

- [x] **T-1.** `packages/contracts/src/events.ts`: `api_restarted` в `swarm.failed.reason` (4.1); тест разбора в `packages/contracts/test`; глоссарий. Закрывает: часть REQ-003-6. Готово, когда: тесты `contracts` зелёные.
- [x] **T-2.** `packages/api-integration/src/swarm-view.ts`: окончательный итоговый статус (4.3), тест AC-003-7 в `packages/api-integration/test`. Закрывает: REQ-003-7, AC-003-7. Готово, когда: тесты пакета зелёные.
- [x] **T-3.** `packages/api-core/src/index.ts`: асинхронный `SwarmStore` и `ApiCore` по 4.2 — очередь записи, подписка с буфером; `packages/adapter-memory/src/index.ts` на асинхронный порт; `apps/api/src/app.ts` ждёт `Promise`; существующие тесты `api-core` и `apps/api` — `await` без изменения ожиданий; тесты AC-003-4, AC-003-5 в `packages/api-core/test`. Закрывает: REQ-003-3, REQ-003-4, REQ-003-10, AC-003-4, AC-003-5, AC-003-9. Готово, когда: `npm run check` зелёный.
- [x] **T-4.** `packages/api-core/src/index.ts`: `closeInterrupted` (4.2), тест AC-003-6. Закрывает: REQ-003-6 (ядро), AC-003-6. Готово, когда: тесты `api-core` зелёные.
- [ ] **T-5.** Новый пакет `packages/adapter-postgres`: `package.json`, `tsconfig.json`, README, `migrations/0001_swarms.sql`, `runMigrations` (4.4); тест AC-003-1 с `describe.skipIf(!process.env['POSTGRES_TEST_URL'])` и схемой `test_<uuid>`; `npm run db:migrate` в корне. Закрывает: REQ-003-5 (адаптер), AC-003-1. Готово, когда: тест зелёный на локальном Postgres из compose, пропускается без `POSTGRES_TEST_URL`, `arch:check` проходит.
- [ ] **T-6.** `packages/adapter-postgres/src/index.ts`: `createPostgresSwarmStore` (4.4), тесты AC-003-2, AC-003-3 и замер NFR-003-2. Закрывает: REQ-003-1 (адаптер), REQ-003-2, REQ-003-8, AC-003-2, AC-003-3. Готово, когда: тесты зелёные на локальном Postgres.
- [ ] **T-7.** `apps/api/src/main.ts`: сборка по 4.5; тест AC-003-8 в `apps/api/test` (`POSTGRES_TEST_URL`); README `apps/api`. Закрывает: REQ-003-1, REQ-003-5, REQ-003-6, AC-003-8. Готово, когда: тесты оболочки зелёные, `npm run up` поднимает `api` с миграциями.
- [ ] **T-8.** `.github/workflows/ci.yml`: сервис Postgres и `POSTGRES_TEST_URL` (4.8); `.env.example` — `POSTGRES_TEST_URL` для локального запуска. Готово, когда: CI зелёный, тесты AC-003-1, -2, -3, -8 в CI не пропущены.
- [ ] **T-9.** `packages/config/src/index.ts`: `TELEMETRY_RETENTION` в `ObservabilityConfig`, тест части AC-003-10 в `packages/config/test`; `.env.example` — `TELEMETRY_RETENTION=24h`. Закрывает: часть REQ-003-9, AC-003-10 (конфиг). Готово, когда: тесты `config` зелёные.
- [ ] **T-10.** (из N-15) `infra/lgtm/loki-config.yaml`, `infra/lgtm/tempo-config.yaml`, сервис `lgtm` в `compose.yaml` по 4.7; тест AC-003-10 в `scripts/repo.test.ts`; корневой README — переменная и значения для dev и прода. Закрывает: REQ-003-9, AC-003-10. Готово, когда: тест зелёный, `npm run up` поднимает `lgtm` healthy.
- [ ] **T-11.** Ручные проверки AC-003-11, AC-003-12, замер NFR-003-2 в журнал; README всех затронутых пакетов сверены. Закрывает: AC-003-11, AC-003-12, NFR-003-2. Готово, когда: результаты в журнале.

## 9. Открытые вопросы

- [x] **Q-1. Порт `SwarmStore` становится асинхронным.** *(Claude, 2026-10-29)*
  REQ-001-3 обещал Postgres «новым адаптером, без правки `api-core`», но порт синхронный, а драйвер Postgres — асинхронный. Варианты: **(а)** порт на `Promise`, `api-core` правится (очередь записи по рою, подписка с буфером, асинхронные методы `ApiCore`); **(б)** порт остаётся синхронным, адаптер Postgres держит всё в памяти и пишет в базу в фоне, при старте загружает базу целиком — `api-core` не меняется, но запись не транзакционна, ошибка записи теряет событие молча, память растёт с историей.
  **Рекомендация — «а»:** честная транзакция «событие + проекция», ошибка видна сразу; правка `api-core` механическая. REQ-001-3 получает пометку «изменено спекой 003».
  **Решение человека (2026-10-29): по рекомендации.**
- [x] **Q-2. Миграции и доступ к базе.** *(из 000 Q-3; Claude, 2026-10-29)*
  Инструмент: **(а)** `node-pg-migrate` — SQL-файлы, работает на уже установленном `pg`, блокировка от параллельного запуска, таблица `pgmigrations`; **(б)** Drizzle (`drizzle-orm` + `drizzle-kit`) — схема в TypeScript, миграции генерируются; **(в)** Kysely со своим `Migrator` — типизированный построитель запросов; **(г)** свой раннер SQL-файлов на ~40 строк.
  Запросы: `pg` с параметризованным SQL в адаптере, без ORM и построителя.
  Кто применяет: **(1)** `api` при старте до `listen`; **(2)** отдельный разовый сервис `migrate` в compose, `api` ждёт его `service_completed_successfully`.
  **Рекомендация — «а» + «1»:** в 003 две таблицы и четыре запроса — ORM и построитель не окупаются; `api` — единственный, кто пишет в базу; `npm run db:migrate` — для ручного запуска. При росте схемы (004, 012) выбор можно пересмотреть.
  **Решение человека (2026-10-29): по рекомендации.**
- [x] **Q-3. Список роёв без пагинации.** *(Claude, 2026-10-29)*
  После 003 история растёт без предела, а `GET /swarms` отдаёт все рои. Варианты: **(а)** оставить как есть до организаций (024) и сроков хранения (этап 14): локально и в демо роёв — сотни; **(б)** `GET /swarms?limit=&before=` с курсором по `createdAt` и «показать ещё» в UI.
  **Рекомендация — «а»:** YAGNI; пагинацию — вместе с доступом по организациям, когда изменится и сам запрос.
  **Решение человека (2026-10-29): по рекомендации.**
- [x] **Q-4. Рои, прерванные перезапуском `api`.** *(Claude, 2026-10-29)*
  Пока `api` лежит, события роёв из NATS теряются (ядро NATS без JetStream), и рой, бывший `running`, остаётся `running` навсегда и занимает `MAX_ACTIVE_SWARMS`. Варианты: **(а)** при старте `api` закрыть такие рои: `orchestrator.stop` и `swarm.failed` `api_restarted`; итоговый статус роя окончательный, чтобы поздний `swarm.stopped` от оркестратора не переписал его; **(б)** спросить у оркестратора список живых роёв и закрыть только неизвестные ему — рой продолжает работу, но часть его событий уже потеряна, лента неполна; **(в)** не трогать, «Стоп» вручную.
  **Рекомендация — «а»:** лента прерванного роя всё равно неполна, честнее закрыть его с понятной причиной; живая доставка пропущенных событий — спека надёжности шины.
  **Решение человека (2026-10-29): по рекомендации.**
- [x] **Q-5. Формат и минимум `TELEMETRY_RETENTION`.** *(из N-15; Claude, 2026-10-29)*
  Одна переменная на три хранилища. Варианты формата: **(а)** часы `24h`, `168h` — понимают Loki, Tempo и Prometheus без преобразования; **(б)** дни `1`, `7` с преобразованием в compose — compose не умеет арифметику, понадобятся три переменные. Минимум: Loki удаляет данные целыми суточными индексами (`period: 24h`), срок меньше `24h` не работает.
  **Рекомендация — «а», минимум `24h`:** dev — `24h`, прод — `168h`.
  **Решение человека (2026-10-29): по рекомендации.**

## 10. Журнал реализации

Заполняет агент.

| Дата | Ветка / коммит | Что сделано | Отклонения от спеки |
|---|---|---|---|
| 2026-10-29 | spec/003-t3 | T-3: асинхронный порт, очередь записи, подписка с буфером | Сверх буквы 4.2: резервирование лимита MAX_ACTIVE_SWARMS на время записи `swarm.created` — сохраняет поведение 001 при асинхронном порте; при сбое записи `swarm.created` `createSwarm` бросает (500), D-86; сбой слушателя не мешает рассылке. Тесты AC-003-4/5 написаны вместе со сменой сигнатур — на старом коде не компилировались. |
