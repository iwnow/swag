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
> - **Нужно от человека:** ответы на Q-1…Q-7. Контракты написаны по рекомендациям. Главные развилки: Q-1 — откуда брать сумму закрытия роя; Q-2 — compute в 013 не считается; Q-3 — без наценки и в USD.

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
  - схемы баланса;
  - права `balance.read` и `balance.topup`;
  - поле `spentMicroUsd` в итоговых событиях роя;
  - `heldMicroUsd` в `LlmSwarmClosed`;
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
  - сборка `billing-core`;
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
- повторная доставка итоговых событий при сбое шины — спека надёжности шины (N-11).

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
| REQ-013-10 | Пополнение, отказ по балансу и закрытие резерва MUST логироваться структурно, с `orgId` и суммами, без токенов. | MUST |
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
  comment: z.string().trim().min(1).max(500).nullable().default(null), // супервизору обязателен (4.3)
});

export const BalanceView = z.strictObject({
  orgId: OrgId,
  balanceMicroUsd: MicroUsd, // сумма записей журнала
  heldMicroUsd: MicroUsd, // резервы роёв, которые ещё идут
  availableMicroUsd: MicroUsd, // balance − held
});

export const BalanceEntryKind = z.enum(['topup', 'swarm']);

export const BalanceEntry = z.strictObject({
  id: z.number().int().positive(), // порядковый номер записи, общий на все организации
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

`llm.ts`:

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
      or (kind = 'swarm' and amount_micro_usd <= 0 and swarm_id is not null and actor_id is null))
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

export interface BalanceStore {
  balance(orgId: string): Promise<{ balanceMicroUsd: number; heldMicroUsd: number }>; // нет строки — нули
  entries(orgId: string, before: number | null, limit: number): Promise<{ entries: BalanceEntry[]; hasMore: boolean }>;
  topup(input: { orgId: string; amountMicroUsd: number; actorId: string; comment: string | null; ts: Date }): Promise<BalanceEntry>;
  reserve(input: { orgId: string; swarmId: string; amountMicroUsd: number; ts: Date }): Promise<'ok' | 'insufficient'>;
  settle(swarmId: string, spentMicroUsd: number, ts: Date): Promise<{ orgId: string; heldMicroUsd: number; chargedMicroUsd: number } | null>;
  holds(): Promise<{ swarmId: string; orgId: string; amountMicroUsd: number }[]>;
}

export interface OrgDirectory {
  exists(orgId: string): Promise<boolean>; // ошибка связи — исключение
}

export interface BillingCoreDeps {
  store: BalanceStore;
  orgs: OrgDirectory;
  clock: Clock; // из @swag/contracts, как в api-core
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

`Clock` и `Logger` — те же типы, что берёт `api-core`. Ошибки — те же коды, что в `api-core`: `validation_error`, `forbidden`, `not_found`.

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
- `before` — целое ≥ 1 или отсутствует;
- другое значение → `validation_error`.

**`getBalance`:** `availableMicroUsd = balance − held`.

**`reserve`:** `amountMicroUsd` — бюджет роя. `insufficient` → лог `info` `balance_insufficient` (`orgId`, `swarmId`, `amountMicroUsd`).

**`settle`:**
- `store.settle`;
- результат не `null` → лог `info` `balance_settled` (`orgId`, `swarmId`, `heldMicroUsd`, `chargedMicroUsd`);
- `spentMicroUsd > heldMicroUsd` → дополнительно лог `error` `balance_overspent` с обеими суммами. Такого не бывает, пока бюджет роя в gateway равен резерву: списывается не больше резерва.

Ядро — чистый TypeScript: только `zod`, `@swag/contracts`, `@swag/helpers` (`arch:check`).

### 4.4. `api-core`

Порт:

```ts
export interface Billing {
  reserve(orgId: string, swarmId: string, amountMicroUsd: number): Promise<'ok' | 'insufficient'>;
  settle(swarmId: string, spentMicroUsd: number): Promise<void>;
  holds(): Promise<{ swarmId: string; orgId: string; amountMicroUsd: number }[]>;
}
// ApiCoreDeps: добавить billing: Billing.
```

**`createSwarm`.** Порядок:
1. Проверки 004, 024 и 031 — как сейчас.
2. Место под `MAX_ACTIVE_SWARMS`.
3. `billing.reserve(actor.orgId, swarmId, budgetMicroUsd)` — до записи `swarm.created`.
   - `insufficient` → `insufficient_balance` с сообщением `balance is not enough for budget`. Событий нет, место под `MAX_ACTIVE_SWARMS` освобождается.
   - Исключение → `internal_error`, событий нет.
4. Запись `swarm.created` и запуск — как сейчас.
   - Ошибка записи `swarm.created` → `billing.settle(swarmId, 0)`, затем та же ошибка, что сейчас.
   - Сбой запуска закрывает резерв через итоговое событие (правило ниже).

`actor.orgId` у создателя роя всегда есть: супервизор роёв не создаёт (024, Q-4).

**Итоговое событие.** После записи в хранилище любого `swarm.completed`, `swarm.stopped` или `swarm.failed` вызывается `billing.settle(swarmId, spent)`. Пути:
- `ingestEvent`;
- `swarm.failed` при сбое запуска;
- `closeInterrupted`.

`spent`:
- `data.spentMicroUsd`, если поле есть;
- иначе `SwarmView.spentMicroUsd` проекции после применения события, и лог `warn` `balance_settled_from_events` (`swarmId`).

Исключение `settle` → лог `error` `billing_settle_failed` (`swarmId`). Событие уже записано и отдаётся подписчикам: сбой закрытия не мешает потоку событий.

**Добор при старте.** Новая операция:

```ts
settlePending(): Promise<number>; // число закрытых резервов
```

Для каждого резерва из `billing.holds()`:
- рой в хранилище завершён (проекция в итоговом статусе) — `billing.settle(swarmId, spent)` по тому же правилу `spent`, что выше;
- роя нет в хранилище (сбой между резервом и записью `swarm.created`) — `billing.settle(swarmId, 0)`.

Рой ещё идёт — резерв не трогается. Оболочка вызывает операцию после `closeInterrupted`, до `listen`.

`STATUS` оболочки: `insufficient_balance: 402`, `org_directory_unavailable: 503`.

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

- `billing-core` собирается в `main.ts`:
  - `createPostgresBalanceStore(pool)`, а без `DATABASE_URL` — `createMemoryBalanceStore()`, по правилу выбора хранилища роёв из 003;
  - `OrgDirectory` — функция оболочки `apps/api/src/organizations.ts`:
    ```ts
    export function createOrgDirectory(options: { identityUrl: string; token: string; timeoutMs: number }): OrgDirectory;
    ```
    `fetch` `GET {IDENTITY_URL}/internal/organizations/:orgId` с `AbortSignal.timeout(timeoutMs)`: `204` → `true`, `404` → `false`, другое — исключение. `timeoutMs` — константа `IDENTITY_TIMEOUT_MS = 5000` в `main.ts`.
- `api-core.billing` — экземпляр `billing-core` (его `reserve`, `settle`, `holds`).
- Порядок старта: миграции → `closeInterrupted` → `settlePending` → `listen`.
- **Из N-25:**
  - `@swag/adapter-orchestrator-http` получает опцию `timeoutMs`, `launch` и `stop` идут с `AbortSignal.timeout(timeoutMs)`. Таймаут — та же ошибка, что недоступность оркестратора.
  - В `main.ts` — константа `ORCHESTRATOR_TIMEOUT_MS = 10000`, по образцу `GATEWAY_TIMEOUT_MS` оркестратора (D-99).

### 4.10. Конфиг

| Переменная | Сервис | По умолчанию | Описание |
|---|---|---|---|
| `BALANCE_MAX_TOPUP_MICRO_USD` | `api` | `100000000` ($100) | Предел одного пополнения; целое 1…1 000 000 000 |
| `LLM_GATEWAY_CLOSE_WAIT_MS` | `llm-gateway` | `5000` | Ожидание идущих вызовов при закрытии роя; целое 0…60 000 |

- Обе переменные — в `packages/config` (схемы сервисов), `.env.example`, `.env` и `compose.yaml`.
- `api` уже получает `IDENTITY_URL` и `IDENTITY_INTERNAL_TOKEN` (024).

### 4.11. Кабинет

Маршрут `/balance` за guard, пункт «Баланс» в навигации.

**Страница:**
- три числа: «Баланс», «В резерве», «Доступно» — формат денег `ui-core`, как в панели денег 004;
- история: дата, вид («Пополнение» или «Рой»), сумма со знаком, ссылка на рой, комментарий;
- кнопка «Ещё» грузит следующую страницу по `nextBefore`.

**Форма пополнения:**
- видна, только если у сессии роль `admin`: права роли — `ROLE_PERMISSIONS` из `@swag/contracts`, право `balance.topup`;
- поля: сумма в долларах с двумя знаками и комментарий;
- после успеха баланс и история перечитываются.

`orgId` — `organization.id` из сессии (`AuthSession`). Без организации (супервизор) пункта «Баланс» нет: экран супервизора — 014.

**Форма роя.** Ответ `402 insufficient_balance` показывается текстом «Недостаточно средств: доступно $X», где X — `availableMicroUsd` из `GET /organizations/:orgId/balance`, перечитанного после отказа.

Перевод долларов в µUSD и обратно — чистые функции в `packages/ui-core`:

```ts
export function usdToMicro(input: string): number | null; // "12.5" → 12500000; не число, ≤ 0 или больше двух знаков — null
```

Вывод — существующий формат денег `ui-core`.

## 5. Критерии приёмки

- **AC-013-1** — *Given* хранилище баланса (память и Postgres) *When* три пополнения 100, 200, 300 *Then* `balance` = 600, `held` = 0, в `entries` три записи `topup` от новых к старым.
- **AC-013-2** — *Given* администратор организации A *When* `POST /organizations/A/balance/topups` с 1 000 000 *Then* `201`, запись с `actorId` администратора, `GET …/balance` — `balanceMicroUsd: 1000000`.
- **AC-013-3** — *Given* `user` организации A *When* пополнение A *Then* `403 forbidden`. *Given* администратор A *When* пополнение B *Then* `404 not_found`.
- **AC-013-4** — *Given* супервизор *When* пополнение без комментария *Then* `400 validation_error`. *When* с комментарием для существующей организации *Then* `201`. *When* для организации, которой нет в identity *Then* `404`. *When* identity недоступна *Then* `503 org_directory_unavailable`.
- **AC-013-5** — *Given* администратор *When* сумма 0, дробная или больше `BALANCE_MAX_TOPUP_MICRO_USD` *Then* `400 validation_error`, баланс не изменился.
- **AC-013-6** — *Given* `user` и `admin` организации A и супервизор *When* `GET /organizations/A/balance` и `…/entries` *Then* `200` у всех троих. *Given* `user` организации B *Then* `404`. *Given* `orgId` не UUID *Then* `404`.
- **AC-013-7** — *Given* 120 записей *When* `entries` с `limit=50`, затем по `nextBefore` *Then* страницы 50, 50, 20, у последней `nextBefore: null`, порядок по убыванию `id` без пропусков и повторов. `limit=0`, `limit=101`, `before=abc` → `400`.
- **AC-013-8** — *Given* доступно 1 000 000 *When* `POST /swarms` с бюджетом 1 000 001 *Then* `402 insufficient_balance`, у роя нет событий, оркестратор не вызывался, место под `MAX_ACTIVE_SWARMS` свободно.
- **AC-013-9** — *Given* доступно 1 000 000 *When* `POST /swarms` с бюджетом 400 000 *Then* `201`, `held` = 400 000, `available` = 600 000.
- **AC-013-10** — *Given* Postgres и доступно 1 000 000 *When* 10 параллельных `reserve` по 300 000 *Then* успешно ровно 3, `held` = 900 000, баланс не изменился.
- **AC-013-11** — *Given* рой с резервом 400 000 *When* приходит `swarm.completed` с `spentMicroUsd: 123 456` *Then* в журнале запись `swarm` −123 456 с `swarmId`, `balance` уменьшился на 123 456, `held` уменьшился на 400 000.
- **AC-013-12** — *Given* резерв уже закрыт *When* то же итоговое событие приходит второй раз или `settle` вызывается снова *Then* записей и изменений баланса нет.
- **AC-013-13** — *Given* итоговое событие без `spentMicroUsd`, а у проекции роя `spentMicroUsd` 7 000 *When* `ingestEvent` *Then* закрытие на 7 000 и лог `balance_settled_from_events`.
- **AC-013-14** — *Given* оркестратор недоступен *When* `POST /swarms` *Then* `swarm.failed` `orchestrator_unavailable`, резерв закрыт на 0, `available` вернулся к прежнему.
- **AC-013-15** — *Given* ошибка записи `swarm.created` после резерва *When* `createSwarm` *Then* резерв закрыт на 0, ответ — прежняя ошибка.
- **AC-013-16** — *Given* три резерва: рой завершён (проекция `spentMicroUsd` 5 000), рой ещё идёт, роя нет в хранилище *When* `settlePending` *Then* закрыты первый (5 000) и третий (0), второй остался, результат — 2.
- **AC-013-17** — *Given* `settle` бросает исключение *When* `ingestEvent` итогового события *Then* событие записано и отдано подписчикам, лог `billing_settle_failed`.
- **AC-013-18** — *Given* gateway с резервом идущего вызова *When* `closeSwarm`, а списание вызова приходит через 300 мс *Then* ответ после списания, `heldMicroUsd: 0`, `spentMicroUsd` включает вызов. *Given* списание не пришло за `closeWaitMs` *Then* ответ с `heldMicroUsd > 0` и лог `close_holds_pending`. Часы и `sleep` — тестовые.
- **AC-013-19** — *Given* `LlmSwarms.close` вернул 4 200 *When* `finish` *Then* в `data` итогового события `spentMicroUsd: 4200`. *Given* `close` бросил исключение *Then* поля нет, рой завершён.
- **AC-013-20** — *Given* identity *When* `GET /internal/organizations/:id` с верным токеном для существующей, несуществующей и не UUID организации, и без токена *Then* `204`, `404`, `404`, `401`.
- **AC-013-21** — *Given* `adapter-orchestrator-http` с `timeoutMs: 100` и оркестратор, который не отвечает *When* `launch` *Then* ошибка не позже чем через 1 с.
- **AC-013-22** — *Given* права ролей *Then* `user` — `balance.read` без `balance.topup`; `admin` и `supervisor` — оба права.
- **AC-013-23** — *Given* `usdToMicro` *Then* `"12.5"` → 12 500 000, `"0.01"` → 10 000, `"0"`, `"-1"`, `"1.234"`, `"abc"` → `null`.
- **AC-013-24** `[stack]` — *Given* поднятый контур *When*:
  1. администратор новой организации пополняет баланс на $1;
  2. запускает рой с бюджетом $0.50;
  3. второй рой с бюджетом $0.60;
  4. рой завершается.

  *Then*:
  - второй рой — `402`;
  - после первого `held` = $0.50;
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
| NFR-013-1 | Резерв добавляет к `POST /swarms` не больше 5 мс на p95 при последовательных запросах | бенчмарк `apps/api/test/bench.test.ts` (`API_BENCH=1`) с Postgres: прирост p95 к замеру без `billing` |
| NFR-013-2 | Закрытие роя в gateway без идущих вызовов не дольше прежнего более чем на 5 мс | тест ядра с тестовыми часами: при `heldMicroUsd = 0` нет ни одного `sleep` |

## 7. Безопасность: что не должно сломаться

- Организация не видит и не пополняет чужой баланс → AC-013-3, AC-013-6.
- `user` не пополняет → AC-013-3, AC-013-22.
- Баланс не уходит в минус при параллельных запусках → AC-013-10, ограничения `check` в 4.2.
- Повторное событие не списывает дважды → AC-013-12.
- Внутренний маршрут identity без токена закрыт → AC-013-20.
- Сбой проверки организации не открывает пополнение (fail closed) → AC-013-4.
- В логах баланса нет токенов: поля логов перечислены в 4.3 → ревью этапа.
- Из кода агента баланс не меняется: маршруты баланса — только в `api` с токеном пользователя, у агента его нет (024).

## 8. Задачи для агента

Выполняются по порядку. После каждой задачи — коммит.

**Группа** `spec/013-billing` (T-7…T-9): T-7 добавляет обязательную зависимость `billing` в `ApiCoreDeps`, и сборка `apps/api` ломается до T-9.

- [ ] **T-1.** `@swag/contracts`:
  - файл `billing.ts`;
  - права и `ROLE_PERMISSIONS`;
  - `spentMicroUsd` в итоговых событиях;
  - `heldMicroUsd` в `LlmSwarmClosed`.

  Тесты схем: границы `TopupMicroUsd`, `comment` по умолчанию `null`, старые события без `spentMicroUsd` разбираются. Глоссарий. Закрывает: AC-013-22. Готово, когда: тесты `packages/contracts` и `npm run typecheck` зелёные. Места, где `LlmSwarmClosed` строится без `heldMicroUsd`, временно получают `heldMicroUsd: 0` с комментарием «013, T-5».
- [ ] **T-2.** Новый пакет `packages/billing-core`:
  - `package.json`, `tsconfig.json`, ссылка в корневом `tsconfig.json`, README;
  - строка в `docs/architecture.md`, раздел «Пакеты»;
  - интерфейсы и `createBillingCore` по 4.3;
  - тесты на фейковом хранилище в памяти внутри теста.

  Закрывает: REQ-013-2, REQ-013-3, REQ-013-10; AC-013-3…AC-013-7 на уровне ядра. Готово, когда: тесты пакета и `arch:check` зелёные.
- [ ] **T-3.** `adapter-memory`: `createMemoryBalanceStore()` по 4.2: та же семантика, атомарность — синхронный код без `await` между проверкой и записью. Тесты. Закрывает: AC-013-1, AC-013-11 и AC-013-12 на хранилище. Готово, когда: тесты пакета зелёные.
- [ ] **T-4.** `adapter-postgres`: миграция `0005_billing.sql`, `createPostgresBalanceStore(pool)` с SQL из 4.2, тесты с `POSTGRES_TEST_URL`. Закрывает: AC-013-1, AC-013-10, AC-013-11, AC-013-12. Готово, когда: тесты пакета с `.env` зелёные.
- [ ] **T-5.** `llm-gateway-core`, `adapter-postgres` (`BudgetStore.close` и `totals`), `adapter-memory` (если там есть `BudgetStore`), `apps/llm-gateway` (`sleep`, `LLM_GATEWAY_CLOSE_WAIT_MS` в config, `.env.example`, `.env`, `compose.yaml`): ожидание по 4.7. Убрать временный `heldMicroUsd: 0` из T-1. Закрывает: REQ-013-9, AC-013-18, NFR-013-2. Готово, когда: тесты gateway зелёные.
- [ ] **T-6.** `orchestrator-core` и `adapter-gateway-http`: `close` возвращает сумму, `spentMicroUsd` в итоговом событии по 4.6. Закрывает: AC-013-19. Готово, когда: тесты пакетов зелёные.
- [ ] **T-7.** `api-core`:
  - порт `Billing`;
  - резерв в `createSwarm`;
  - закрытие на итоговом событии по всем трём путям;
  - `settlePending` по 4.4.

  Тесты с фейковым `Billing`. Закрывает: REQ-013-4, REQ-013-6, REQ-013-8; AC-013-8, AC-013-13…AC-013-17. Готово, когда: тесты `packages/api-core` зелёные (сборка `apps/api` красная до T-9).
- [ ] **T-8.** `identity-core`, `adapter-postgres`, `adapter-memory`, `apps/identity`:
  - `findOrganizationById`;
  - `organizationExists`;
  - маршрут 4.8.

  Закрывает: AC-013-20. Готово, когда: тесты identity зелёные.
- [ ] **T-9.** `apps/api` по 4.5, 4.9 и 4.10:
  - маршруты баланса, `STATUS`, `organizations.ts`;
  - сборка `billing-core`, порядок старта;
  - `BALANCE_MAX_TOPUP_MICRO_USD` в config, `.env.example`, `.env`, `compose.yaml`;
  - `adapter-orchestrator-http` `timeoutMs` (из N-25).

  HTTP-тесты на `inject`. Закрывает: REQ-013-12; AC-013-2…AC-013-9, AC-013-14, AC-013-21 на HTTP. Готово, когда: `npm run check` зелёный, группа влита в `main`.
- [ ] **T-10.** `ui-core` (`usdToMicro`) и `cabinet` по 4.11. Тесты `ui-core`. Закрывает: REQ-013-11, AC-013-23. Готово, когда: `npm run check` зелёный.
- [ ] **T-11.** Стек-тест `apps/api/test/stack.test.ts`, новый `it` для AC-013-24: сумма ledger роя читается из Postgres по `DATABASE_URL` теста. Бенчмарк NFR-013-1 в `bench.test.ts`. Закрывает: AC-013-24, NFR-013-1. Готово, когда: стек-тест зелёный на поднятом контуре.
- [ ] **T-12.** Ручная проверка AC-013-25, журнал, README затронутых пакетов, глоссарий. Закрывает: AC-013-25. Готово, когда: результат в журнале.

## 9. Открытые вопросы

Пока список не пуст, спека не может быть `ready`. Контракты разделов 4–5 написаны по рекомендациям; другой ответ меняет их.

- [ ] **Q-1. Сумма закрытия роя.** Траты роя знают двое: ledger gateway (точно) и проекция `api` (сумма `charge` из `llm.call`, теряется при потере события). Варианты:
  - **(а)** gateway при закрытии роя ждёт идущие вызовы (`LLM_GATEWAY_CLOSE_WAIT_MS`), оркестратор кладёт `spentMicroUsd` из ответа в итоговое событие, `api` закрывает резерв этой суммой; без поля — по проекции с `warn`;
  - **(б)** `api` читает `sum(ledger_entries)` роя прямо из общей базы: точно и без правки gateway, но `api` читает таблицу чужого сервиса, а поздние списания после чтения теряются так же;
  - **(в)** только проекция: проще всего, но «ровно по ledger» держится только пока не теряются события.

  Рекомендация — (а): владелец ledger сам отдаёт сумму, ожидание закрывает гонку «песочница убита, списание ещё пишется». *(Claude, 2026-11-01)*
- [ ] **Q-2. Compute в 013** (из 004, «Не входит»: «стоимость compute — 013»). Секунды песочницы × тариф требуют замера времени песочниц, тарифа и записи ledger `kind = 'compute'`. Варианты:
  - **(а)** не в 013, а в 005 (песочницы, пул и лимиты): там появится, что мерить;
  - **(б)** в 013: время от `agent.started` до `agent.stopped` × `COMPUTE_PRICE_MICRO_USD_PER_SEC`.

  Рекомендация — (а): сейчас песочница одна на агента без лимитов, тариф пришлось бы выдумать; поле `kind` и запись `swarm` позволят добавить compute без миграции смысла. *(Claude, 2026-11-01)*
- [ ] **Q-3. Цена для пользователя и валюта** (из D-8). Списывать себестоимость или с наценкой? Баланс в USD или рублях? Минимальный бюджет роя?

  Рекомендация:
  - без наценки: списывается `charge` из 004;
  - баланс в USD (micro-USD, как ledger);
  - минимальный бюджет — прежний `BudgetMicroUsd` ≥ 1.

  Наценка и рубли — вместе с тарифами D-36, когда появится реальная оплата: до неё деньги виртуальные. *(Claude, 2026-11-01)*
- [ ] **Q-4. Чей баланс и кто пополняет** (из D-10, часть «деньги»). Варианты:
  - **(а)** баланс организации; пополняют администратор (своей) и супервизор (любой, с комментарием);
  - **(б)** баланс на пользователя.

  Рекомендация — (а), как в роадмапе раздел 8. Распределение бюджета между пользователями — отдельной спекой, если понадобится. *(Claude, 2026-11-01)*
- [ ] **Q-5. Подписка и счёт платформы в 013** (из D-36 и D-38: «куда — 013 и 025»). Рекомендация:
  - в 013 их нет;
  - D-36 остаётся до реальной оплаты (после MVP);
  - D-38 остаётся для 025 и 014.

  Из D-38 в 013 действует одно правило: виртуальное пополнение — не поступление платформы. Записи `topup` при появлении счёта платформы туда не попадут. *(Claude, 2026-11-01)*
- [ ] **Q-6. Кто видит баланс.** Варианты:
  - **(а)** `user` видит баланс и историю своей организации, включая рои коллег (только сумма и `swarmId`, сам рой ему — `404`);
  - **(б)** `user` видит только три числа, история — администратору;
  - **(в)** `user` баланса не видит.

  Рекомендация — (а): пользователю нужно знать доступный остаток до запуска, а сумма роя коллеги не раскрывает его содержимого. *(Claude, 2026-11-01)*
- [ ] **Q-7. Пределы.** Предел одного виртуального пополнения `BALANCE_MAX_TOPUP_MICRO_USD` — рекомендация $100: деньги виртуальные, предел защищает от опечатки в лишние нули. Общего предела баланса нет. `LLM_GATEWAY_CLOSE_WAIT_MS` — рекомендация 5000: вызов, оборванный уборкой песочницы, списывается за миллисекунды, 5 с — с запасом и не держат завершение роя заметно. *(Claude, 2026-11-01)*

## 10. Журнал реализации

Заполняет агент.

| Дата | Ветка / коммит | Что сделано | Отклонения от спеки |
|---|---|---|---|
