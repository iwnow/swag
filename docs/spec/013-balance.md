---
id: "013"
title: Баланс организации
status: draft
roadmap_stage: 5
depends_on: ["003", "004", "024"]
superseded_by: null
updated: 2026-11-01
---

# 013. Баланс организации

> **Коротко.**
> - У организации появляется общий баланс по предоплате в micro-USD. Баланс — сумма записей журнала баланса: пополнений и закрытий роёв.
> - Пополнение в MVP виртуальное. Администратор пополняет баланс своей организации, супервизор — любой организации, с обязательным комментарием.
> - Запуск роя резервирует его бюджет из баланса одной транзакцией. Если доступного остатка не хватает, рой не создаётся: `402 insufficient_balance`. Параллельные запуски не уводят баланс в минус.
> - Когда рой завершился, резерв закрывается фактической суммой из ledger gateway, неизрасходованное возвращается. Gateway при закрытии роя ждёт, пока завершатся вызовы, которые ещё идут, — до 5 с.
> - Логика — новое ядро `billing-core`. Оно работает в процессе `api`, таблицы лежат в общей базе Postgres.
> - В кабинете появляется страница «Баланс»: остаток, резерв, история операций и форма пополнения для администратора. Экран супервизора — спека 014.
> - **Нужно от человека:** ответы на Q-1…Q-8. Контракты написаны по рекомендациям. Главные развилки: Q-1 — откуда брать сумму закрытия роя; Q-2 — compute в 013 не считается; Q-3 — без наценки и в USD.

## 1. Контекст и цель

Роадмап:
- этап 5 «Компании, доступ, баланс»;
- [раздел 8 «Пользователи, доступ и баланс»](../../AI_PLATFORM_ROADMAP.md#8-пользователи-доступ-и-баланс), абзац «Баланс — предоплата, общий на организацию»;
- критерий MVP 10 «Баланс» (первые две фразы; третья — баланс ИИ — спека 025);
- шаг 4 сценария приёмки 13 (пополнение общего баланса).

**Сейчас:**
- после 004 у роя есть бюджет, а gateway не тратит больше бюджета;
- после 024 у роя есть организация и автор;
- но бюджет роя ни из чего не берётся: любой пользователь запускает сколько угодно роёв с бюджетом до `SWARM_MAX_BUDGET_MICRO_USD`, деньги организации нигде не считаются.

**Цель:**
- у организации есть баланс, его можно пополнить;
- рой стартует, только если бюджет помещается в доступный остаток;
- после роя баланс уменьшается ровно на сумму его записей в ledger gateway;
- история операций видна в кабинете.

## 2. Объём

**Входит:**
- `@swag/contracts`:
  - схемы баланса (`billing.ts`);
  - права `balance.read` и `balance.topup`;
  - поле `spentMicroUsd` в итоговых событиях роя;
  - `heldMicroUsd` в `LlmSwarmClosed` (`swarm.ts`);
- новый пакет `packages/billing-core`: баланс, пополнение, резерв и закрытие резерва, проверка вызывающего;
- `adapter-postgres`:
  - миграция `0005_billing.sql`;
  - хранилище `createPostgresBalanceStore`;
- `adapter-memory`: `createMemoryBalanceStore`;
- `api-core`:
  - порт `Billing`;
  - резерв в `createSwarm`;
  - закрытие резерва на итоговом событии роя;
  - добор незакрытых резервов при старте;
- `apps/api`:
  - маршруты баланса;
  - сборка `billing-core` в `startApiCore`;
  - проверка организации через identity;
  - таймаут клиента оркестратора (из N-25);
- `identity-core` и `apps/identity`: внутренний маршрут «организация существует»;
- `llm-gateway-core` и `apps/llm-gateway`: закрытие роя ждёт завершения идущих вызовов;
- `orchestrator-core` и `adapter-gateway-http`: сумма из закрытия роя в итоговом событии;
- `cabinet`: страница «Баланс».

**Не входит** (агент это не делает, даже если кажется логичным):
- баланс ИИ, траты LLM-узлов вне роя и отказ сверх остатка баланса ИИ — 025 (D-27);
- стоимость compute: секунды песочницы × тариф — Q-2;
- наценка, тарифы, подписка и платные опции — D-36 (Q-3, Q-5);
- реальная оплата и платёжный шлюз — после MVP; действие «пополнить» остаётся тем же;
- счёт платформы: поступления, маржа, остаток кредитов у провайдера — D-38 (Q-5);
- экраны супервизора и админки, каркас микрофронтендов — 014. Супервизор пополняет через API;
- уведомления о низком остатке, автопополнение, лимиты трат на пользователя;
- списание и возврат вручную, кроме пополнения: исправление ошибок — отдельной спекой;
- перенос денег между организациями;
- рои до 024 без организации: им резерв не нужен, они уже завершены (003, `closeInterrupted`);
- несколько экземпляров `api`: добор резервов при старте рассчитан на один процесс, как в 004;
- повторная доставка итоговых событий при сбое шины — спека надёжности шины (N-11);
- точное закрытие в трёх редких случаях — Q-8 и D-125:
  - рой, который оркестратор запустил, а `api` счёл запуск неудачным;
  - рой, закрытый `closeInterrupted`;
  - списание, которое пришло позже `LLM_GATEWAY_CLOSE_WAIT_MS`;
- резерв роя, по которому итогового события не будет (оркестратор потерял рой), — до перезапуска `api` (D-125).

## 3. Требования

| ID | Требование | Приоритет |
|---|---|---|
| REQ-013-1 | Баланс организации MUST быть суммой записей журнала баланса этой организации. Записи не удаляются и не меняются. | MUST |
| REQ-013-2 | Администратор MUST пополнять баланс своей организации на сумму от 1 µUSD до `BALANCE_MAX_TOPUP_MICRO_USD`. Супервизор MUST пополнять баланс любой существующей организации, только с непустым комментарием. Пользователь `user` пополнять не может. | MUST |
| REQ-013-3 | Пользователь, администратор и супервизор MUST видеть баланс, резерв, доступный остаток и историю операций. `user` и `admin` — только своей организации, супервизор — любой. Чужая организация — `404`. | MUST |
| REQ-013-4 | `createSwarm` MUST резервировать бюджет роя из доступного остатка одной транзакцией, до записи `swarm.created`. При нехватке рой не создаётся: `402 insufficient_balance`, событий и обращения к оркестратору нет. | MUST |
| REQ-013-5 | Параллельные запуски роёв одной организации MUST NOT резервировать в сумме больше доступного остатка. Баланс и резерв MUST NOT становиться отрицательными. | MUST |
| REQ-013-6 | После итогового события роя (`swarm.completed`, `swarm.stopped`, `swarm.failed`) резерв MUST закрываться ровно один раз. В журнал пишется запись `swarm` на сумму трат роя, остаток резерва возвращается в доступный. | MUST |
| REQ-013-7 | Сумма закрытия MUST равняться сумме записей ledger gateway по рою, если gateway закрыл рой без висящих резервов. | MUST |
| REQ-013-8 | Резерв, который не закрылся из-за сбоя, MUST закрываться при следующем старте `api`. | MUST |
| REQ-013-9 | Закрытие роя в gateway MUST ждать, пока резервы вызовов роя, которые уже идут, будут списаны, — не дольше `LLM_GATEWAY_CLOSE_WAIT_MS`. | MUST |
| REQ-013-10 | Пополнение, отказ по балансу и закрытие резерва MUST логироваться структурно, только с полями 4.3: `orgId`, `swarmId`, `actorId` и суммы. | MUST |
| REQ-013-11 | Кабинет MUST показывать страницу «Баланс»: остаток, резерв, доступно, история. Форма пополнения — только с правом `balance.topup`. | MUST |
| REQ-013-12 | Запросы `api` к оркестратору SHOULD обрываться по таймауту `ORCHESTRATOR_TIMEOUT_MS` (из N-25). | SHOULD |

## 4. Контракты

### 4.1. `@swag/contracts`

Новый файл `src/billing.ts`, экспорт из `index.ts`:

```ts
import { z } from 'zod';
import { OrgId, UserId } from './auth.ts';
import { MicroUsd } from './llm.ts';
import { SwarmId } from './swarm.ts';

// Сумма одного пополнения. Рабочий предел — BALANCE_MAX_TOPUP_MICRO_USD (4.10).
export const TopupMicroUsd = z.number().int().min(1).max(1_000_000_000); // до $1000

export const TopupRequest = z.strictObject({
  amountMicroUsd: TopupMicroUsd,
  comment: z.string().trim().min(1).max(500).nullable().default(null), // пустая строка не проходит: форма шлёт null; супервизору обязателен (4.3)
});

export const BalanceView = z.strictObject({
  orgId: OrgId,
  balanceMicroUsd: MicroUsd, // сумма записей журнала
  heldMicroUsd: MicroUsd, // резервы роёв, которые ещё идут
  availableMicroUsd: MicroUsd, // balance − held
});

export const BalanceEntryKind = z.enum(['topup', 'swarm']);

export const BalanceEntry = z.strictObject({
  id: z.number().int().positive(), // порядковый номер записи, общий на все организации (Q-6)
  orgId: OrgId,
  ts: z.iso.datetime(),
  kind: BalanceEntryKind,
  amountMicroUsd: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), // topup > 0, swarm ≤ 0
  swarmId: SwarmId.nullable(), // только у swarm
  actorId: UserId.nullable(), // кто пополнил; у swarm — null
  comment: z.string().nullable(),
});

export const BalanceEntryList = z.strictObject({
  entries: z.array(BalanceEntry), // от новых к старым
  nextBefore: z.number().int().positive().nullable(), // id для следующей страницы; null — страниц больше нет
});
```

`access.ts`: в `Permission` добавить `'balance.read'` и `'balance.topup'`.

```ts
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  user: ['swarm.create', 'swarm.read', 'swarm.stop', 'balance.read'],
  admin: ['swarm.create', 'swarm.read', 'swarm.stop', 'user.manage', 'balance.read', 'balance.topup'],
  supervisor: ['swarm.read', 'swarm.stop', 'user.manage', 'organization.read', 'balance.read', 'balance.topup'],
};
```

`events.ts`: в `data` событий `swarm.completed`, `swarm.stopped` и `swarm.failed` добавить `spentMicroUsd: MicroUsd.optional()`.
- Поле пишет оркестратор — сумму из ответа gateway на закрытие роя (4.6).
- Поля нет, если gateway не ответил, у события, которое записал `api` (сбой запуска, `closeInterrupted`), и у событий до 013.

`swarm.ts`:

```ts
export const LlmSwarmClosed = z.strictObject({
  spentMicroUsd: MicroUsd,
  heldMicroUsd: MicroUsd, // резервы, не списанные к концу ожидания (4.7); 0 — сумма окончательная
});
```

### 4.2. Таблицы: `packages/adapter-postgres/migrations/0005_billing.sql`

```sql
-- Up Migration
create table org_balances (
  org_id uuid primary key,
  balance_micro_usd bigint not null default 0 check (balance_micro_usd >= 0),
  held_micro_usd bigint not null default 0 check (held_micro_usd >= 0),
  check (held_micro_usd <= balance_micro_usd)
);
create table balance_entries (
  id bigserial primary key,
  org_id uuid not null,
  ts timestamptz not null,
  kind text not null check (kind in ('topup', 'swarm')),
  amount_micro_usd bigint not null,
  swarm_id uuid unique,
  actor_id uuid,
  comment text,
  check ((kind = 'topup' and amount_micro_usd > 0 and swarm_id is null)
      or (kind = 'swarm' and amount_micro_usd <= 0 and swarm_id is not null and actor_id is null)),
  check (kind <> 'topup' or actor_id is not null)
);
create index balance_entries_org_idx on balance_entries (org_id, id desc);
create table balance_holds (
  swarm_id uuid primary key,
  org_id uuid not null,
  amount_micro_usd bigint not null check (amount_micro_usd > 0),
  created_at timestamptz not null
);
-- Down Migration
drop table balance_holds;
drop table balance_entries;
drop table org_balances;
```

- `org_balances.balance_micro_usd` — кэш суммы `balance_entries` организации. Он меняется в той же транзакции, что и запись. Строка организации появляется при первом пополнении.
- Внешних ключей на таблицы identity и роёв нет: сервисы владеют своими таблицами (4.8 спеки 024).
- Чтение строк: `bigint` из `pg` приходит строкой — `Number(...)`, как в `BudgetStore` gateway; `timestamptz` — `toISOString()`.

**Пополнение** (`topup`) одной транзакцией:

```sql
insert into org_balances (org_id, balance_micro_usd) values ($org, $amt)
  on conflict (org_id) do update set balance_micro_usd = org_balances.balance_micro_usd + $amt;
insert into balance_entries (org_id, ts, kind, amount_micro_usd, actor_id, comment)
  values ($org, $ts, 'topup', $amt, $actor, $comment) returning *;
```

**Резерв** (`reserve`) одной транзакцией:

```sql
update org_balances set held_micro_usd = held_micro_usd + $amt
 where org_id = $org and balance_micro_usd - held_micro_usd >= $amt
returning 1;                    -- 0 строк (нет строки или мало денег) → 'insufficient', rollback
insert into balance_holds (swarm_id, org_id, amount_micro_usd, created_at) values ($swarm, $org, $amt, $ts);
```

Повтор `swarmId` — конфликт первичного ключа, исключение. `api-core` генерирует новый `swarmId` на каждый запуск, повтора не бывает.

**Закрытие** (`settle(swarmId, spentMicroUsd, ts)`) одной транзакцией:
1. `delete from balance_holds where swarm_id = $swarm returning org_id, amount_micro_usd`. 0 строк — вернуть `null`, больше ничего не делать: резерв уже закрыт или его не было.
2. `charge = min(spentMicroUsd, amount)`.
3. `insert into balance_entries (org_id, ts, kind, amount_micro_usd, swarm_id) values ($org, $ts, 'swarm', -charge, $swarm)`.
4. `update org_balances set balance_micro_usd = balance_micro_usd - charge, held_micro_usd = held_micro_usd - amount where org_id = $org`.
5. Вернуть `{ orgId, heldMicroUsd: amount, chargedMicroUsd: charge }`.

**Чтение:**
- `balance(orgId)` — строка `org_balances`. Строки нет — нули.
- `entries(orgId, before, limit)` — `where org_id = $org and ($before is null or id < $before) order by id desc limit $limit + 1`. Лишняя строка значит, что есть следующая страница: `nextBefore` — `id` последней отданной.
- `holds()` — все строки `balance_holds` (`swarmId`, `orgId`, `amountMicroUsd`).

### 4.3. Ядро `packages/billing-core`

```ts
import type { Actor, BalanceEntry, BalanceEntryList, BalanceView } from '@swag/contracts';

// Свои порты ядра по образцу api-core: ядра не импортируют друг друга.
export interface Clock { now(): string } // ISO
export type LogContext = {
  orgId?: string;
  swarmId?: string;
  actorId?: string;
  amountMicroUsd?: number;
  spentMicroUsd?: number;
  heldMicroUsd?: number;
  chargedMicroUsd?: number;
  err?: unknown;
};
export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
}

export interface BalanceStore {
  balance(orgId: string): Promise<{ balanceMicroUsd: number; heldMicroUsd: number }>; // нет строки — нули
  entries(orgId: string, before: number | null, limit: number): Promise<{ entries: BalanceEntry[]; hasMore: boolean }>;
  topup(input: { orgId: string; amountMicroUsd: number; actorId: string; comment: string | null; ts: string }): Promise<BalanceEntry>;
  reserve(input: { orgId: string; swarmId: string; amountMicroUsd: number; ts: string }): Promise<'ok' | 'insufficient'>;
  settle(swarmId: string, spentMicroUsd: number, ts: string): Promise<{ orgId: string; heldMicroUsd: number; chargedMicroUsd: number } | null>;
  holds(): Promise<{ swarmId: string; orgId: string; amountMicroUsd: number }[]>;
}

export interface OrgDirectory {
  exists(orgId: string): Promise<boolean>; // ошибка связи — исключение
}

export interface BillingCoreDeps {
  store: BalanceStore;
  orgs: OrgDirectory;
  clock: Clock;
  log: Logger;
  limits: { maxTopupMicroUsd: number }; // BALANCE_MAX_TOPUP_MICRO_USD
}

export interface BillingError { code: string; message: string; issues?: { path: string; message: string }[] }
export type BillingResult<T> = { ok: true; value: T } | { ok: false; error: BillingError };

export interface BillingCore {
  getBalance(actor: Actor, orgId: string): Promise<BillingResult<BalanceView>>;
  listEntries(actor: Actor, orgId: string, query: { before?: string; limit?: string }): Promise<BillingResult<BalanceEntryList>>;
  topup(actor: Actor, orgId: string, body: unknown): Promise<BillingResult<BalanceEntry>>;
  // Для api-core, без Actor: вызывающего проверил createSwarm.
  reserve(orgId: string, swarmId: string, amountMicroUsd: number): Promise<'ok' | 'insufficient'>;
  settle(swarmId: string, spentMicroUsd: number): Promise<void>;
  holds(): Promise<{ swarmId: string; orgId: string; amountMicroUsd: number }[]>;
}

export function createBillingCore(deps: BillingCoreDeps): BillingCore;
```

Оболочка передаёт в ядро тот же логгер, что в `api-core`. Коды ошибок — как в `api-core`: `validation_error`, `forbidden`, `not_found`, плюс `org_directory_unavailable`. `ts` в хранилище — `clock.now()`.

**Правила доступа** (одинаковые для трёх операций с `Actor`):
1. `orgId` не UUID → `not_found`.
2. Нет нужного права (`balance.read` для чтения, `balance.topup` для пополнения) → `forbidden`.
3. `actor.role !== 'supervisor'` и `orgId !== actor.orgId` → `not_found`.
4. Супервизор при пополнении: `orgs.exists(orgId)` — `false` → `not_found`. Исключение → `org_directory_unavailable` (HTTP 503), лог `warn`. Чтение супервизором проверку не делает: у несуществующей организации баланс нулевой.

**`topup`:**
- тело — `TopupRequest`, иначе `validation_error` с `issues`;
- `amountMicroUsd > limits.maxTopupMicroUsd` → `validation_error` `amount exceeds BALANCE_MAX_TOPUP_MICRO_USD`;
- супервизор и `comment === null` → `validation_error` `comment is required`;
- запись — `store.topup` с `actorId = actor.userId`, лог `info` `balance_topup` (`orgId`, `actorId`, `amountMicroUsd`).

**`listEntries`:**
- `limit` — целое 1…100, по умолчанию 50;
- `before` — целое 1…`Number.MAX_SAFE_INTEGER` или отсутствует;
- другое значение → `validation_error`.

**`getBalance`:** `availableMicroUsd = balance − held`.

**`reserve`:** `amountMicroUsd` — бюджет роя. `insufficient` → лог `info` `balance_insufficient` (`orgId`, `swarmId`, `amountMicroUsd`).

**`settle`:**
- `store.settle`;
- результат не `null` → лог `info` `balance_settled` (`orgId`, `swarmId`, `heldMicroUsd`, `chargedMicroUsd`);
- `spentMicroUsd > heldMicroUsd` → дополнительно лог `error` `balance_overspent` с обеими суммами. Такого не бывает, пока бюджет роя в gateway равен резерву: списывается не больше резерва.

Ядро — чистый TypeScript: только пакеты из `CORE_ALLOWED_PACKAGES` в `scripts/arch-check.ts` (`zod`, `@swag/contracts`); `@swag/helpers` ядру запрещён.

### 4.4. `api-core`

Порт:

```ts
export interface Billing {
  reserve(orgId: string, swarmId: string, amountMicroUsd: number): Promise<'ok' | 'insufficient'>; // ошибка — исключение
  settle(swarmId: string, spentMicroUsd: number): Promise<void>;
  holds(): Promise<{ swarmId: string; orgId: string; amountMicroUsd: number }[]>;
}
// ApiCoreDeps: добавить billing: Billing.
```

**`createSwarm`.** Порядок:
1. Проверки 004, 024 и 031 — как сейчас.
2. Место под `MAX_ACTIVE_SWARMS` (`reserving`).
3. `actor.orgId === null` → `forbidden`. Сейчас недостижимо: у супервизора нет `swarm.create`. Ветка нужна вместо `!`.
4. `billing.reserve(actor.orgId, swarmId, budgetMicroUsd)` — до записи `swarm.created`.
   - `insufficient` → `insufficient_balance` с сообщением `balance is not enough for budget`. Событий нет.
   - Исключение пробрасывается: оболочка отвечает `500` общим обработчиком ошибок.
   - В обоих случаях место под `MAX_ACTIVE_SWARMS` освобождается в том же `finally`, что и сейчас.
5. Запись `swarm.created` — как сейчас. Если `commit` вернул `null` (запись не удалась): `billing.settle(swarmId, 0)`, затем прежний ответ.
6. Запуск. При сбое `orchestrator.launch`:
   - сначала `orchestrator.stop(swarmId)`, ошибка — лог `warn` `launch_stop_failed`. Если оркестратор успел запустить рой, `stop` обрывает траты;
   - затем `swarm.failed` `orchestrator_unavailable`, как сейчас.

   Резерв закрывается общим правилом ниже, по проекции (Q-8).

**Закрытие на итоговом событии — в одном месте, в `commit`.** После записи и рассылки `swarm.completed`, `swarm.stopped` или `swarm.failed`, внутри той же записи в очереди роя:

```ts
await billing.settle(swarmId, finalSpent(event, viewAfter));
```

- `finalSpent(event, view)` = `event.data.spentMicroUsd`, если поле есть.
- Иначе `view.spentMicroUsd` проекции после события и лог `warn` `balance_settled_from_events` (`swarmId`, `spentMicroUsd`).
- Так закрываются все пути: `ingestEvent`, сбой запуска, `closeInterrupted`, остановки (через итоговое событие оркестратора).
- Исключение `settle` ловится: лог `error` `billing_settle_failed` (`swarmId`, `err`). `commit` возвращает записанное событие, как без сбоя.

**Добор при старте.** Новая операция:

```ts
settlePending(): Promise<number>; // число закрытых резервов
```

Для каждого резерва из `billing.holds()`:
- рой в хранилище в итоговом статусе — последнее событие роя `(await store.events(swarmId, view.lastSeq - 1))[0]`, затем `billing.settle(swarmId, finalSpent(event, view))`;
- роя нет в хранилище (сбой между резервом и записью `swarm.created`) — `billing.settle(swarmId, 0)`;
- рой не в итоговом статусе — резерв не трогается. При старте после `closeInterrupted` таких нет. Ветка защищает идущие рои, если операцию вызовут не на старте.

Сбой одного резерва — лог `error` `billing_settle_failed`, остальные продолжаются.

`STATUS` оболочки: `insufficient_balance: 402`, `org_directory_unavailable: 503`.

**Тесты.** В `packages/api-core/test` — общий фейк `Billing`:
- безлимитный: `reserve` всегда `ok`;
- записывает вызовы.

Все существующие вызовы `createApiCore` в тестах получают его.

### 4.5. HTTP `api`

Маршруты — в той же области с проверкой токена, что и `/swarms` (024, 4.5):

| Метод и путь | Право | Тело | Ответ |
|---|---|---|---|
| `GET /organizations/:orgId/balance` | `balance.read` | — | `200 BalanceView`; `403 forbidden`; `404 not_found` |
| `GET /organizations/:orgId/balance/entries?before=&limit=` | `balance.read` | — | `200 BalanceEntryList`; `400 validation_error`; `403`; `404` |
| `POST /organizations/:orgId/balance/topups` | `balance.topup` | `TopupRequest` | `201 BalanceEntry`; `400 validation_error`; `403`; `404`; `503 org_directory_unavailable` |
| `POST /swarms` | как в 024 | как в 004 | плюс `402 insufficient_balance` |

Ошибки — `{ error: { code, message, issues? } }`, как у остальных маршрутов `api`.

### 4.6. Оркестратор

- Порт `LlmSwarms.close(swarmId): Promise<number | null>` — `spentMicroUsd` из ответа; `null` — gateway ответил `404`.
- `finish`:
  - результат `close` с числом → `spentMicroUsd` в `data` итогового события;
  - `null` или исключение → поля нет, лог как в 004.
- `adapter-gateway-http`:
  - ответ `200` разбирается схемой `LlmSwarmClosed`;
  - тело не по схеме — исключение;
  - `heldMicroUsd` адаптер не проверяет: о висящих резервах пишет лог сам gateway (4.7).

### 4.7. Gateway: закрытие роя ждёт идущие вызовы

- `BudgetStore.close(swarmId, now)` возвращает `{ spentMicroUsd, heldMicroUsd } | null`.
- Новый метод `BudgetStore.totals(swarmId): Promise<{ spentMicroUsd: number; heldMicroUsd: number } | null>` — `spent_micro_usd` и `held_micro_usd` строки `swarm_budgets`.
- `LlmGatewayCoreDeps` получает:
  - `sleep(ms: number): Promise<void>`;
  - `closeWaitMs: number` — `LLM_GATEWAY_CLOSE_WAIT_MS`.

`closeSwarm`:
1. `budgets.close`, `null` → `404 not_found`, как в 004.
2. Пока `heldMicroUsd > 0` и с начала закрытия по `Clock` прошло меньше `closeWaitMs` — `sleep(100)`, затем `budgets.totals`.
3. Ожидание кончилось, а `heldMicroUsd > 0` → лог `warn` `close_holds_pending` (`swarmId`, `heldMicroUsd`).
4. Ответ `200 LlmSwarmClosed` с последними `spentMicroUsd` и `heldMicroUsd`.

Повтор закрытия по-прежнему отвечает тем же: `close` у закрытого роя не меняет `closed_at`. Ожидание повторяется.

### 4.8. identity: организация существует

| Метод и путь | Токен | Ответ |
|---|---|---|
| `GET /internal/organizations/:orgId` | `Authorization: Bearer <IDENTITY_INTERNAL_TOKEN>` (`bearerMatches`, как `/internal/token-revocations`) | `204` — есть; `404 not_found` — нет или не UUID; `401 unauthorized` |

- `IdentityStore.findOrganizationById(id: string): Promise<StoredOrganization | null>`: Postgres — `select … from organizations where id = $1`, память — поиск в `Map`.
- Операция `identity-core`: `organizationExists(orgId: string): Promise<boolean>`, не UUID → `false`.

### 4.9. Оболочка `apps/api`

**`startApiCore`** (`apps/api/src/start.ts`):
- получает фабрику `billing: (pool: pg.Pool) => Billing`;
- порядок: миграции → пул → `createApiCore({ ...deps, store, billing: billing(pool) })` → `closeInterrupted` → `settlePending`;
- `deps` — `Omit<ApiCoreDeps, 'store' | 'billing'>`;
- тест AC-003-8 и остальные вызовы `startApiCore` передают фабрику.

**`main.ts`.** Фабрика — `(pool) => createBillingCore({ store: createPostgresBalanceStore(pool), orgs, clock, log, limits })`. Ядро `billing-core` нужно и маршрутам, поэтому `main.ts` сохраняет созданный экземпляр для `buildApp`.
- `DATABASE_URL` в `api` обязателен, как сейчас. `createMemoryBalanceStore` — только для тестов.
- `orgs` — `createOrgDirectory` из нового файла `apps/api/src/organizations.ts`:

  ```ts
  export function createOrgDirectory(options: { identityUrl: string; token: string; timeoutMs: number }): OrgDirectory;
  ```

  `fetch` `GET {IDENTITY_URL}/internal/organizations/:orgId`, заголовок `Authorization: Bearer <token>`, `AbortSignal.timeout(timeoutMs)`.
  - `204` → `true`;
  - `404` → `false`;
  - другое — исключение.

  `timeoutMs` — существующая константа `IDENTITY_TIMEOUT_MS` в `main.ts`.

**Маршруты 4.5** — в `apps/api/src/app.ts`, в той же области, что `/swarms`. `buildApp` получает `BillingCore` новым аргументом.

**Из N-25:**
- `@swag/adapter-orchestrator-http` получает опцию `timeoutMs`. `launch` и `stop` идут с `AbortSignal.timeout(timeoutMs)`. Таймаут — та же ошибка, что недоступность оркестратора.
- В `main.ts` — константа `ORCHESTRATOR_TIMEOUT_MS = 15000`, по образцу `GATEWAY_TIMEOUT_MS` оркестратора (D-99).
- 15 с больше, чем `stop` оркестратора: тот ждёт `finish` — уборку песочниц и закрытие в gateway до `LLM_GATEWAY_CLOSE_WAIT_MS`.

### 4.10. Конфиг

| Переменная | Сервис | По умолчанию | Описание |
|---|---|---|---|
| `BALANCE_MAX_TOPUP_MICRO_USD` | `api` | `100000000` ($100) | Предел одного пополнения; целое 1…1 000 000 000 |
| `LLM_GATEWAY_CLOSE_WAIT_MS` | `llm-gateway` | `5000` | Ожидание идущих вызовов при закрытии роя; целое 0…8 000 |

- Предел 8 000 меньше `GATEWAY_TIMEOUT_MS` оркестратора (10 000). Иначе запрос `close` оборвётся раньше ответа и `spentMicroUsd` потеряется.
- Обе переменные — в `packages/config` (схемы сервисов), `.env.example`, `.env` и `compose.yaml`.
- `api` уже получает `IDENTITY_URL` и `IDENTITY_INTERNAL_TOKEN` (024).

### 4.11. Кабинет

Файлы `apps/ui/cabinet/src/app/`:

| Файл | Что |
|---|---|
| `api.ts` | `getBalance(orgId)`, `listBalanceEntries(orgId, before)`, `topup(orgId, body)` по образцу вызовов `/swarms` |
| `balance.page.ts` | новая страница |
| `app.routes.ts` | маршрут `/balance` за guard |
| `app.ts` | пункт «Баланс» в навигации, только у сессии с `organization` |
| `swarm-new.page.ts` | отказ `402` |

**Страница:**
- три числа: «Баланс», «В резерве», «Доступно» — `formatUsd` из `ui-core`;
- история: дата, вид («Пополнение» или «Рой»), сумма со знаком, ссылка на рой, комментарий;
- кнопка «Ещё» грузит следующую страницу по `nextBefore`.

**Форма пополнения:**
- видна, если в `ROLE_PERMISSIONS[session.user.role]` есть `balance.topup`;
- поля: сумма в долларах и комментарий;
- сумма — существующая `usdToMicro` из `ui-core` (004), проверка — схема `TopupRequest`;
- пустой комментарий отправляется как `null`;
- после успеха баланс и история перечитываются.

`orgId` — `organization.id` из сессии (`AuthSession`). У супервизора организации нет, и пункта «Баланс» тоже нет: его экран — 014.

**Форма роя.** Ответ `402 insufficient_balance` показывается текстом «Недостаточно средств: доступно $X».
- X — `formatUsd(availableMicroUsd)` из `GET /organizations/:orgId/balance`, перечитанного после отказа.
- `formatUsd` округляет вверх до 4 знаков. Расхождение меньше $0.0001 принимается.

## 5. Критерии приёмки

- **AC-013-1** — *Given* хранилище баланса (память и Postgres) *When* три пополнения 100, 200, 300 *Then* `balance` = 600, `held` = 0, в `entries` три записи `topup` от новых к старым.
- **AC-013-2** — *Given* администратор организации A *When* `POST /organizations/A/balance/topups` с 1 000 000 *Then* `201`, запись с `actorId` администратора, `GET …/balance` — `balanceMicroUsd: 1000000`.
- **AC-013-3** — *Given* `user` организации A *When* пополнение A *Then* `403 forbidden`. *Given* администратор A *When* пополнение B *Then* `404 not_found`.
- **AC-013-4** — *Given* супервизор, пополнение:
  - без комментария *Then* `400 validation_error`;
  - с комментарием, для существующей организации *Then* `201`;
  - для организации, которой нет в identity *Then* `404`;
  - identity недоступна *Then* `503 org_directory_unavailable`.
- **AC-013-5** — *Given* администратор *When* сумма 0, дробная или больше `BALANCE_MAX_TOPUP_MICRO_USD` *Then* `400 validation_error`, баланс не изменился.
- **AC-013-6** — *Given* `user` и `admin` организации A и супервизор *When* `GET /organizations/A/balance` и `…/entries` *Then* `200` у всех троих. *Given* `user` организации B *Then* `404`. *Given* `orgId` не UUID *Then* `404`.
- **AC-013-7** — *Given* 120 записей *When* `entries` с `limit=50`, затем по `nextBefore` *Then* страницы 50, 50, 20, у последней `nextBefore: null`, порядок по убыванию `id` без пропусков и повторов. `limit=0`, `limit=101`, `before=abc`, `before=9007199254740992` → `400`.
- **AC-013-8** — *Given* доступно 1 000 000 *When* `POST /swarms` с бюджетом 1 000 001 *Then*:
  - `402 insufficient_balance`;
  - у роя нет событий, оркестратор не вызывался;
  - место под `MAX_ACTIVE_SWARMS` свободно.
- **AC-013-9** — *Given* доступно 1 000 000 *When* `POST /swarms` с бюджетом 400 000 *Then* `201`, `held` = 400 000, `available` = 600 000.
- **AC-013-10** — *Given* Postgres и доступно 1 000 000 *When* 10 параллельных `reserve` по 300 000 *Then* успешно ровно 3, `held` = 900 000, баланс не изменился.
- **AC-013-11** — *Given* рой с резервом 400 000 *When* приходит `swarm.completed` с `spentMicroUsd: 123 456` *Then* в журнале запись `swarm` −123 456 с `swarmId`, `balance` уменьшился на 123 456, `held` уменьшился на 400 000.
- **AC-013-12** — *Given* резерв уже закрыт *When* то же итоговое событие приходит второй раз или `settle` вызывается снова *Then* записей и изменений баланса нет.
- **AC-013-13** — *Given* итоговое событие без `spentMicroUsd`, а у проекции роя `spentMicroUsd` 7 000 *When* `ingestEvent` *Then* закрытие на 7 000 и лог `balance_settled_from_events`.
- **AC-013-14** — *Given* оркестратор недоступен *When* `POST /swarms` *Then*:
  - вызван `orchestrator.stop` этого роя;
  - `swarm.failed` `orchestrator_unavailable`;
  - резерв закрыт на сумму проекции (0), `available` вернулся к прежнему.
- **AC-013-15** — *Given* запись `swarm.created` после резерва не удалась *When* `createSwarm` *Then* резерв закрыт на 0, ответ — прежний.
- **AC-013-16** — *Given* четыре резерва *When* `settlePending` *Then* закрыты 1-й, 2-й и 4-й, 3-й остался, результат — 3. Резервы:
  1. рой завершён, итоговое событие с `spentMicroUsd` 9 000, проекция 5 000 — закрыт на 9 000;
  2. рой завершён, событие без поля, проекция 5 000 — закрыт на 5 000;
  3. рой в статусе `running` — не тронут;
  4. роя нет в хранилище — закрыт на 0.
- **AC-013-17** — *Given* `settle` бросает исключение *When* `ingestEvent` итогового события *Then* событие записано и отдано подписчикам, лог `billing_settle_failed`.
- **AC-013-18** — *Given* gateway с резервом идущего вызова *When* `closeSwarm`:
  - списание вызова приходит через 300 мс *Then* ответ после списания, `heldMicroUsd: 0`, `spentMicroUsd` включает вызов;
  - списание не пришло за `closeWaitMs` *Then* ответ с `heldMicroUsd > 0` и лог `close_holds_pending`;
  - при `heldMicroUsd = 0` *Then* ни одного `sleep`;
  - повторный `closeSwarm` *Then* тот же `spentMicroUsd`.

  Часы и `sleep` — тестовые.
- **AC-013-19** — *Given* `LlmSwarms.close` вернул 4 200 *When* `finish` *Then* в `data` итогового события `spentMicroUsd: 4200`. *Given* `close` бросил исключение или вернул `null` *Then* поля нет, рой завершён.
- **AC-013-20** — *Given* identity *When* `GET /internal/organizations/:id` *Then*:
  - с верным токеном, организация есть — `204`;
  - организации нет — `404`;
  - `id` не UUID — `404`;
  - без токена — `401`.
- **AC-013-21** — *Given* `adapter-orchestrator-http` с `timeoutMs: 100` и оркестратор, который не отвечает *When* `launch` *Then* ошибка не позже чем через 1 с.
- **AC-013-22** — *Given* права ролей *Then* `user` — `balance.read` без `balance.topup`; `admin` и `supervisor` — оба права.
- **AC-013-23** — *Given* фейковый логгер ядра *When* пополнение, отказ резерва и закрытие *Then* логи `balance_topup`, `balance_insufficient` и `balance_settled` с полями 4.3 и без других полей.
- **AC-013-24** `[stack]` — *Given* поднятый контур *When*:
  1. администратор новой организации пополняет баланс на $1;
  2. запускает рой с бюджетом $0.50;
  3. запускает второй рой с бюджетом $0.60;
  4. первый рой завершается.

  *Then*:
  - второй рой — `402`;
  - после первого запуска `held` = $0.50;
  - после итогового события баланс уменьшился ровно на `sum(amount_micro_usd)` из `ledger_entries` роя, `held` = 0.
- **AC-013-25** `[manual]` — *Given* кабинет на поднятом контуре *When* администратор открывает «Баланс», пополняет на $5, запускает рой *Then*:
  - числа и история обновились;
  - во время роя «В резерве» = бюджет роя;
  - после завершения в истории запись «Рой» со ссылкой на рой;
  - у `user` нет формы пополнения.

  Проверка — тексты страницы в журнал.

## 6. Нефункциональные требования

| ID | Требование | Как измеряется |
|---|---|---|
| NFR-013-1 | Резерв добавляет к `POST /swarms` не больше 5 мс на p95 при последовательных запросах | бенчмарк `apps/api/test/bench.test.ts` (`API_BENCH=1`) с Postgres: прирост p95 с `billing-core` на Postgres к фейку `Billing`, где `reserve` сразу `ok` |
| NFR-013-2 | Закрытие роя в gateway без идущих вызовов не делает ни одного ожидания | AC-013-18, случай `heldMicroUsd = 0` |

## 7. Безопасность: что не должно сломаться

- Организация не видит и не пополняет чужой баланс → AC-013-3, AC-013-6.
- `user` не пополняет → AC-013-3, AC-013-22.
- Баланс не уходит в минус при параллельных запусках → AC-013-10, ограничения `check` в 4.2.
- Повторное событие не списывает дважды → AC-013-12.
- Внутренний маршрут identity без токена закрыт → AC-013-20.
- Сбой проверки организации не открывает пополнение (fail closed) → AC-013-4.
- В логах баланса только поля 4.3 → AC-013-23.
- Из кода агента баланс не меняется: маршруты баланса есть только в `api`, с токеном пользователя, а у агента токена пользователя нет (024).

## 8. Задачи для агента

Выполняются по порядку. После каждой задачи — коммит.

**Группа** `spec/013-billing` (T-8…T-14): T-8 добавляет обязательную зависимость `billing` в `ApiCoreDeps`, сборка `apps/api` ломается до T-14.

- [ ] **T-1.** `@swag/contracts`:
  - `billing.ts`, экспорт из `index.ts`;
  - права и `ROLE_PERMISSIONS` в `access.ts`;
  - `spentMicroUsd` в итоговых событиях (`events.ts`);
  - `heldMicroUsd` в `LlmSwarmClosed` (`swarm.ts`).

  Тесты схем:
  - границы `TopupMicroUsd`;
  - `comment` по умолчанию `null`;
  - старые события без `spentMicroUsd` разбираются.

  Места, которые строят `LlmSwarmClosed` (ядро gateway, фейки в тестах), временно получают `heldMicroUsd: 0` с комментарием «013, T-5». Закрывает: AC-013-22. Готово, когда: `npm run typecheck` и тесты `packages/contracts` зелёные.
- [ ] **T-2.** Новый пакет `packages/billing-core` по 4.3:
  - `package.json`, `tsconfig.json` по образцу `packages/api-core`, ссылка в корневом `tsconfig.json`, README;
  - строка в `docs/architecture.md`, раздел «Пакеты»;
  - `createBillingCore`;
  - тесты на фейковом хранилище внутри теста.

  Закрывает: REQ-013-2, REQ-013-3, REQ-013-10; AC-013-3…AC-013-7 и AC-013-23 на уровне ядра. Готово, когда: тесты пакета и `npm run arch:check` зелёные.
- [ ] **T-3.** `adapter-memory`: `createMemoryBalanceStore()` по 4.2.
  - Семантика — как у Postgres.
  - Атомарность — синхронный код без `await` между проверкой и записью.

  Тесты. Закрывает: AC-013-1, AC-013-11 и AC-013-12 на хранилище. Готово, когда: тесты пакета зелёные.
- [ ] **T-4.** `adapter-postgres`:
  - миграция `0005_billing.sql`;
  - `createPostgresBalanceStore(pool)` с SQL и правилами чтения из 4.2;
  - тест числа миграций в `test/migrations.test.ts` — на 5.

  Тесты с `POSTGRES_TEST_URL`. Закрывает: AC-013-1, AC-013-10, AC-013-11, AC-013-12. Готово, когда: тесты пакета с `.env` зелёные.
- [ ] **T-5.** Ожидание в gateway по 4.7:
  - `llm-gateway-core`: `closeSwarm`, `deps.sleep`, `deps.closeWaitMs`, метод `totals` в `BudgetStore`;
  - `adapter-postgres`: `close` возвращает `heldMicroUsd`, новый `totals`;
  - фейки `BudgetStore` в тестах `llm-gateway-core` и `apps/llm-gateway`;
  - `apps/llm-gateway`: `sleep` на `setTimeout`, `LLM_GATEWAY_CLOSE_WAIT_MS` в `packages/config`, `.env.example`, `.env`, `compose.yaml`;
  - убрать временный `heldMicroUsd: 0` из T-1.

  Закрывает: REQ-013-9, AC-013-18, NFR-013-2. Готово, когда: тесты gateway и `npm run typecheck` зелёные.
- [ ] **T-6.** `orchestrator-core` и `adapter-gateway-http` по 4.6:
  - `LlmSwarms.close` возвращает `number | null`;
  - `spentMicroUsd` в итоговом событии;
  - фейки `LlmSwarms` в тестах оркестратора.

  Закрывает: AC-013-19. Готово, когда: тесты пакетов и `apps/orchestrator` зелёные.
- [ ] **T-7.** `identity-core`, `adapter-postgres`, `adapter-memory`, `apps/identity` по 4.8:
  - `findOrganizationById`;
  - `organizationExists`;
  - маршрут `GET /internal/organizations/:orgId`.

  Закрывает: AC-013-20. Готово, когда: тесты identity зелёные.
- [ ] **T-8.** `api-core`:
  - порт `Billing`;
  - шаги 3–6 `createSwarm` (4.4);
  - общий фейк `Billing` в `packages/api-core/test`, подключённый во все существующие вызовы `createApiCore`.

  Закрывает: REQ-013-4; AC-013-8, AC-013-15 на ядре. Готово, когда: тесты `packages/api-core` зелёные.
- [ ] **T-9.** `api-core`: закрытие в `commit` и `finalSpent` (4.4). Закрывает: REQ-013-6, REQ-013-7; AC-013-13, AC-013-14, AC-013-17. Готово, когда: тесты `packages/api-core` зелёные.
- [ ] **T-10.** `api-core`: `settlePending` (4.4). Закрывает: REQ-013-8, AC-013-16. Готово, когда: тесты `packages/api-core` зелёные.
- [ ] **T-11.** Конфиг и адаптер оркестратора:
  - `BALANCE_MAX_TOPUP_MICRO_USD` в `packages/config`, `.env.example`, `.env`, `compose.yaml`;
  - `timeoutMs` в `@swag/adapter-orchestrator-http` (из N-25).

  Закрывает: REQ-013-12, AC-013-21. Готово, когда: тесты пакетов зелёные.
- [ ] **T-12.** `apps/api/src/organizations.ts`: `createOrgDirectory` по 4.9, тесты на тестовом HTTP-сервере. Готово, когда: тесты зелёные.
- [ ] **T-13.** `apps/api/src/start.ts` и тесты `startApiCore`: фабрика `billing`, порядок старта по 4.9. Готово, когда: тесты `apps/api` на `startApiCore` зелёные.
- [ ] **T-14.** `apps/api/src/app.ts` и `main.ts`:
  - маршруты 4.5, `STATUS`, `buildApp` с `BillingCore`;
  - сборка в `main.ts`, `ORCHESTRATOR_TIMEOUT_MS`;
  - существующие тесты `apps/api`, которые создают рои, пополняют баланс организации или передают безлимитный фейк.

  HTTP-тесты на `inject`. Закрывает: AC-013-2…AC-013-9 на HTTP. Готово, когда: `npm run check` зелёный и группа влита в `main`.
- [ ] **T-15.** Кабинет по 4.11: `api.ts`, `balance.page.ts`, `app.routes.ts`, `app.ts`. Закрывает: REQ-013-11 (страница). Готово, когда: `npm run check` зелёный.
- [ ] **T-16.** Кабинет: форма пополнения в `balance.page.ts` и отказ `402` в `swarm-new.page.ts` по 4.11. Закрывает: REQ-013-11 (форма). Готово, когда: `npm run check` зелёный.
- [ ] **T-17.** Стек-тесты в `apps/api/test/stack.test.ts`:
  - новый `it` для AC-013-24: сумма ledger роя читается из Postgres по `DATABASE_URL` теста;
  - в AC-024-24 и других стек-тестах, создающих рои, — пополнение баланса перед запуском.

  Бенчмарк NFR-013-1 в `bench.test.ts`. Закрывает: AC-013-24, NFR-013-1. Готово, когда: стек-тесты зелёные на поднятом контуре.
- [ ] **T-18.** Ручная проверка AC-013-25, журнал, README затронутых пакетов, глоссарий. Закрывает: AC-013-25. Готово, когда: результат в журнале.

## 9. Открытые вопросы

Пока список не пуст, спека не может быть `ready`. Контракты разделов 4–5 написаны по рекомендациям, другой ответ меняет их.

- [ ] **Q-1. Сумма закрытия роя.** Траты роя знают двое: ledger gateway (точно) и проекция `api` (сумма `charge` из `llm.call`, теряется вместе с событием). Варианты:
  - **(а)** gateway при закрытии роя ждёт идущие вызовы (`LLM_GATEWAY_CLOSE_WAIT_MS`), оркестратор кладёт `spentMicroUsd` из ответа в итоговое событие, `api` закрывает резерв этой суммой; без поля — по проекции с `warn`;
  - **(б)** `api` читает `sum(ledger_entries)` роя прямо из общей базы. Точно и без правки gateway, но `api` читает таблицу чужого сервиса, а поздние списания после чтения теряются так же;
  - **(в)** только проекция. Проще всего, но «ровно по ledger» держится, только пока не теряются события.

  Рекомендация — (а): владелец ledger сам отдаёт сумму, а ожидание закрывает гонку «песочница убита, списание ещё пишется». *(Claude, 2026-11-01)*
- [ ] **Q-2. Compute в 013** (из 004, «Не входит»: «стоимость compute — 013»). Секунды песочницы × тариф требуют замера времени песочниц, тарифа и записи ledger `kind = 'compute'`. Варианты:
  - **(а)** не в 013, а в 005 (песочницы, пул и лимиты): там появится, что мерить. При этом ответе на приёмке заводится `D-n` «compute — 005», а в 004 «Не входит» помечается передача;
  - **(б)** в 013: время от `agent.started` до `agent.stopped` × `COMPUTE_PRICE_MICRO_USD_PER_SEC`.

  Рекомендация — (а): сейчас песочница одна на агента без лимитов, тариф пришлось бы выдумать. Поле `kind` позволит добавить compute позже. *(Claude, 2026-11-01)*
- [ ] **Q-3. Цена для пользователя и валюта** (из D-8). Списывать себестоимость или с наценкой? Баланс в USD или в рублях? Минимальный бюджет роя?

  Рекомендация:
  - без наценки: списывается `charge` из 004;
  - баланс в USD (micro-USD, как ledger);
  - минимальный бюджет — прежний `BudgetMicroUsd` ≥ 1.

  Наценка и рубли — вместе с тарифами D-36, когда появится реальная оплата. До неё деньги виртуальные. *(Claude, 2026-11-01)*
- [ ] **Q-4. Чей баланс, кто пополняет и откуда резерв роя** (из D-10, часть «деньги»; часть D-27 о бюджете роя). Варианты:
  - **(а)** баланс организации; пополняют администратор (своей) и супервизор (любой, с комментарием); бюджет роя резервируется из общего баланса;
  - **(б)** баланс на пользователя.

  Рекомендация — (а), как в разделе 8 роадмапа. Перевод роя на баланс ИИ, если понадобится, решает 025 (D-27). *(Claude, 2026-11-01)*
- [ ] **Q-5. Подписка и счёт платформы в 013** (из D-36 и D-38: «куда — 013 и 025»). Рекомендация:
  - в 013 их нет;
  - D-36 остаётся до реальной оплаты, после MVP;
  - D-38 — для 025 и 014.

  Из D-38 в 013 действует одно правило: виртуальное пополнение — не поступление платформы. *(Claude, 2026-11-01)*
- [ ] **Q-6. Кто видит баланс.** Варианты:
  - **(а)** `user` видит баланс и историю своей организации, включая рои коллег: только сумма и `swarmId`, сам рой ему — `404`;
  - **(б)** `user` видит только три числа, история — администратору;
  - **(в)** `user` баланса не видит.

  Рекомендация — (а): пользователю нужно знать доступный остаток до запуска, а сумма роя коллеги не раскрывает его содержимого.

  `id` записи общий на все организации. По разрывам номеров можно грубо оценить активность платформы. Принимается: суммы и организации не видны. *(Claude, 2026-11-01)*
- [ ] **Q-7. Пределы.**
  - `BALANCE_MAX_TOPUP_MICRO_USD`, предел одного виртуального пополнения. Рекомендация — $100: деньги виртуальные, предел защищает от опечатки в лишние нули. Общего предела баланса нет.
  - `LLM_GATEWAY_CLOSE_WAIT_MS`. Рекомендация — 5000, не больше 8000. Вызов, оборванный уборкой песочницы, списывается за миллисекунды.
  - `ORCHESTRATOR_TIMEOUT_MS`. Рекомендация — 15 000: больше времени `stop`.

  *(Claude, 2026-11-01)*
- [ ] **Q-8. Закрытие по проекции, когда сумма из ledger не доходит.** Итоговое событие оркестратора отбрасывается, а резерв закрывается по проекции, в двух случаях:
  - **запуск по таймауту:** оркестратор запустил рой, `api` счёл запуск неудачным и записал `swarm.failed`. Последующие `llm.call` тоже отбрасываются, поэтому проекция занижена, и траты до `stop` не списываются;
  - **`closeInterrupted`:** то же для роёв, прерванных перезапуском `api`.

  Варианты:
  - **(а)** принять: траты ограничены временем до `stop` (секунды) и бюджетом роя. Точное закрытие — D-125;
  - **(б)** при сбое запуска или в `closeInterrupted` не закрывать резерв, пока не придёт итоговое событие оркестратора. Это требует принимать события после `swarm.failed` от `api` и меняет 003.

  Рекомендация — (а): случаи редкие, потеря ограничена. *(Claude, 2026-11-01)*

## 10. Журнал реализации

Заполняет агент.

| Дата | Ветка / коммит | Что сделано | Отклонения от спеки |
|---|---|---|---|
