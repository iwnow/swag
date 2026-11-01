---
id: "014"
title: "UI: каркас с регистрацией и входом, микрофронтенды кабинета, админки и супервизора"
status: in-progress
roadmap_stage: 5
depends_on: ["012", "024", "013"]
superseded_by: null
updated: 2026-11-01
---

# 014. UI: каркас с регистрацией и входом, микрофронтенды кабинета, админки и супервизора

> **Коротко.**
> - **Каркас `apps/ui/shell`.** Регистрация компании проходит в браузере: email → письмо → пароль и название → кабинет. Приглашённый задаёт пароль по ссылке из письма. Вход, выход и навигация — в каркасе. Каркас подгружает микрофронтенды по правам из `GET /auth/me`.
> - **Три микрофронтенда.**
>   - `cabinet` — нынешние рои и баланс без своей страницы входа.
>   - `admin` — пользователи организации: приглашение, смена роли, блокировка.
>   - `supervisor` — организации платформы, их пользователи, баланс и пополнение.
> - **Вся логика UI — в сторах `ui-core`** (Q-9, решение человека 2026-11-01). Состояние, загрузка данных, вычисления, ограничения и сценарии («создать рой», «пригласить пользователя», «пополнить баланс») живут в сторах `ui-core` на чистом TS (`@preact/signals-core`). В Angular их подключает мост `connectStore` из `@swag/ui-angular`. `SessionUserStore` — один на страницу, плюс по одному стору на фронтенд: `ShellStore`, `CabinetStore`, `AdminStore`, `SupervisorStore`. Компоненты — только шаблоны: читают сигналы стора и вызывают его команды. Контракты — 4.12, задачи T-21…T-25.
> - **Права в интерфейсе** считает `ui-core`. Код микрофронтенда без прав не загружается. Доступ, как и раньше, проверяет API.
> - **Нового API нет.** Экраны работают на эндпоинтах 012, 024 и 013. Меняются только адреса страниц в письмах: `/signup/confirm` и `/invite` вместо `/auth/confirm` и `/auth/invite`. Причина — путь `/auth/*` прокси отдаёт в identity.
> - **Общий стиль.** Одни дизайн-токены и базовые компоненты, светлая и тёмная тема. Контраст проверяет автотест.
> - **Первая задача — проверка федерации на Angular 22** (T-1). Если Native Federation ведёт себя не как в 4.4–4.5, спека блокируется до реализации экранов.
> - **Вопросы раздела 9 решены человеком 2026-11-01 по рекомендациям:**
>   - сборка микрофронтендов (Q-1, из D-11);
>   - общий фронтендовый код (Q-2, из D-11);
>   - дизайн-система и скилл дизайна (Q-3, из D-16);
>   - Grafana (Q-4, из D-15);
>   - порядок со спекой мультиорганизаций (Q-5, D-131);
>   - рои и расходы по пользователям (Q-6);
>   - счёт платформы (Q-7, из D-38);
>   - порог бандла (Q-8).
>
>   Разделы 4–8 написаны под эти решения.

## 1. Контекст и цель

Закрывает пункт «UI: каркас с регистрацией и входом, микрофронтенды — кабинет, админка организации, супервизор» этапа 5 [роадмапа](../../AI_PLATFORM_ROADMAP.md#8-пользователи-доступ-и-баланс), раздел «Фронтенды».

**Сейчас.**
- Есть один фронтенд — `apps/ui/cabinet`, самостоятельное приложение: вход, рои, баланс.
- Регистрацию, подтверждение email и приглашение можно пройти только через `curl` и Mailpit: ссылки в письмах ведут на несуществующие страницы.
- Пользователями и организациями управляют только через API.

**Цель.**
- Каркас с регистрацией, подтверждением, приглашением, входом и навигацией.
- Три микрофронтенда, которые собираются и запускаются независимо. Каркас подгружает их во время работы по правам из `GET /auth/me`.
- Сценарий S-1 проходится в браузере.

## 2. Объём

**Входит:**
- `apps/ui/shell`:
  - страницы `/login`, `/signup`, `/signup/confirm`, `/invite`;
  - шапка с навигацией, темой и выходом;
  - загрузка микрофронтендов по манифесту и правам.
- `apps/ui/cabinet` становится микрофронтендом. Экраны роёв и баланса работают как раньше. Вход, шапка и глобальные стили уходят в каркас и общий пакет.
- `apps/ui/admin`: пользователи своей организации, приглашение с ролью, смена роли `user` ↔ `admin`, блокировка и разблокировка.
- `apps/ui/supervisor`: список организаций и страница организации — её пользователи с блокировкой, её баланс, история и пополнение.
- `ui-core`:
  - регистрация, подтверждение и приглашение в сессии;
  - тексты ошибок, проверки форм;
  - доступ к разделам и навигация по `AuthMe`;
  - действия над пользователем;
  - проверки адресов `returnTo` и remote;
  - порты пользователей и организаций;
  - сторы на `@preact/signals-core` и их порты (4.12, Q-9).
- `packages/ui-angular` (Q-2):
  - адаптеры портов на `fetch`, мост сторов в Angular-сигналы `connectStore` и провайдеры сторов (4.12);
  - guard'ы поверх `SessionUserStore`;
  - панель баланса без своего состояния (4.12);
  - дизайн-токены, базовые стили, базовые компоненты.
- Перевод цветов графа роя и стилей кабинета на токены — только чтобы граф работал в тёмной теме.
- Compose: каркас на `UI_PORT`, микрофронтенды без опубликованных портов, за прокси каркаса.
- Новые адреса `IDENTITY_CONFIRM_URL` и `IDENTITY_INVITE_URL`.
- Запуск UI на хосте с горячей перезагрузкой (из N-6).
- Ручной прогон S-1 в браузере.

**Не входит** (агент это не делает, даже если кажется логичным):
- **Несколько организаций у пользователя**, переключатель и создание второй организации — спека по D-131 (Q-5). В 014 организация одна: `AuthMe.organization`.
- **Новые эндпоинты и поля API.** Сюда же — рои и расходы по пользователям, `createdBy` и траты в списке роёв (Q-6).
- **Приглашения от супервизора.** `POST /auth/invitations` разрешён только `admin` (024, 4.8), поэтому на странице организации у супервизора формы приглашения нет.
- **Счёт платформы** (Q-7, D-38) — спека 025.
- **Восстановление и смена пароля** (D-112), профиль пользователя.
- **Вход через Google и SSO.** Лендинг.
- **Продакшен-сборка и деплой фронтендов**: статика за nginx, CDN, манифест на окружение. В 014 — только dev-серверы, как в 001.
- **Вход в Grafana и её роли** (Q-4) — спека эксплуатации.
- **Журнал ошибок у супервизора** (D-88).
- **Новый вид графа роя и экранов роя.** Раскладка, формы и поведение прежние. Графом займётся визуальный редактор (017). В 014 — только цвета на токенах и общие компоненты.
- **Браузерные e2e-автотесты** (Playwright и т. п.). Экраны проверяются вручную (`[manual]`), логика — тестами `ui-core` и `scripts/`.
- **Локализация.** Интерфейс только на русском.

## 3. Требования

| ID | Требование | Приоритет |
|---|---|---|
| REQ-014-1 | Каркас `apps/ui/shell` (`@swag/shell`) MUST быть отдельным фронтендом и npm-workspace. Он отдаёт страницы 4.11 и шапку, а остальные экраны подгружает из микрофронтендов. | MUST |
| REQ-014-2 | Микрофронтенды `cabinet`, `admin`, `supervisor` MUST собираться и запускаться независимо: свой workspace, свой dev-сервер, свой сервис compose. Исходники каркаса MUST не импортировать исходники микрофронтендов. Адреса remote каркас берёт только из манифеста 4.4. | MUST |
| REQ-014-3 | Каркас MUST запрашивать `remoteEntry.json` и код микрофронтенда только при входе в его раздел и только когда `canOpen` (4.2) разрешает раздел текущему `AuthMe`. Раздел без прав MUST не давать ни одного запроса под `/mf/<имя>/`. | MUST |
| REQ-014-4 | Навигация, доступ к разделам и видимость форм MUST вычисляться из `GET /auth/me` (`AuthMe`), а не из claims токена (D-130). `AuthMe` перечитывается при смене токена доступа и сбрасывается при выходе, как в 013. | MUST |
| REQ-014-5 | Без сессии MUST открываться только `/login`, `/signup`, `/signup/confirm`, `/invite`. Любой другой адрес ведёт на `/login?returnTo=<исходный путь с query>`, после входа открывается `safeReturnTo(returnTo)` (4.2). | MUST |
| REQ-014-6 | `/signup` MUST отправлять email в `POST /auth/registrations` и на `202` показывать одно сообщение 4.6, есть такой email или нет. Ошибки — тексты 4.6. При открытой сессии `/signup` ведёт на `/`. | MUST |
| REQ-014-7 | `/signup/confirm?token=` MUST принимать пароль, повтор и название организации, проверять их `validateConfirmForm` (4.2) до запроса и вызывать `confirmRegistration`. На успех — сессия как после входа и переход на `/`. | MUST |
| REQ-014-8 | `/invite?token=` MUST принимать пароль и повтор, проверять `validateInviteForm` и вызывать `acceptInvitation`. На успех — как в REQ-014-7. | MUST |
| REQ-014-9 | Страницы `/signup/confirm` и `/invite` MUST соблюдать три правила. Токен убирается из адреса сразу после чтения: `Location.replaceState` без query. В каркасе стоит `<meta name="referrer" content="no-referrer">`. Токен не пишется в консоль и лог. При открытой сессии страница показывает «Вы вошли как <email>» и кнопку «Выйти и продолжить», форма появляется только после выхода. На `invalid_token` — текст 4.6. | MUST |
| REQ-014-10 | Шапка каркаса MUST показывать пункты `navigationFor(me)` в порядке 4.2, email, название организации (если есть), переключатель темы и кнопку «Выйти». Выход вызывает `logout`, сбрасывает `AuthMe` и открывает `/login`. | MUST |
| REQ-014-11 | Микрофронтенд `cabinet` MUST сохранить адреса и поведение экранов 001, 004, 013, 022, 030, 031: `/`, `/swarms/new`, `/swarms/:id`, `/balance`. Своей страницы входа и шапки у него MUST не быть. | MUST |
| REQ-014-12 | `admin`, страница `/admin/users`, MUST показывать пользователей из `GET /auth/users`: email, роль, «заблокирован», дату создания. На странице MUST быть форма приглашения — email и роль `user` или `admin`, отправка в `POST /auth/invitations`. В строке пользователя — ровно действия `userActions` (4.2), блокировка — с подтверждением. После успешного действия список перечитывается. | MUST |
| REQ-014-13 | `supervisor` MUST показывать две страницы. `/supervisor` — организации из `GET /auth/organizations`: название, число пользователей, дата создания. `/supervisor/organizations/:orgId`: — название из того же списка; — пользователи из `GET /auth/users?orgId=` с действиями `userActions`; — панель баланса 4.7 этой организации с обязательным комментарием пополнения. Организации нет в списке — текст `not_found`. | MUST |
| REQ-014-14 | Во всех фронтендах `401` от API MUST вести к одному `renew()` и одному повтору, а неудача — к выходу на `/login`, как в 024, 4.15. На `403` экран MUST показывать текст `forbidden` (4.6) и оставаться в сессии. | MUST |
| REQ-014-15 | `AuthSessionKeeper`, `CurrentUser` и токен доступа MUST существовать в одном экземпляре на каркас и все загруженные микрофронтенды: один `refresh` на одновременные `401` из любых разделов. Токен MUST не попадать в `localStorage`, `sessionStorage`, доступные скрипту cookie и адреса. | MUST |
| REQ-014-16 | Все фронтенды MUST брать цвета, шрифты, отступы и радиусы из дизайн-токенов 4.8 (CSS custom properties). Тема светлая или тёмная по `prefers-color-scheme`. Переключатель в шапке: «как в системе», «светлая», «тёмная», выбор хранится в `localStorage` под ключом `swag.theme`. В CSS и шаблонах фронтендов MUST не быть цветовых литералов вне `tokens.css`. | MUST |
| REQ-014-17 | Кнопки, поля с ошибкой, таблицы, сообщения и диалоги во всех фронтендах MUST строиться из базовых компонентов 4.8. | MUST |
| REQ-014-18 | Ссылку «трейс» в ленте роя MUST видеть только супервизор (Q-4). Прокси `/grafana` в dev остаётся. | MUST |
| REQ-014-19 | В `.env.example` и `.env` MUST быть `IDENTITY_CONFIRM_URL=http://127.0.0.1:4200/signup/confirm` и `IDENTITY_INVITE_URL=http://127.0.0.1:4200/invite`. Порт совпадает с `UI_PORT` того же файла. | MUST |
| REQ-014-20 | `npm run ui:dev` MUST запускать каркас и три микрофронтенда на хосте с горячей перезагрузкой. Прокси ведут на опубликованные порты контура на `127.0.0.1`. Остальной контур поднимается `npm run up` (из N-6). | MUST |
| REQ-014-21 | Пары «текст — фон» из 4.8 MUST иметь контраст не ниже 4.5:1 (WCAG 2.2 AA) в обеих темах. | MUST |
| REQ-014-23 | Состояние, загрузка данных, вычисления, ограничения и сценарии фронтендов MUST жить в сторах `ui-core` (4.12). Компоненты и страницы `apps/ui/*` и `packages/ui-angular` MUST только читать сигналы стора и вызывать его методы: без запросов к API, без адаптеров портов и без бизнес-правил в компонентах. Компоненту остаются ввод формы до отправки, навигация роутера по результату команды и работа с DOM. | MUST |
| REQ-014-24 | У каждого фронтенда MUST быть ровно один свой стор: `ShellStore`, `CabinetStore`, `AdminStore`, `SupervisorStore`. Сессионный пользователь и токен MUST храниться только в `SessionUserStore`, одном на каркас и все загруженные remote; сторы фронтендов берут пользователя из него. В REQ-014-15 `CurrentUser` читается как `SessionUserStore`. | MUST |
| REQ-014-25 | Код `packages/ui-core/src` MUST импортировать из внешних пакетов только `zod`, `@swag/contracts`, `@swag/api-integration`, `@preact/signals-core` (без подпутей). Любые `@angular/*`, `rxjs`, DOM и Web API (`window`, `document`, `localStorage`, `fetch`, `EventSource`) в нём MUST не встречаться. | MUST |
| REQ-014-22 | Интерактивные элементы базовых компонентов SHOULD быть доступны с клавиатуры, иметь видимый фокус, подписи (`label`, `aria-*`) и закрывать диалог по Esc. | SHOULD |

## 4. Контракты

4.3–4.5 написаны под рекомендацию Q-1 (Native Federation), 4.7 — под Q-2 (`@swag/ui-angular`), 4.8 — под Q-3. Схему 4.4–4.5 подтверждает задача T-1 до остальных.

### 4.1. `@swag/ui-core`: сессия — регистрация и приглашение

Порт `AuthApi` из 024, 4.15 дополняется. Адаптер — в 4.7.

```ts
import type { AuthSession, InvitationAcceptRequest, RegistrationConfirmRequest } from '@swag/contracts';

export interface AuthApi {
  // как в 024, 4.15: login, refresh, logout
  register(email: string): Promise<void>;                                      // POST /auth/registrations, 202
  confirmRegistration(body: RegistrationConfirmRequest): Promise<AuthSession>; // POST /auth/registrations/confirm, 201
  acceptInvitation(body: InvitationAcceptRequest): Promise<AuthSession>;       // POST /auth/invitations/accept, 201
}

export type AuthResult = { ok: true } | { ok: false; code: string };

export interface AuthSessionKeeper {
  // как в 024, 4.15: restore, logout, accessToken, renew, onSignedOut; login возвращает AuthResult (та же форма)
  register(email: string): Promise<AuthResult>;
  confirmRegistration(body: RegistrationConfirmRequest): Promise<AuthResult>;
  acceptInvitation(body: InvitationAcceptRequest): Promise<AuthResult>;
}
```

Правила:
- `confirmRegistration` и `acceptInvitation` устроены как `login`: в начале вызова `bumpEpoch()`, при успехе — токен из ответа.
- `register` не трогает ни токен, ни поколение.
- Код ошибки — `error.code` отказа, иначе `'unknown'`, как у `login`.

### 4.2. `@swag/ui-core`: доступ, навигация, проверки

Файл `src/access-ui.ts`, реэкспорт из `src/index.ts`. Чистые функции. Права — `ROLE_PERMISSIONS` и `can` из `@swag/contracts`.

```ts
import { z } from 'zod';
import type { AuthMe, ManagedUser, UserUpdate } from '@swag/contracts';

export const UiArea = z.enum(['swarms', 'balance', 'admin', 'supervisor']);
export type UiArea = z.infer<typeof UiArea>;
export type NavItem = { area: UiArea; label: string; path: string };

export function canOpen(area: UiArea, me: AuthMe | null): boolean;
export function navigationFor(me: AuthMe | null): NavItem[]; // порядок таблицы, только canOpen = true

export type UserAction = 'make_admin' | 'make_user' | 'block' | 'unblock';
export function userActions(me: AuthMe, target: ManagedUser): UserAction[]; // порядок перечисления
export function userActionBody(action: UserAction): UserUpdate;

export function safeReturnTo(value: string | null): string;
export function isLocalRemoteUrl(url: string): boolean;
```

| `area` | `label` | `path` | `canOpen` — `true`, когда |
|---|---|---|---|
| `swarms` | Рои | `/` | есть `swarm.read` |
| `balance` | Баланс | `/balance` | есть `balance.read` и `me.organization !== null` |
| `admin` | Админка | `/admin/users` | есть `user.manage` и `me.user.role = 'admin'` |
| `supervisor` | Организации | `/supervisor` | есть `organization.read` |

При `me = null` `canOpen` всегда `false`, а `navigationFor` возвращает `[]`.

**`userActions(me, target)`** зеркалит `PATCH /auth/users/:id` (024, 4.7). Решает по-прежнему identity.
- Пустой список, если выполнено любое из условий:
  - `target.id = me.user.id`;
  - `target.role = 'supervisor'`;
  - у роли `me` нет `user.manage`;
  - `me` — `admin`, а `target.orgId !== me.organization?.id`.
- Иначе по порядку:
  - `make_admin`, если `target.role = 'user'`;
  - `make_user`, если `target.role = 'admin'`;
  - `block`, если `!target.blocked`;
  - `unblock`, если `target.blocked`.

**`userActionBody`**: `make_admin` → `{ role: 'admin' }`, `make_user` → `{ role: 'user' }`, `block` → `{ blocked: true }`, `unblock` → `{ blocked: false }`.

**`safeReturnTo(value)`** возвращает `value`, только если выполнены все условия:
- строка начинается ровно с одного `/`;
- нет `//`, `\`;
- нет символов с кодом меньше `0x20` и `0x7f`.

Иначе — `/`. Переход — `router.navigateByUrl`.

**`isLocalRemoteUrl(url)`** — `true`, только если выполнены все условия:
- `url` начинается с `/mf/`;
- нет `//`, `\`, `%`, сегментов `.` и `..`;
- заканчивается на `/remoteEntry.json`.

**Формы.** Файл `src/auth-forms.ts`.

```ts
// FormIssue — существующий тип ui-core из 001: { path: string; message: string }
export function validateEmailForm(input: { email: string }): { ok: true; email: string } | { ok: false; issues: FormIssue[] };
export function validateConfirmForm(input: { token: string; password: string; repeat: string; organizationName: string }):
  { ok: true; body: RegistrationConfirmRequest } | { ok: false; issues: FormIssue[] };
export function validateInviteForm(input: { token: string; password: string; repeat: string }):
  { ok: true; body: InvitationAcceptRequest } | { ok: false; issues: FormIssue[] };
```

- Тело проверяется схемой `RegistrationConfirmRequest` или `InvitationAcceptRequest`.
- `path` — первый элемент пути ошибки Zod, `message` — текст 4.6 для поля. Ошибка в `token` (пустой или длиннее 200) даёт `{ path: 'token', message: <текст invalid_token> }`.
- `repeat !== password` даёт дополнительную ошибку `{ path: 'repeat', message: 'Пароли не совпадают.' }`.
- Ошибки идут в порядке полей: `token`, `password`, `repeat`, `organizationName`.
- `validateEmailForm` проверяет схемой `Email` из `@swag/contracts`, ошибка — `{ path: 'email', message: 'Введите email.' }`. Её вызывает `/signup` до запроса.

### 4.3. `@swag/ui-core`: порты пользователей и организаций

```ts
import type { InvitationRequest, ManagedUser, OrganizationList, UserList, UserUpdate } from '@swag/contracts';

export interface UsersApi {
  list(orgId: string | null): Promise<UserList>;              // GET /auth/users[?orgId=]
  invite(body: InvitationRequest): Promise<void>;             // POST /auth/invitations, 202
  update(id: string, body: UserUpdate): Promise<ManagedUser>; // PATCH /auth/users/:id
}
export interface OrganizationsApi {
  list(): Promise<OrganizationList>;                          // GET /auth/organizations
}
```

Отказ — reject с `HttpError` (4.7). Повтор после `401` делает адаптер.

### 4.4. Манифест и загрузка микрофронтендов

Файл `apps/ui/shell/public/federation.manifest.json` — имя remote → адрес `remoteEntry.json`. Запись появляется в той задаче, которая создаёт remote (T-11, T-15, T-16).

```json
{
  "cabinet": "/mf/cabinet/remoteEntry.json",
  "admin": "/mf/admin/remoteEntry.json",
  "supervisor": "/mf/supervisor/remoteEntry.json"
}
```

**Загрузка.**
- `main.ts` каркаса вызывает `initFederation({})` — без remote: на старте не запрашивается ни один `remoteEntry.json`.
- Затем каркас сам читает манифест через `fetch('/federation.manifest.json')`.
- Записи с `isLocalRemoteUrl(url) = false` отбрасываются, в консоль — `console.warn('remote_rejected', name)`.
- Остальные записи сервис `RemoteRegistry` (каркас) отдаёт по имени.
- Remote загружается только в `loadChildren`: `loadRemoteModule({ remoteEntry: registry.url(name), exposedModule: './routes' })`. Имени нет в реестре — ошибка загрузки маршрута, каркас показывает `swag-alert` «Раздел недоступен».

**Маршруты каркаса** (`app.routes.ts`):

```ts
[
  { path: 'login', component: LoginPage },
  { path: 'signup', component: SignupPage },
  { path: 'signup/confirm', component: ConfirmPage },
  { path: 'invite', component: InvitePage },
  {
    path: '',
    canMatch: [sessionGuard],
    component: Layout,
    children: [
      { path: 'admin', canMatch: [areaGuard('admin')], loadChildren: () => loadRoutes('admin') },
      { path: 'supervisor', canMatch: [areaGuard('supervisor')], loadChildren: () => loadRoutes('supervisor') },
      { path: '', loadChildren: () => loadRoutes('cabinet') },
    ],
  },
  { path: '**', redirectTo: '' },
]
```

**Guard'ы** — 4.7.
- `canMatch` срабатывает до `loadChildren`. Если guard вернул `UrlTree`, Angular не загружает remote (REQ-014-3).
- `sessionGuard` стоит на родителе и проверяется раньше дочерних guard'ов.

**Маршруты remote** (экспорт `./routes`):

| Remote | Префикс | Маршруты | Guard внутри remote |
|---|---|---|---|
| `cabinet` | `''` | `''`, `swarms/new`, `swarms/:id` | `areaGuard('swarms')` на каждом |
| | | `balance` | `areaGuard('balance')` |
| `admin` | `admin` | `users`; `''` → `users` | — (стоит в каркасе) |
| `supervisor` | `supervisor` | `''`, `organizations/:orgId` | — (стоит в каркасе) |

Маршрут `**` есть только у каркаса. Remote не объявляет `**`, поэтому неизвестный путь проваливается к `**` каркаса.

### 4.5. Общие зависимости федерации

У каркаса и у каждого remote свой `federation.config.js`. В нём:
- `shareAll({ singleton: true, strictVersion: true, requiredVersion: 'auto' })`;
- workspace-пакеты `@swag/ui-angular`, `@swag/ui-core`, `@swag/contracts` с `singleton: true` — через `sharedMappings` (исходники TS, `exports: ./src/index.ts`). Альтернатива — `paths` в `tsconfig` фронтенда, если `sharedMappings` не работает с exports workspace.

Точный рабочий конфиг фиксирует T-1. Он записывается в README каркаса и журнал, остальные фронтенды копируют его.

Цель — на странице одна копия Angular и `@swag/ui-angular`, а значит один `SESSION` и один `CurrentUser` (REQ-014-15). Версии Angular и `@angular-architects/native-federation` во всех четырёх `package.json` одинаковые и точные.

### 4.6. Тексты

Константы `ui-core`, файл `src/auth-forms.ts`, там же `validateConfirmForm`, `validateInviteForm`, `validateEmailForm`. `authErrorText(code)` для неизвестного кода — «Что-то пошло не так. Попробуйте ещё раз.»

| Код | Текст |
|---|---|
| `invalid_credentials` | Неверный email или пароль. |
| `user_blocked` | Пользователь заблокирован. Обратитесь к администратору организации. |
| `rate_limited` | Слишком много попыток. Подождите и попробуйте снова. |
| `mail_unavailable` | Не удалось отправить письмо. Попробуйте позже. |
| `invalid_token` | Ссылка недействительна или устарела. |
| `email_taken` | Этот email уже зарегистрирован. Войдите по своему паролю. |
| `validation_error` | Проверьте поля формы. |
| `forbidden` | Недостаточно прав. |
| `not_found` | Не найдено. |
| `unauthorized`, `invalid_refresh_token` | Сессия закончилась. Войдите снова. |
| `org_directory_unavailable`, `auth_unavailable` | Сервис временно недоступен. Попробуйте позже. |
| `internal_error`, `unknown` | Что-то пошло не так. Попробуйте ещё раз. |

Тексты полей форм (`path` в `FormIssue`):

| Поле | Текст |
|---|---|
| `password` | Пароль — от 10 до 128 символов. |
| `repeat` | Пароли не совпадают. |
| `organizationName` | Название — от 1 до 200 символов. |
| `email` | Введите email. |
| `comment` (пополнение у супервизора) | Укажите комментарий. |

Сообщения:
- `/signup` после `202`: «Если адрес верный, мы отправили на него письмо со ссылкой. Откройте его, чтобы закончить регистрацию.»
- `/signup/confirm` с `invalid_token`: текст `invalid_token` и ссылка «Зарегистрироваться заново» на `/signup`.
- `/invite` с `invalid_token`: «Приглашение недействительно или устарело. Попросите администратора прислать новое.»
- `admin` после приглашения: «Приглашение отправлено на <email>.»

Подписи действий:
- `make_admin` — «Сделать администратором»;
- `make_user` — «Сделать пользователем»;
- `block` — «Заблокировать»;
- `unblock` — «Разблокировать».

Подтверждение нужно только для `block`: «Заблокировать <email>? Его сессии завершатся, рои остановятся.»

### 4.7. Общий Angular-пакет `@swag/ui-angular`

> **Изменено Q-9 (2026-11-01), см. 4.12.** `SESSION`, `CurrentUser`, `ensureRestored` и `ThemeService` заменяются `SessionUserStore` и `ShellStore` из `ui-core`. `swag-balance-panel` теряет своё состояние. Guard'ы работают поверх `SessionUserStore`. Остальное в таблице ниже действует.

**Устройство пакета.**
- Каталог `packages/ui-angular` — оболочечный код фронтендов, не ядро. В нём разрешены Angular и DOM. `arch:check` относит к ядрам только `*-core`, `contracts`, `api-integration`, поэтому пакет туда не попадает без правок.
- `package.json`:
  - зависимости — `@angular/core`, `@angular/common`, `@angular/router`, `@angular/cdk` (версия как у Angular, точная), `@swag/ui-core`, `@swag/contracts`;
  - `exports` — `./src/index.ts` и `./styles/*`.
- `tsconfig.json` — по образцу `apps/ui/cabinet/tsconfig.json` (DOM, `bundler`).

| Файл `src/` | Что | Откуда |
|---|---|---|
| `session.ts` | `SESSION`, `CurrentUser`; у `CurrentUser` добавлен публичный `readonly me: Signal<AuthMe \| null>` | перенос `apps/ui/cabinet/src/app/session.ts` |
| `http.ts` | `HttpError` (`status: number`, `code: string`, по умолчанию `'unknown'`), `createRequest(session, basePath)` — `Authorization: Bearer`, на `401` один `renew()` и повтор, неудача — `onSignedOut` | вынос из `apps/ui/cabinet/src/app/api.ts` с параметром `basePath` (`/api` или `/auth`) |
| `auth-api.ts` | адаптер `AuthApi` (4.1) на `fetch`, ошибки — `HttpError` | перенос `apps/ui/cabinet/src/app/auth-api.ts`, класс `AuthRequestError` заменяется `HttpError` |
| `users-api.ts` | `createUsersApi(session)`, `createOrganizationsApi(session)` (4.3) на `createRequest(session, '/auth')` | новое |
| `balance-api.ts` | `createBalanceApi(session)` | перенос из `api.ts` кабинета |
| `guards.ts` | `ensureRestored(): Promise<boolean>` — один `restore()` на загрузку страницы, повторные вызовы получают тот же промис (каждый `restore()` ротирует refresh-cookie); `sessionGuard`: `CanMatchFn` — `ensureRestored()`, затем `CurrentUser.ensure()`; нет токена — `router.createUrlTree(['/login'], { queryParams: { returnTo: router.serializeUrl(router.currentNavigation()!.extractedUrl) } })` | замена `apps/ui/cabinet/src/app/auth.guard.ts` |
| | `areaGuard(area)`: `CanMatchFn` — `ensure()`, затем `canOpen(area, me)`; `false` — `UrlTree` `/` | новое |
| `balance-panel.ts` | компонент `swag-balance-panel`: вход `orgId`, `requireComment`; числа, история с «Ещё», форма пополнения при `balance.topup`; поведение — 013, 4.11 | вынос из `apps/ui/cabinet/src/app/balance.page.ts` |
| `theme.ts` | `ThemeService`: `mode` (`system` \| `light` \| `dark`), атрибут `data-theme` на `<html>`, `localStorage['swag.theme']` в `try/catch` | новое |
| `components/*.ts` | базовые компоненты 4.8, по файлу на компонент | новое |
| `index.ts` | реэкспорт | новое |

`styles/tokens.css` — токены 4.8. `styles/base.css` — глобальные стили: элементы, раскладка, классы кабинета `.feed`, `.agent-row`, `.toolbar`. Они переносятся из `<style>` в `apps/ui/cabinet/src/index.html`, литералы цвета заменяются токенами. Оба файла подключает каркас в `angular.json` (`styles`). Remote работают в документе каркаса и получают их оттуда.

API роёв (`createSwarmsApi`, `createSwarmStream`) остаётся в `cabinet`.

### 4.8. Дизайн-токены и базовые компоненты

**Токены** — CSS custom properties в `styles/tokens.css`.
- Светлая тема — в `:root`. Тёмная — в `:root[data-theme="dark"]` и в `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }`.
- Имена:
  - фон и поверхности: `--swag-color-bg`, `--swag-color-surface`, `--swag-color-surface-2`;
  - текст: `--swag-color-text`, `--swag-color-text-muted`;
  - границы и фокус: `--swag-color-border`, `--swag-color-focus`;
  - основной цвет: `--swag-color-primary`, `--swag-color-primary-text`;
  - статусы: `--swag-color-danger`, `--swag-color-danger-text`, `--swag-color-success`, `--swag-color-warning`;
  - шрифты: `--swag-font-sans`, `--swag-font-mono`;
  - размеры текста: `--swag-text-sm`, `--swag-text-md`, `--swag-text-lg`, `--swag-text-xl`;
  - отступы: `--swag-space-1` … `--swag-space-6`;
  - радиусы: `--swag-radius-sm`, `--swag-radius-md`;
  - тень: `--swag-shadow-1`.
- Значения задаёт задача T-7 скиллом из Q-3 и записывает в README пакета.
- Пары контраста REQ-014-21, ≥ 4.5:1 в обеих темах:
  - `text`/`bg`, `text`/`surface`, `text-muted`/`surface`;
  - `primary-text`/`primary`, `danger-text`/`danger`.
- Значения цветов — только hex `#rrggbb`: так автотест посчитает контраст.

**Компоненты** — standalone, файл на компонент, селекторы с префиксом `swag-`.

| Компонент | Входы | Назначение |
|---|---|---|
| `swag-button` | `variant: 'primary' \| 'secondary' \| 'danger'`, `disabled`, `busy` | кнопка; `busy` блокирует повторное нажатие |
| `swag-field` | `label`, `error: string \| null` | подпись, слот поля, ошибка через `aria-describedby` |
| `swag-card` | `title` | блок с заголовком |
| `swag-table` | `empty: string` | обёртка таблицы со строкой «пусто» |
| `swag-alert` | `kind: 'error' \| 'info' \| 'success'` | сообщение; у ошибки `role="alert"` |
| `swag-page` | `title` | заголовок страницы и область содержимого |
| `swag-confirm` | `text`, событие `confirmed`, `cancelled` | диалог на `@angular/cdk/dialog`, Esc — отмена |

### 4.9. Compose и dev-серверы

| Сервис | Образ | Порт | `ng serve` |
|---|---|---|---|
| `ui` | `apps/ui/shell/Dockerfile` | `127.0.0.1:${UI_PORT}:4200` | `--host 0.0.0.0 --port 4200` |
| `ui-cabinet` | `apps/ui/cabinet/Dockerfile` | не публикуется | `--host 0.0.0.0 --port 4201 --serve-path /mf/cabinet/` |
| `ui-admin` | `apps/ui/admin/Dockerfile` | не публикуется | `--host 0.0.0.0 --port 4202 --serve-path /mf/admin/` |
| `ui-supervisor` | `apps/ui/supervisor/Dockerfile` | не публикуется | `--host 0.0.0.0 --port 4203 --serve-path /mf/supervisor/` |

Команда — скрипт `start` в `package.json` фронтенда.
- **Healthcheck remote**: `wget -qO- http://127.0.0.1:<порт>/mf/<имя>/remoteEntry.json`.
- **Зависимости `ui`**: `depends_on` `condition: service_healthy` на `api`, `identity` и на существующие к этому моменту remote.

**Прокси каркаса** `apps/ui/shell/proxy.conf.json`:
- `/api`, `/auth`, `/grafana` — как сейчас у кабинета;
- `/mf/cabinet` → `http://ui-cabinet:4201`, `/mf/admin` → `http://ui-admin:4202`, `/mf/supervisor` → `http://ui-supervisor:4203`, без `pathRewrite` и с `changeOrigin: false`.

`changeOrigin: false` нужен потому, что dev-сервер remote отвергает чужой `Host`, а с ним приходит `127.0.0.1:4200`. Если dev-сервер всё равно отвергает, T-1 добавляет `allowedHosts` в `angular.json` remote и пишет это в журнал. `/internal` не проксируется.

**`npm run ui:dev`** (REQ-014-20) — скрипт `scripts/ui-dev.ts`.
- Запускает четыре `ng serve --host 127.0.0.1` на портах `UI_PORT`, `UI_CABINET_PORT`, `UI_ADMIN_PORT`, `UI_SUPERVISOR_PORT` с `serve-path` как в таблице. По Ctrl+C останавливает все.
- Каркас идёт с `--proxy-config apps/ui/shell/proxy.host.conf.mjs`. Адреса прокси берутся из env:
  - `/api` → `http://127.0.0.1:${API_PORT}`, `pathRewrite` как в compose;
  - `/auth` → `http://127.0.0.1:${IDENTITY_PORT}`;
  - `/grafana` → `http://127.0.0.1:${GRAFANA_PORT}`;
  - `/mf/<имя>` → `http://127.0.0.1:${UI_<ИМЯ>_PORT}`.
- Если `UI_PORT` занят сервисом `ui` контура, скрипт падает с текстом «Остановите ui: docker compose stop ui».

### 4.10. env и конфиг

Добавить в `.env.example` и `.env`, значения буквальные (`node --env-file` не раскрывает `${}`):

```
UI_CABINET_PORT=4201
UI_ADMIN_PORT=4202
UI_SUPERVISOR_PORT=4203
IDENTITY_CONFIRM_URL=http://127.0.0.1:4200/signup/confirm
IDENTITY_INVITE_URL=http://127.0.0.1:4200/invite
```

Последние две строки меняют значения из 012, 4.10 и 024, 4.14 с пометкой «изменено спекой 014». Комментарии у этих переменных в `packages/config/src/index.ts` обновляются.

`UiConfig` (`@swag/config`) получает `UI_CABINET_PORT`, `UI_ADMIN_PORT`, `UI_SUPERVISOR_PORT` (`Port`, по умолчанию 4201–4203). Конфиг читает `scripts/ui-dev.ts`.

`infra:check` проверяет:
- `ui` — `GET /` на `UI_PORT`;
- remote — через прокси каркаса, `GET http://127.0.0.1:${UI_PORT}/mf/<имя>/remoteEntry.json`.

### 4.11. Страницы каркаса

| Путь | При открытой сессии | Что |
|---|---|---|
| `/login?returnTo=` | → `safeReturnTo(returnTo)` | email, пароль; ссылка «Зарегистрировать компанию» → `/signup` |
| `/signup` | → `/` | email; сообщение 4.6; ссылка «Уже есть аккаунт» → `/login` |
| `/signup/confirm?token=` | «Вы вошли как …», «Выйти и продолжить» (REQ-014-9) | пароль, повтор, название организации |
| `/invite?token=` | так же | пароль, повтор |

`/signup/confirm` и `/invite` без `token` показывают текст `invalid_token`. Есть ли сессия, страницы узнают через `ensureRestored()` (4.7). Это общий с `sessionGuard` вызов, один раз за загрузку страницы. *Изменено Q-9:* вместо `ensureRestored()` — `SessionUserStore.restore()` (4.12), поведение то же.

### 4.12. Сторы `ui-core` (Q-9)

Добавлен по Q-9. Где 4.7, 4.11 и задачи раздела 8 расходятся с этим разделом, действует 4.12.

**Принцип.** Вся логика фронтендов — в `ui-core`, на чистом TS без фреймворка:
- состояние, загрузка данных, вычисления, ограничения, сценарии.

Компонент — шаблон: читает сигналы стора и вызывает его методы. Метод стора возвращает результат, по которому компонент может перейти на другой адрес; сам стор роутер не трогает. Тот же `ui-core` подключается к другому фреймворку своим мостом, без правки ядра.

**Пакет.**
- `@preact/signals-core` 1.14.5 — в `dependencies` `ui-core`. Из него — только главная точка входа: `signal`, `computed`, `effect`, `batch`, `untracked`, тип `ReadonlySignal`.
- Тот же пакет — в `dependencies` каркаса и каждого remote, чтобы `shareAll` (4.5) отдал его как singleton. Две копии preact в одной странице не видят сигналы друг друга, поэтому одна копия на страницу проверяется так же, как `@swag/ui-core` (AC-014-16).
- `arch:check` (`scripts/arch-check.ts`): белый список `ui-core` — список ядра плюс `@preact/signals-core` без подпутей. Другим ядрам он запрещён. Тест — в `scripts/arch-check.test.ts`. `docs/architecture.md`, правило 2 «Правила ядра»: исключение для `ui-core` со ссылкой на Q-9.
- Сторы и мост — `signal`, `computed`, `effect` и `batch` preact. `effect` в сторе допустим только с явным снятием в `dispose()`.
- Тесты сторов — `packages/ui-core/test/*.store.test.ts`, vitest в Node, порты — заглушки.

**Сторы — фабрики** `createXStore(deps): XStore`. Сигналы наружу — только `ReadonlySignal`, менять состояние можно только методами стора. Порты — интерфейсы `ui-core`: `AuthApi` (4.1), `SwarmsApi`, `EventStream`, `Timers` (001, 4.8), `UsersApi`, `OrganizationsApi` (4.3) и новые в `src/ports.ts`:

```ts
import type { AuthMe, BalanceEntry, BalanceEntryList, BalanceView, TopupRequest } from '@swag/contracts';

export interface BalanceApi {
  getBalance(orgId: string): Promise<BalanceView>;
  listBalanceEntries(orgId: string, before: number | null): Promise<BalanceEntryList>;
  topup(orgId: string, body: TopupRequest): Promise<BalanceEntry>;
}
export interface MeApi {
  me(accessToken: string): Promise<AuthMe | null>; // GET /auth/me; null — 401
}
export interface Preferences {
  get(key: string): string | null; // ошибка хранилища — null
  set(key: string, value: string): void; // ошибка хранилища — молча
}
```

**`SessionUserStore`** — `src/session-user.store.ts`, `createSessionUserStore({ auth: AuthApi, me: MeApi })`. Внутри один `createAuthSessionKeeper(auth)`. На каркас и все remote — один экземпляр.

| Член | Что |
|---|---|
| `me`, `status` | `ReadonlySignal<AuthMe \| null>`, `ReadonlySignal<'unknown' \| 'signed-in' \| 'signed-out'>` |
| `role`, `orgId`, `navigation` | `computed`: `me.user.role`, `me.organization?.id ?? null`, `navigationFor(me)` (4.2) |
| `canOpen(area)` | `canOpen(area, me.value)` (4.2) |
| `accessToken()`, `renew()` | как у `AuthSessionKeeper`; успешный `renew` вызывает `ensureMe()`. Стор — `RequestSession` для адаптеров (4.7) |
| `restore(): Promise<boolean>` | один `restore()` хранителя на стор, повторные вызовы получают тот же промис; затем `ensureMe()` |
| `ensureMe(): Promise<void>` | токена нет → `me = null`, `status = 'signed-out'`. Токен тот же, что при последней загрузке, → ничего. Иначе одна загрузка на токен: `me.me(token)`; на `null` — один `renew` и повтор |
| `login`, `register`, `confirmRegistration`, `acceptInvitation` | вызов хранителя (4.1), результат — `AuthResult`; при `ok` у входа, подтверждения и приглашения — `ensureMe()` до возврата |
| `logout(): Promise<void>` | `logout` хранителя, `me = null`, `status = 'signed-out'` |

`onSignedOut` хранителя → `me = null`, `status = 'signed-out'`. Ответ `me.me` для токена, который уже сменился, не записывается.

**`createBalanceState({ session, balance: BalanceApi })`** — `src/balance.state.ts`, часть `CabinetStore` и `SupervisorStore` как поле `balance`. Логика панели 013, 4.11.
- Сигналы:
  - `orgId`, `view`, `entries`, `nextBefore`;
  - `loaded`, `loadingMore`, `submitting`;
  - `error`, `formError`, `commentError`;
  - `canTopup` — право `balance.topup` у `session.role`.
- `open(orgId)`: сброс, затем баланс и первая страница истории вместе. Ответ — успех или ошибка — для `orgId`, который уже сменился, не записывается.
- `more()`: следующая страница по `nextBefore`.
- `topup({ amountUsd, comment }, requireComment): Promise<boolean>`:
  - пустой комментарий при `requireComment` → `commentError = FORM_TEXT.comment`, запроса нет;
  - сумма — `usdToMicro` и `TopupRequest.safeParse`, ошибка → `formError`, запроса нет;
  - успех → `open` той же организации, результат `true`.

**Сторы фронтендов.** У каждого фронтенда один стор. `session` — общий `SessionUserStore`.

| Стор, файл `src/`, зависимости | Сигналы | Методы |
|---|---|---|
| `ShellStore`, `shell.store.ts`, `{ session, preferences }` | `form`: `{ busy, error: string \| null, issues: FormIssue[], sent }`; `theme`: `'system' \| 'light' \| 'dark'` из `preferences.get('swag.theme')`, неизвестное → `'system'`; `sectionUnavailable` | `login(email, password, returnTo): Promise<string \| null>` — `safeReturnTo(returnTo)` или `null` с `error = authErrorText(code)`; `register(email)` — `validateEmailForm` до запроса, успех → `sent`; `confirmRegistration(input)`, `acceptInvitation(input)` — `validateConfirmForm` / `validateInviteForm` до запроса, успех → `'/'`, иначе `null`; `logout()`; `setTheme(mode)` — сигнал и `preferences.set`; `setSectionUnavailable(flag)`; `resetForm()` |
| `CabinetStore`, `cabinet.store.ts`, `{ session, swarms, stream, timers, traces: { urlTemplate }, balance }` | `swarms`; `swarm`: `{ view, feed, connected } \| null`; `form`: `{ busy, issues, error }`; `balance` — `createBalanceState` | `loadSwarms()`; `createSwarm(input): Promise<string \| null>` — id нового роя или `null`, текст `402` как в кабинете сейчас; `openSwarm(id)`, `closeSwarm()`, `stopSwarm()` — поверх `createUiCore` (001, 4.8); `traceUrl(traceId)` — `null`, если `session.role.value !== 'supervisor'`; `dispose()` — `closeSwarm()` |
| `AdminStore`, `admin.store.ts`, `{ session, users }` | `users`, `loaded`, `error`; `invite`: `{ busy, issues, error, sent }`; `rows` — пользователь и `userActions(me, user)` (4.2) | `load()` — `users.list(null)`; `invite(email, role)` — `validateEmailForm` до запроса; `apply(userId, action)` — `userActionBody(action)`, на успех один `load()`; ошибки — тексты 4.6 (`403` → `forbidden`) |
| `SupervisorStore`, `supervisor.store.ts`, `{ session, users, organizations, balance }` | `organizations`, `orgId`, `users`, `error`; `organization` — из списка по `orgId`; `notFound` — список загружен, а `orgId` в нём нет; `rows` — как у `AdminStore`; `balance` — `createBalanceState` | `loadOrganizations()`; `openOrganization(orgId)` — сброс пользователей, `balance.open(orgId)`, `users.list(orgId)`, ответ для сменившегося `orgId` не пишется; `apply(userId, action)` — как у `AdminStore`, перечитывает пользователей этой организации; пополнение — `balance.topup(input, true)` |

**Мост в Angular** — `@swag/ui-angular`, `src/stores.ts`:
- **Мост универсальный.** Новое поле стора доступно в шаблоне без правки моста. Тип выводится из стора через generic.

  ```ts
  import type { ReadonlySignal } from '@preact/signals-core';
  import type { DestroyRef, Signal } from '@angular/core';

  export type Connected<S> = {
    readonly [K in keyof S]: S[K] extends ReadonlySignal<infer V>
      ? Signal<V>
      : S[K] extends (...args: infer A) => infer R
        ? (...args: A) => R
        : S[K] extends object
          ? Connected<S[K]>
          : S[K];
  };

  export function toAngularSignal<T>(source: ReadonlySignal<T>, destroyRef: DestroyRef): Signal<T>;
  export function connectStore<S extends object>(store: S, destroyRef?: DestroyRef): Connected<S>;
  ```

- `toAngularSignal`:
  - создаёт Angular-`signal(source.peek())`;
  - `effect` preact пишет в него `source.value`;
  - снятие `effect` — в `destroyRef.onDestroy`;
  - возвращает `asReadonly()`.
- `connectStore` — `Proxy` над стором, только чтение:
  - `destroyRef` по умолчанию — `inject(DestroyRef)`, синхронно, поэтому вызов — в injection context;
  - на `get` поле, которое `instanceof Signal` preact (сюда входит и `computed`), отдаётся через `toAngularSignal`;
  - функция отдаётся привязанной к стору;
  - простой объект (`balance`) — вложенным `connectStore` с тем же `destroyRef`;
  - остальное — как есть;
  - результат кэшируется по полю: `effect` создаётся при первом чтении, повторное чтение отдаёт тот же объект;
  - `set`, `defineProperty`, `deleteProperty` бросают `TypeError`.
- Токены: `SESSION_USER` (`providedIn: 'root'`, фабрика: `createSessionUserStore` на адаптерах `fetch`), `SHELL_STORE`, `CABINET_STORE`, `ADMIN_STORE`, `SUPERVISOR_STORE`.
- `provideShellStore()`, `provideCabinetStore()`, `provideAdminStore()`, `provideSupervisorStore()`: стор собирается из адаптеров и `SESSION_USER`, оборачивается в `connectStore`. На `DestroyRef` инжектора снимаются `effect` моста и вызывается `dispose()` стора, если он есть.
- Каркас даёт `provideShellStore()` в `app.config.ts`. Remote — свой провайдер в `providers` корневого маршрута `./routes`.
- Адаптеры с токеном доступа строятся на `createRequest(<SessionUserStore>, basePath)` (4.7). `MeApi` и `Preferences` — новые адаптеры. `Preferences` — `localStorage` в `try/catch`.
- `sessionGuard`: `await session.restore()`, нет токена → `UrlTree` `/login?returnTo=` (4.7). `areaGuard(area)`: `await session.ensureMe()`, затем `session.canOpen(area)`.
- `swag-balance-panel` без своего состояния. Вход `state` — `balance` из `Connected<…>`. Выходы: `more`, `topup` (`{ amountUsd, comment }`).
- Тему на `<html>` ставит каркас: Angular-`effect` в `App` читает `theme()`. Это работа с DOM, не логика.
- Из пакета удаляются `SESSION`, `CurrentUser`, `ensureRestored`, `ThemeService`.
- `apps/ui/*/src` не импортирует `createRequest`, `create*Api`, `authApi`, `create*Store`, `@preact/signals-core` и не вызывает `fetch(`. Стор он получает только через токен из `@swag/ui-angular`.

## 5. Критерии приёмки

- **AC-014-1** — *Given* `AuthApi`-заглушка.
  - *When* `confirmRegistration` и `acceptInvitation` с успехом *Then* `{ ok: true }` и `accessToken()` — токен из ответа.
  - *When* reject `{ code: 'invalid_token' }` *Then* `{ ok: false, code: 'invalid_token' }` и токена нет.
  - *When* `register` с успехом и с reject `rate_limited` *Then* `{ ok: true }` и `{ ok: false, code: 'rate_limited' }`, токен прежний.
  - *When* `refresh`, начатый до `confirmRegistration`, отвечает после *Then* его токен не записывается.
- **AC-014-2** — *Given* `AuthMe` ролей `user`, `admin` (с организацией), `supervisor` (без неё) и `null` *When* `canOpen` для каждой `UiArea` и `navigationFor` *Then* результаты по таблице 4.2 в её порядке. У супервизора нет `balance`, у `null` — пусто.
- **AC-014-3** — *Given* `me` — администратор организации A *When* `userActions` для:
  - себя;
  - супервизора;
  - `user` организации B;
  - `user` A;
  - `admin` A;
  - заблокированного `user` A.

  *Then* `[]`, `[]`, `[]`, `['make_admin', 'block']`, `['make_user', 'block']`, `['make_admin', 'unblock']`.

  *Given* супервизор *When* `admin` организации B *Then* `['make_user', 'block']`. *Given* `user` *When* любой *Then* `[]`. `userActionBody` для каждого действия даёт тело 4.2, и оно проходит `UserUpdate`.
- **AC-014-4** — *Given* `authErrorText` *When* каждый код таблицы 4.6 и `nonexistent` *Then* тексты таблицы и текст по умолчанию.
- **AC-014-5** — *Given* `isLocalRemoteUrl` *When*:
  - `/mf/admin/remoteEntry.json`;
  - `https://evil.example/remoteEntry.json`;
  - `//evil.example/remoteEntry.json`;
  - `/mf/../x/remoteEntry.json`;
  - `/mf/%2e%2e/remoteEntry.json`;
  - `/mf/a\b/remoteEntry.json`;
  - `/mf/admin/main.js`;
  - `javascript:alert(1)`.

  *Then* первый — `true`, остальные — `false`.
- **AC-014-6** — *Given* `safeReturnTo` *When* `/swarms/x?a=1`, `null`, `https://evil.example`, `//evil.example`, `/\evil`, `swarms`, `/a\tb` (табуляция) *Then* `/swarms/x?a=1`, остальные — `/`.
- **AC-014-7** — *Given* `validateConfirmForm` и `validateInviteForm` *When*:
  - пароль из 9 символов;
  - верный пароль и другой повтор;
  - пустое название;
  - верные данные.

  *Then* ошибки 4.6 по полям `password`, `repeat`, `organizationName` в этом порядке, на верных данных — `ok` и тело, которое проходит схему контракта. *When* пустой `token` *Then* ошибка `token`. *When* `validateEmailForm` с `a@b` и с ` A@B.example ` *Then* ошибка `email`, затем `ok` с `a@b.example`.
- **AC-014-8** — *Given* `scripts/ui-config.test.ts`:
  - *When* читает `apps/ui/shell/public/federation.manifest.json` *Then* у каждой записи `isLocalRemoteUrl` — `true`, имена — ровно `cabinet`, `admin`, `supervisor`.
  - *When* читает исходники `apps/ui/shell/src` *Then* нет импорта из `apps/ui/cabinet`, `apps/ui/admin`, `apps/ui/supervisor`, `@swag/cabinet`, `@swag/admin`, `@swag/supervisor` (REQ-014-2).
- **AC-014-9** — *Given* `scripts/ui-config.test.ts`:
  - *When* читает `.env.example` *Then* `IDENTITY_CONFIRM_URL` и `IDENTITY_INVITE_URL` — пути `/signup/confirm` и `/invite` на порту `UI_PORT` того же файла; есть `UI_CABINET_PORT`, `UI_ADMIN_PORT`, `UI_SUPERVISOR_PORT`.
  - *When* читает `compose.yaml` *Then* у `ui-cabinet`, `ui-admin`, `ui-supervisor` нет `ports`; `ui` публикует только `127.0.0.1:`.
  - *When* читает `apps/ui/shell/proxy.conf.json` *Then* нет ключа, который начинается с `/internal`.
- **AC-014-10** — *Given* `scripts/ui-config.test.ts` *When* читает `packages/ui-angular/styles/tokens.css` *Then* у обеих тем есть все токены 4.8, пары REQ-014-21 дают контраст ≥ 4.5:1. *When* ищет в `apps/ui/*/src` и `packages/ui-angular/src` (без тестов) `#rgb` и `#rrggbb`, `rgb(`, `hsl(` в любых строках `.css`, `.html` и `.ts`, включая атрибуты SVG `fill` и `stroke` *Then* не находит (REQ-014-16).
- **AC-014-11** `[manual]` — регистрация (из S-1, шаги 1–4).
  - *Given* `npm run up`.
  - *When* без входа открыть `/balance` и `/admin/users` *Then* `/login?returnTo=%2Fbalance` и `…%2Fadmin%2Fusers`. Во вкладке «Сеть» нет запросов под `/mf/`.
  - *When* `/signup` с новым email *Then* сообщение 4.6. В Mailpit письмо со ссылкой `/signup/confirm?token=`.
  - *When* открыть ссылку *Then* в адресной строке токена нет. В `<head>` есть `meta referrer no-referrer`. В консоли токена нет.
  - *When* пароль и название *Then* `/`, в шапке email, название, пункты «Рои», «Баланс», «Админка».
  - *When* открыть ту же ссылку *Then* «Вы вошли как …». *When* «Выйти и продолжить» и отправить форму *Then* текст `invalid_token` и ссылка на `/signup`.
  - *When* `/signup` с тем же email *Then* то же сообщение и письмо «Вы уже зарегистрированы».

  В журнал — шаги и снимки экрана.
- **AC-014-12** `[manual]` — вход, админка, приглашение (из S-1, шаги 5, 7, 9).
  - *Given* администратор A из AC-014-11.
  - *When* выйти, открыть `/balance`, войти с неверным паролем *Then* текст `invalid_credentials`. *When* с верным *Then* открыт `/balance` (`returnTo`).
  - *When* «Админка» → пригласить email с ролью `user` *Then* «Приглашение отправлено на …», в Mailpit ссылка `/invite?token=`.
  - *When* в другом профиле браузера принять приглашение *Then* у приглашённого «Рои» и «Баланс», без «Админки». *When* он открывает `/admin/users` *Then* `/`, запросов под `/mf/admin/` нет.
  - *When* администратор блокирует приглашённого с подтверждением *Then* в списке «заблокирован». Через `API_REVOCATION_POLL_MS` + 1 с действие приглашённого в «Роях» уводит его на `/login`, повторный вход — текст `user_blocked`.
  - *When* разблокировать и сделать администратором *Then* список отражает изменения. После входа приглашённого у него есть «Админка».
- **AC-014-13** `[manual]` — смена прав (REQ-014-4).
  - *Given* два администратора организации A — `adm1` и `adm2`, у `adm2` открыта «Админка».
  - *When* `adm1` делает `adm2` пользователем, проходит `API_REVOCATION_POLL_MS` + 1 с, и `adm2`, не перезагружая страницу, нажимает «Заблокировать» у третьего пользователя *Then* по 024 (AC-024-7) токен и сессия `adm2` отозваны: `401`, `renew` не удался, `adm2` на `/login`.
  - *When* `adm2` входит снова *Then* в шапке «Рои» и «Баланс», «Админки» нет, `/admin/users` ведёт на `/`.
- **AC-014-14** `[manual]` — супервизор (из S-1, шаги 8, 10).
  - *Given* организации A (AC-014-11) и B (вторая регистрация), администратор A из AC-014-12.
  - *When* вход супервизором из `.env` *Then* пункты «Рои» и «Организации».
  - *When* «Организации» *Then* A и B с числом пользователей.
  - *When* открыть A *Then* название, пользователи, баланс.
  - *When* пополнить на $1 без комментария *Then* «Укажите комментарий». *When* с комментарием *Then* баланс и история обновлены, у администратора A на `/balance` та же запись.
  - *When* супервизор блокирует пользователя A *Then* статус в списке.
  - *When* администратор A открывает `/supervisor` *Then* `/`, запросов под `/mf/supervisor/` нет.
  - *When* супервизор открывает `/supervisor/organizations/<случайный uuid>` *Then* текст `not_found`.
- **AC-014-15** `[manual]` — кабинет как remote (REQ-014-11, REQ-014-18).
  - *Given* администратор с балансом.
  - *When* создать рой, открыть, остановить, открыть `/balance` *Then* поведение как в 013, AC-013-25: граф, лента, деньги, «Стоп», отказ `402` с текстом 013, история.
  - *When* перезагрузить `/swarms/:id` *Then* сессия восстановлена, страница роя открыта.
  - Ссылки «трейс» у администратора нет, у супервизора на том же рое — есть.
  - Граф и лента читаются в тёмной теме.
- **AC-014-16** `[manual]` — одна сессия (REQ-014-15).
  - *Given* `IDENTITY_ACCESS_TTL_S=60` в `.env` на время проверки, вход администратором, открыты «Рои», затем «Админка».
  - *When* подождать больше 60 с, затем открыть «Рои» и сразу «Админку» *Then* во вкладке «Сеть» один `POST /auth/refresh`.
  - Команда проверки из журнала T-1 подтверждает один экземпляр `@swag/ui-angular`.
  - В `localStorage` и `sessionStorage` только `swag.theme`.
- **AC-014-17** `[manual]` — темы и клавиатура (REQ-014-16, REQ-014-22).
  - *When* «тёмная», «светлая», «как в системе» при тёмной системной теме *Then* тёмная, светлая, тёмная; выбор переживает перезагрузку.
  - *When* `/login`, `/signup`, «Админка» только с клавиатуры (Tab, Enter, Esc в диалоге) *Then* все действия доступны, фокус виден.
  - Итог `audit` скилла из Q-3 — в журнал.
- **AC-014-18** `[manual]` — запуск на хосте (REQ-014-20).
  - *Given* `npm run up`, `docker compose stop ui`.
  - *When* `npm run ui:dev` и правка текста `/login` *Then* изменение видно без перезапуска.
  - Вход и «Админка» работают.
  - *When* `npm run ui:dev` при запущенном `ui` *Then* текст «Остановите ui…».
- **AC-014-19** — *Given* `createRequest` из `packages/ui-angular/src/http.ts` с заглушками `fetch` и `AuthSessionKeeper` (`packages/ui-angular/test/http.test.ts`).
  - *When* ответ `403 { error: { code: 'forbidden' } }` *Then* reject `HttpError { status: 403, code: 'forbidden' }`, `renew` и `onSignedOut` не вызваны.
  - *When* `401`, затем `200` *Then* один `renew` и один повтор с новым токеном, результат — тело `200`.
  - *When* два одновременных запроса получают `401` *Then* `renew` вызван один раз.
  - *When* `401` и `renew` → `false` *Then* reject `HttpError { status: 401 }` без повтора.
  - *When* `500` без тела *Then* `HttpError { status: 500, code: 'unknown' }`.
  - *When* `basePath` `/auth` *Then* запрос уходит на `/auth/<путь>`.
- **AC-014-20** — *Given* `scripts/ui-config.test.ts` *When* импортирует `apps/ui/shell/proxy.host.conf.mjs` с заданными `API_PORT`, `IDENTITY_PORT`, `GRAFANA_PORT`, `UI_*_PORT` *Then* адреса 4.9 на `127.0.0.1` с этими портами, ключей `/internal` нет.
- **AC-014-21** — `SessionUserStore` (REQ-014-4, REQ-014-15, REQ-014-24). *Given* `createSessionUserStore` с заглушками `AuthApi` и `MeApi` (`packages/ui-core/test/session-user.store.test.ts`).
  - *When* два одновременных `restore()` *Then* один `refresh`, один `me`.
  - *When* `login` успешен *Then* `status` `signed-in`, `me` из `MeApi`, вызов `me` один.
  - *When* `ensureMe()` с тем же токеном *Then* `MeApi` не вызван.
  - *When* `renew()` дал новый токен *Then* `me` перечитан один раз.
  - *When* `MeApi.me` вернул `null` *Then* один `renew` и один повтор.
  - *When* токен сменился, пока шёл `me` *Then* ответ для старого токена не записан.
  - *When* хранитель сообщил `onSignedOut` *Then* `me` `null`, `status` `signed-out`.
  - *When* `logout()` *Then* то же.
- **AC-014-22** — `ShellStore` (REQ-014-5…8, REQ-014-16). *Given* `createShellStore` на заглушках (`packages/ui-core/test/shell.store.test.ts`).
  - *When* `register` с неверным email *Then* `form.issues` не пуст, запроса нет.
  - *When* `register` и ответ `202` *Then* `form.sent`.
  - *When* `login` отклонён с `invalid_credentials` *Then* результат `null`, `form.error` — `authErrorText('invalid_credentials')`.
  - *When* `login` успешен с `returnTo` `//evil.example` *Then* результат `/`.
  - *When* `confirmRegistration` с разными паролями *Then* `issues`, запроса нет.
  - *When* `preferences.get('swag.theme')` — `'dark'` *Then* `theme` `dark`; при `'x'` — `system`.
  - *When* `setTheme('light')` *Then* `preferences.set('swag.theme', 'light')`.
- **AC-014-23** — `CabinetStore` (REQ-014-11, REQ-014-18). *Given* `createCabinetStore` на заглушках (`packages/ui-core/test/cabinet.store.test.ts`).
  - *When* `createSwarm` с неверной формой *Then* `form.issues` не пуст, `SwarmsApi.create` не вызван.
  - *When* `create` отклонён `402` *Then* результат `null`, `form.error` — прежний текст кабинета.
  - *When* `traceUrl('t1')` у роли `user` *Then* `null`; у `supervisor` — адрес по шаблону.
  - *When* `openSwarm` и поток отдал событие *Then* `swarm.feed` содержит его.
  - *When* `closeSwarm()` *Then* поток закрыт, таймер переподключения снят.
- **AC-014-24** — `AdminStore` (REQ-014-12). *Given* `createAdminStore` на заглушках (`packages/ui-core/test/admin.store.test.ts`).
  - *When* `load()` *Then* у каждой строки `rows` действия — `userActions(me, user)`.
  - *When* `apply` успешен *Then* `UsersApi.list` вызван ещё один раз.
  - *When* `apply` отклонён `403` *Then* `error` — текст `forbidden` (4.6), `status` сессии `signed-in`.
  - *When* `invite` с неверным email *Then* запроса нет.
- **AC-014-25** — `SupervisorStore` (REQ-014-13). *Given* `createSupervisorStore` на заглушках (`packages/ui-core/test/supervisor.store.test.ts`).
  - *When* `openOrganization('missing')` после загрузки списка *Then* `notFound` `true`.
  - *When* `openOrganization('a')`, затем `openOrganization('b')`, и ответ пользователей `a` пришёл последним *Then* `users` — пользователи `b`.
  - *When* `balance.topup` без комментария *Then* `commentError`, `BalanceApi.topup` не вызван.
- **AC-014-26** — границы (REQ-014-23, REQ-014-25).
  - *Given* `scripts/arch-check.test.ts`.
    - *When* файл `packages/ui-core/src` импортирует `@preact/signals-core` *Then* нарушений нет.
    - *When* он же импортирует `@angular/core` или `@preact/signals-core/x` *Then* нарушение.
    - *When* другое ядро импортирует `@preact/signals-core` *Then* нарушение.
  - *Given* `scripts/ui-config.test.ts`, все файлы `apps/ui/*/src`. *Then* нет импортов `createRequest`, `create*Api`, `authApi`, `create*Store`, `@preact/signals-core` и вызовов `fetch(`.
  - *Given* `packages/ui-angular/test/stores.test.ts`, стор с сигналом `count` и вложенным `balance`.
    - *When* `connectStore(store)` в injection context и значение сменилось в сторе *Then* Angular-сигналы `count()` и `balance.loaded()` отдают новое.
    - *When* в стор добавлено поле-сигнал `extra`, а мост не менялся *Then* `connected.extra()` отдаёт его значение.
    - *When* `connected.count` прочитан дважды *Then* тот же объект и один `effect`.
    - *When* вызван метод `connected.inc()` *Then* он работает с `this` стора.
    - *When* запись `connected.count = …` *Then* `TypeError`.
    - *When* инжектор уничтожен, затем значение сменилось *Then* Angular-сигнал прежний.
- **AC-014-27** — состояние баланса (REQ-014-13, 013 4.11). *Given* `createBalanceState` на заглушках (`packages/ui-core/test/balance.state.test.ts`).
  - *When* `open('a')`, затем `open('b')`, и ответ `a` пришёл последним — успех или ошибка *Then* `view`, `entries` и `error` — от `b`.
  - *When* `more()` *Then* `listBalanceEntries` с `before = nextBefore`, записи дописаны в конец.
  - *When* `topup` с суммой `abc` *Then* `formError`, запроса нет.
  - *When* `topup` успешен *Then* результат `true`, баланс перечитан.
  - *When* роль без `balance.topup` *Then* `canTopup` `false`.

## 6. Нефункциональные требования

| ID | Требование | Как измеряется |
|---|---|---|
| NFR-014-1 | Начальный JS каркаса — не больше 250 КБ gzip (Q-8). Сюда входит всё, что `index.html` каркаса грузит до первого перехода в раздел, включая общие зависимости из import map. Remote не входят. | `ng build --stats-json` каркаса и сумма gzip этих файлов; второй замер — «Сеть» на `/login` без кэша. Оба значения — в журнал. |
| NFR-014-2 | Первый переход в раздел другого remote после входа — до отрисовки не дольше 1 с, локально, на dev-сервере | DevTools Performance, 5 замеров, медиана — в журнал |

## 7. Безопасность: что не должно сломаться

- **Скрытие в UI — не доступ.** Права проверяют `api` и identity, AC 024 и 013 на `403` и область видимости остаются зелёными (`npm run check`).
- **`403` не выкидывает из сессии, `401` даёт один `renew`:** AC-014-19.
- **Код раздела без прав не загружается:** REQ-014-3, AC-014-2, AC-014-11, AC-014-12, AC-014-14.
- **Remote только своего origin под `/mf/`:** AC-014-5, AC-014-8.
- **Нет открытого редиректа после входа:** AC-014-6.
- **Токены из писем** не остаются в адресе, не уходят в `Referer` и консоль. Старая ссылка не выкидывает из сессии молча — нужен явный «Выйти и продолжить»: REQ-014-9, AC-014-11.
- **Токен доступа только в памяти**, один на страницу: REQ-014-15, AC-014-16.
- **Нет перебора email на `/signup`:** REQ-014-6, AC-014-11.
- **Порты.** Remote не опубликованы, каркас — только на `127.0.0.1`. `/internal` не проксируется: AC-014-9, AC-014-20.
- **Логика не в компонентах.** Права, проверки форм и сценарии — только в сторах `ui-core`, компоненты их не повторяют: AC-014-26. Скрытие в UI по-прежнему не доступ (первый пункт).
- **Grafana.** Ссылку «трейс» видит только супервизор (AC-014-15). Сама Grafana в dev по адресу `/grafana` открыта любому, кто открыл UI на `127.0.0.1`. Закрыть её входом — спека эксплуатации (Q-4).

## 8. Задачи для агента

Выполняются по порядку, коммит на задачу. **Порядок после Q-9:** T-1…T-11, затем T-21…T-25, затем T-12…T-20. Номера T-21…T-25 новые, чтобы не ломать ссылки журнала.
- **Сборка.** T-12 и T-13 ломают вход до перевода compose: кабинет перестаёт быть приложением, а `ui` в compose ещё на нём. Поэтому они идут группой через фича-ветку `spec/014-cabinet-remote` (implement-spec, «Связанные задачи»). Группа и причина записываются в журнал до T-12. До T-15 и T-16 администратор и супервизор видят пункты «Админка» и «Организации» с текстом «Раздел недоступен». Это ожидаемо, пометка — в журнал. Остальные задачи аддитивны и `main` не ломают.
- **Исполнитель.** Задачи — субагенту Haiku, кроме T-1 и T-7. T-1 — проверка технологии с возможной блокировкой. T-7 — дизайн скиллом. Обе отдаются Sonnet, отклонение от правила 9 `CLAUDE.md` записывается в журнал.

- [x] **T-1.** Проверка федерации на Angular 22.2 и `@angular-architects/native-federation` 22.2.x. Ветка `spec/014-t1`, которая не сливается: каркас и один remote, оба импортируют `@swag/ui-angular`-заглушку с `InjectionToken` и `@swag/ui-core`. Проверить:
  - `initFederation({})` и `loadRemoteModule({ remoteEntry, exposedModule })` — до перехода нет запросов к remote;
  - один экземпляр токена и пакета в каркасе и remote (сравнить объекты);
  - `servePath` remote за прокси dev-сервера каркаса с `changeOrigin: false`;
  - рабочий `federation.config.js` с workspace-пакетами (4.5).

  - команду проверки одного экземпляра пакета в консоли браузера (для AC-014-16).

  Результат — в журнал спеки:
  - рабочие `federation.config.js`;
  - правки `tsconfig` и `angular.json`;
  - итоги проверок;
  - команда проверки экземпляра.

  T-11 берёт конфиг оттуда. Если что-то из 4.4–4.5 не работает — `blocked`, вопрос `Q-k` с вариантами. Закрывает: проверку 4.4–4.5. Готово, когда: в журнале конфиг, итоги проверок и команда проверки.
- [x] **T-2.** `packages/ui-core/src/auth-session.ts`: дополнения 4.1, тип `AuthResult`. Тесты — `test/auth-session.test.ts`. Обновить README `ui-core` и глоссарий. Закрывает: REQ-014-7, REQ-014-8 (сессия), AC-014-1. Готово, когда: тесты пакета зелёные, AC-024-23 зелёный без правок.
- [x] **T-3.** `packages/ui-core/src/access-ui.ts`:
  - `UiArea`, `NavItem`, `canOpen`, `navigationFor`;
  - `UserAction`, `userActions`, `userActionBody`;
  - `safeReturnTo`, `isLocalRemoteUrl`.

  Реэкспорт. Тесты — `test/access-ui.test.ts`. Закрывает: REQ-014-3…5, AC-014-2, AC-014-3, AC-014-5, AC-014-6. Готово, когда: тесты зелёные.
- [x] **T-4.** `packages/ui-core/src/auth-forms.ts`: `authErrorText`, тексты 4.6 константами, `validateConfirmForm`, `validateInviteForm`, `validateEmailForm` на существующем типе `FormIssue`. Порты `UsersApi` и `OrganizationsApi` (4.3) — в `src/index.ts`. Тесты — `test/auth-forms.test.ts`. Закрывает: AC-014-4, AC-014-7. Готово, когда: тесты зелёные.
- [x] **T-5.** Каркас пакета `packages/ui-angular`:
  - `package.json` с зависимостями 4.7, `tsconfig.json` по образцу кабинета, ссылка в корневом `tsconfig.json`;
  - README по правилу 7;
  - `src/index.ts` пока пустой;
  - строка в `docs/architecture.md`, раздел «Пакеты»: фронтендовый оболочечный пакет, не ядро.

  Закрывает: часть 4.7. Готово, когда: `npm install`, `npm run typecheck` и `npm run arch:check` зелёные.
- [x] **T-6.** Перенос в `packages/ui-angular/src`:
  - `session.ts`, где `CurrentUser.me` становится публичным;
  - `http.ts` с `HttpError` и `basePath`;
  - `auth-api.ts` с методами 4.1 на `HttpError`;
  - `balance-api.ts`.

  Плюс:
  - новые `users-api.ts`;
  - тест `packages/ui-angular/test/http.test.ts` (AC-014-19);
  - `getMe` переезжает в `auth-api.ts` пакета.

  `HttpError` заменяет `ApiError` кабинета: поля `status` и `code` те же, у отсутствующего кода — `'unknown'` вместо `null`. Проверка `402` в `apps/ui/cabinet/src/app/swarm-new.page.ts` переходит на `HttpError`.

  Кабинет импортирует перенесённое из пакета, его `api.ts` использует `createRequest(session, '/api')`. Файлы кабинета:
  - сокращаются или удаляются `api.ts`, `session.ts`, `auth-api.ts`;
  - правятся импорты в `swarm-new.page.ts`, `balance.page.ts`, `ui.ts`, `app.config.ts`. Поведение кабинета не меняется. Закрывает: REQ-014-14, REQ-014-15 (код), AC-014-19. Готово, когда: `npm run check` зелёный, в `npm run up` кабинет входит и показывает рои.
- [x] **T-7.** *(Sonnet, скилл из Q-3)*
  - Поставить скиллы `frontend-design` и Impeccable в `.claude/skills/`, в README пакета записать коммит источника и лицензию.
  - Скиллом `frontend-design` выбрать значения токенов 4.8 для обеих тем, записать `packages/ui-angular/styles/tokens.css` и обоснование в README.
  - Добавить тест контраста — `scripts/ui-config.test.ts`, первая часть AC-014-10.

  Закрывает: REQ-014-16 (токены), REQ-014-21, AC-014-10 (контраст). Готово, когда: тест зелёный.
- [x] **T-8.** `packages/ui-angular`:
  - `styles/base.css` — перенос `<style>` из `apps/ui/cabinet/src/index.html` на токены;
  - `src/theme.ts` (`ThemeService`);
  - подключить `tokens.css` и `base.css` в `angular.json` кабинета вместо `<style>`;
  - перевести цвета `apps/ui/cabinet/src/app/swarm-graph.ts` на `var(--swag-…)`.

  Тест литералов — вторая часть AC-014-10, пока только по кабинету и пакету. Закрывает: REQ-014-16. Готово, когда: тест зелёный, кабинет в `npm run up` выглядит как раньше в светлой теме.
- [x] **T-9.** `packages/ui-angular/src/components/`: `swag-button`, `swag-field`, `swag-card`, `swag-alert` (4.8), экспорт из `index.ts`. Закрывает: REQ-014-17 (часть), REQ-014-22. Готово, когда: пакет собирается в кабинете.
- [x] **T-10.** `components/`: `swag-table`, `swag-page`, `swag-confirm` (на `@angular/cdk/dialog`). `src/guards.ts`: `sessionGuard`, `areaGuard` (4.7). `src/balance-panel.ts` — вынос из `balance.page.ts` кабинета: страница кабинета становится обёрткой с `orgId` из `CurrentUser`. Закрывает: REQ-014-17, REQ-014-13 (панель). Готово, когда: `/balance` кабинета работает как раньше.
- [x] **T-11.** Каркас `apps/ui/shell` (`@swag/shell`). Задача аддитивная, кабинет не трогается:
  - Angular-приложение с конфигом из журнала T-1;
  - в `angular.json` в `styles` — `@swag/ui-angular/styles/tokens.css` и `base.css`;
  - `main.ts` (`initFederation({})`), `RemoteRegistry`, маршруты 4.4, `Layout` — шапка по REQ-014-10;
  - страница `/login` с `returnTo` на компонентах 4.8, по образцу `login.page.ts` кабинета;
  - манифест с записью `cabinet`;
  - `proxy.conf.json` 4.9, `Dockerfile`, README.

  Закрывает: REQ-014-1, REQ-014-3, REQ-014-5, REQ-014-10. Готово, когда: `ng build` каркаса и `npm run check` зелёные.
- [x] **T-21.** *(Q-9)* Основа сторов в `packages/ui-core`:
  - `@preact/signals-core` 1.14.5 в `dependencies`;
  - белый список `ui-core` в `scripts/arch-check.ts` и тесты AC-014-26 (часть `arch-check`);
  - исключение в `docs/architecture.md`, правило 2 «Правила ядра»;
  - `src/ports.ts` (`BalanceApi`, `MeApi`, `Preferences`);
  - `src/session-user.store.ts`, тест AC-014-21;
  - README `ui-core`, глоссарий.

  Закрывает: REQ-014-24 (часть), REQ-014-25, AC-014-21, AC-014-26 (часть). Готово, когда: `npm run check` зелёный.
- [x] **T-22.** `packages/ui-core`: `src/balance.state.ts` и `src/shell.store.ts` по 4.12, тесты AC-014-27 и AC-014-22. README, глоссарий. Закрывает: AC-014-22, AC-014-27. Готово, когда: тесты зелёные.
- [x] **T-23.** `packages/ui-core/src/cabinet.store.ts` поверх `createUiCore` и `createBalanceState`, тест AC-014-23. README, глоссарий. Закрывает: AC-014-23. Готово, когда: тесты зелёные.
- [ ] **T-24.** `packages/ui-angular`: мост и переход каркаса на сторы.
  - `src/stores.ts`: `toAngularSignal`, `connectStore`, `Connected`, токены, `provideShellStore`, `provideCabinetStore`. Тест — AC-014-26, часть `stores.test.ts`.
  - Адаптеры `MeApi` и `Preferences`.
  - Guard'ы на `SESSION_USER`.
  - `swag-balance-panel` без своего состояния.
  - Удалить `SESSION`, `CurrentUser`, `ensureRestored`, `ThemeService`.
  - `@preact/signals-core` — в `dependencies` каркаса и кабинета.
  - Каркас: `/login`, шапка и тема только через `SHELL_STORE` и `SESSION_USER`.

  README пакета и каркаса, глоссарий. Закрывает: REQ-014-23 (каркас), REQ-014-24, AC-014-26 (часть). Готово, когда: `ng build` каркаса и кабинета и `npm run check` зелёные.
- [ ] **T-25.** Кабинет на `CABINET_STORE`:
  - `provideCabinetStore()` в `app.config.ts` кабинета; после T-12 провайдер переезжает в `./routes`;
  - `swarm-list.page.ts`, `swarm-new.page.ts`, `swarm.page.ts`, `balance.page.ts` только читают стор и вызывают его методы;
  - `api.ts` и `ui.ts` кабинета — только адаптеры для `provideCabinetStore` или удаляются;
  - вид и поведение экранов не меняются;
  - проверка импортов AC-014-26 — пока по кабинету и каркасу.

  README кабинета. Закрывает: REQ-014-23 (кабинет), AC-014-26 (часть). Готово, когда: в `npm run up` кабинет показывает, создаёт и останавливает рои, `/balance` работает, `npm run check` зелёный.
- [ ] **T-12.** *(группа `spec/014-cabinet-remote`)* `apps/ui/cabinet` становится remote:
  - `federation.config.js` с конфигом T-1, экспорт `./routes` с guard'ами 4.4;
  - удалить `login.page.ts`, `auth.guard.ts`, шапку из `app.ts` и `app.routes.ts`;
  - убрать `tokens.css` и `base.css` из `styles` своего `angular.json`: стили даёт каркас;
  - скрипт `start` и `Dockerfile` по 4.9, README.

  Закрывает: REQ-014-2, REQ-014-11. Готово, когда: `ng build` кабинета зелёный и в сборке есть `remoteEntry.json`.
- [ ] **T-13.** *(группа, затем PR группы в `main`)*
  - Compose 4.9: `ui` на каркасе, сервис `ui-cabinet`.
  - `infra:check` по 4.10.
  - Корневой README и `apps/ui/README.md`.

  Закрывает: REQ-014-2. Готово, когда: `npm run up`, вход в каркас и экраны кабинета работают, `npm run check` зелёный.
- [ ] **T-14.** Страницы каркаса `/signup`, `/signup/confirm`, `/invite` по 4.11, 4.6, REQ-014-6…9 на компонентах 4.8. Сценарии — методы `ShellStore` (4.12), страницы только рисуют. Закрывает: REQ-014-6…9. Готово, когда: регистрация проходит в `npm run up`.
- [ ] **T-15.** `apps/ui/admin` (`@swag/admin`):
  - remote, `./routes` с `providers: [AdminStore]`, страница REQ-014-12 на `AdminStore` (4.12) и `swag-confirm`;
  - `AdminStore` в `ui-core`, тест AC-014-24;
  - `Dockerfile`, README;
  - сервис `ui-admin`, его `depends_on` у `ui` и запись `admin` в манифесте;
  - `infra:check`.

  Закрывает: REQ-014-12, AC-014-24. Готово, когда: «Админка» работает у администратора в `npm run up`.
- [ ] **T-16.** `apps/ui/supervisor` (`@swag/supervisor`):
  - remote, `./routes` с `providers: [SupervisorStore]`, страницы REQ-014-13 на `SupervisorStore` (4.12) и `swag-balance-panel`;
  - `SupervisorStore` в `ui-core`, тест AC-014-25;
  - `Dockerfile`, README;
  - сервис `ui-supervisor`, его `depends_on` у `ui` и запись в манифесте;
  - `infra:check`;
  - тест манифеста и импортов — AC-014-8 в `scripts/ui-config.test.ts`.

  Закрывает: REQ-014-13, AC-014-8, AC-014-25. Готово, когда: «Организации» работают у супервизора, тест зелёный.
- [ ] **T-17.** Экраны кабинета (`swarm-list.page.ts`, `swarm-new.page.ts`, `swarm.page.ts`) на компонентах 4.8 без изменения поведения. Ссылка «трейс» — `CabinetStore.traceUrl` (4.12). Тест литералов AC-014-10 и проверка импортов AC-014-26 расширяются на все `apps/ui/*/src`. Закрывает: REQ-014-17, REQ-014-18, REQ-014-23, AC-014-10, AC-014-26. Готово, когда: тест зелёный, AC-014-15 проходит.
- [ ] **T-18.** env и конфиг по 4.10:
  - `.env.example` и `.env`;
  - `UiConfig`, комментарии в `packages/config/src/index.ts`;
  - README identity — новые адреса страниц;
  - проверки AC-014-9 в `scripts/ui-config.test.ts`.

  Закрывает: REQ-014-19, AC-014-9. Готово, когда: тест зелёный, письмо регистрации ведёт на `/signup/confirm`.
- [ ] **T-19.** *(из N-6)* `scripts/ui-dev.ts` и скрипт `ui:dev` в корневом `package.json`, `apps/ui/shell/proxy.host.conf.mjs` по 4.9, раздел в корневом README и в README каркаса, тест AC-014-20. Закрывает: REQ-014-20, AC-014-20. Готово, когда: тест зелёный, AC-014-18 пройден вручную.
- [ ] **T-20.** Завершение:
  - ручные AC-014-11…18 с журналом;
  - замеры NFR-014-1 и NFR-014-2;
  - статус S-1 в `docs/spec/scenarios.md`;
  - сверка README всех затронутых пакетов, `apps/ui/README.md`, `docs/architecture.md`, глоссария.

  Готово, когда: журнал заполнен, `npm run check` зелёный.

## 9. Открытые вопросы

Все вопросы закрыты. Агент дописывает сюда новые при `blocked`.

- [x] **Q-1.** *(из D-11)* Чем каркас подгружает микрофронтенды. *(Claude, 2026-11-01)* **Ответ человека (2026-11-01): по рекомендации — (а) Native Federation.**
  - **(а) Native Federation** (`@angular-architects/native-federation`): import maps и ESM поверх `@angular/build` на esbuild, которым уже собирается кабинет. Общие зависимости — одна копия (`singleton`).
  - **(б) Module Federation на rspack/webpack**: надо уйти с esbuild-сборщика Angular.
  - **(в) Web components и import maps без федерации**: любая технология у каждого фронтенда. Но у каждого своя копия Angular, а общую сессию придётся передавать через `window` или события.
  - **(г) Без подгрузки во время работы**: каркас импортирует остальные как библиотеки с ленивыми маршрутами. Проще всего, но независимый деплой роадмапа теряется.

  По npm на 2026-11-01:
  - `@angular-architects/native-federation` 22.2.4, peer `@angular/build ~22.2.0` — подходит к Angular 22.2 кабинета;
  - для Module Federation на rspack поддержка Angular 22 не подтверждена, а обёртки Nx для неё устарели в Nx 23;
  - официальной позиции команды Angular по микрофронтендам нет.

  **Рекомендация: (а)**: тот же сборщик, одна копия Angular и сессии. Ленивая загрузка remote без `initFederation(manifest)` (4.4) и общий экземпляр пакета проверяются первой задачей (T-1). В проде манифест подменяет деплой, это вне 014.
- [x] **Q-2.** *(из D-11)* Деление фронтендового кода. *(Claude, 2026-11-01)* **Ответ человека (2026-11-01): по рекомендации — (а) одно ядро `ui-core` и (в) пакет `@swag/ui-angular`.**
  - **Логика.**
    - **(а)** одно ядро `ui-core`, по файлу на область (сессия, доступ, формы, рои);
    - **(б)** своё ядро на фронтенд (`cabinet-core`, `admin-core`…) над общим `api-integration`.
  - **Angular-код** (сессия, `CurrentUser`, адаптеры, компоненты, токены).
    - **(в)** пакет `packages/ui-angular`, оболочечный, `singleton` в федерации;
    - **(г)** копия в каждом фронтенде: нарушает DRY и даёт каждому remote свою сессию, что противоречит REQ-014-15;
    - **(д)** адаптеры в `ui-angular`, компоненты — web components отдельным пакетом.

  **Рекомендация: (а) и (в).** Общей логики (сессия, права, формы) больше, чем различий, а все фронтенды MVP на Angular. Web components понадобятся, когда появится фронтенд на другой технологии.
- [x] **Q-3.** *(из D-16)* Дизайн-система: когда, на чём, каким скиллом, тёмная тема. *(Claude, 2026-11-01)* **Ответ человека (2026-11-01): по рекомендации — внутри 014, тёмная тема в 014, библиотека (а) — свои компоненты на `@angular/cdk`, скилл `frontend-design` для токенов и Impeccable `audit` на приёмке; T-7 делает Sonnet.**
  - **Когда.** Варианты D-16: внутри 014; отдельной спекой перед 014; отдельной спекой раньше. Рекомендация — внутри 014: каркас и три новых фронтенда сразу пишутся в общем стиле.
  - **Тёмная тема.** В 014 (REQ-014-16) или позже. Рекомендация — в 014: токены всё равно вводятся, вторая тема — это второй набор значений и тест контраста.
  - **Библиотека** (npm, 2026-11-01):
    - **(а)** свои 7 компонентов 4.8 на токенах и `@angular/cdk` для диалога и фокуса;
    - **(б)** Angular Material 22.2.5 (M3, peer `@angular/core ^22 || ^23`) с темой из токенов;
    - **(в)** Spartan `@spartan-ng/brain` 1.9.0 (подход shadcn, peer `@angular/core >=21 <23`, нужен Tailwind ≥ 4, сейчас 4.3.3), стабильность релизов не оценена;
    - **(г)** PrimeNG 22.1.4 (peer `^22.1.0`).
  - **Скилл** (2026-11-01):
    - `frontend-design` из [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design), последнее изменение 2026-09-03. Эстетика от предмета и аудитории, палитра из 4–6 цветов, шкала шрифтов, проверка на шаблонность и доступность;
    - [Impeccable](https://github.com/pbakaus/impeccable): около 98,7 тыс. звёзд, обновлён 2026-10-31, команды `critique`, `audit`, `polish` и детектор из 62 правил;
    - копии `frontend-design` из каталогов (awesome-claude-skills, skills.sh) не берём.

  **Рекомендация.**
  - Библиотека **(а)**. Экранов мало: формы, таблицы, диалог. Общая зависимость федерации получается маленькой, тема — только наши токены. CDK даёт доступный диалог без своего кода фокуса. (б) — запасной вариант.
  - Скилл — `frontend-design` для токенов (T-7). Impeccable `audit` — на приёмке (AC-014-17). T-7 делает Sonnet, а не Haiku: нужен скилл и выбор по вкусу. Это отклонение от правила 9 `CLAUDE.md` подтверждается вместе с ответом на Q-3.
- [x] **Q-4.** *(из D-15)* Кто видит Grafana. *(Claude, 2026-11-01)* **Ответ человека (2026-11-01): по рекомендации — (а) ссылку «трейс» видит только супервизор.**
  Сейчас прокси `/grafana` в dev-сервере пускает в Grafana любого, кто открыл UI на `127.0.0.1`. Входа у Grafana нет, а трейсы содержат промпты, ответы и данные всех организаций.
  - **(а)** В 014 ссылку видит только супервизор, прокси в dev остаётся. Вход и роли Grafana — спека эксплуатации (16), до выхода в прод.
  - **(б)** Ссылку видят все, а `/grafana` закрывается прокси с проверкой токена супервизора: нужен свой прокси с проверкой JWT.
  - **(в)** Пользователь и администратор видят трейсы своих роёв: нужна фильтрация Tempo по организации, это вне MVP.

  **Рекомендация: (а)**: организации не обещаем то, что не можем безопасно показать, а инструмент разработки остаётся. Ограничение dev записано в разделе 7.
- [x] **Q-5.** *(D-131: «новая спека после 013, до 014»)* Порядок со спекой мультиорганизаций. *(Claude, 2026-11-01)* **Ответ человека (2026-11-01): по рекомендации — (а) 014 раньше спеки по D-131.**
  - **(а)** 014 раньше. Экраны берут одну организацию из `AuthMe.organization`, весь доступ уже идёт через `/auth/me` и `canOpen`. Переключатель и создание второй организации — в спеке D-131: она меняет `AuthMe` и добавляет выбор в шапку каркаса.
  - **(б)** Сначала спека D-131 (identity, `api`, контракты), 014 зависит от неё и сразу рисует переключатель.

  **Рекомендация: (а)**: регистрация и вход в браузере нужны для ручных проверок всех следующих спек, а UI-часть D-131 — это шапка и `AuthMe`. D-131 остаётся в `questions.md`; при (а) в нём «до 014» меняется на «после 014».
- [x] **Q-6.** Рои и расходы по пользователям в админке и «все рои и расходы» у супервизора. В `SwarmSummary` нет `orgId`, `createdBy` и трат. *(Claude, 2026-11-01)* **Ответ человека (2026-11-01): по рекомендации — (а) не в 014, расход — в 025.**
  - **(а)** Не в 014. Админ и супервизор видят рои в разделе «Рои» по области видимости из 024. Расход по пользователям и узлам — 025, где появится агрегирование расхода.
  - **(б)** В 014: в `SwarmSummary` добавить `orgId`, `createdBy`, `spentMicroUsd`, в `GET /swarms` — фильтры `?orgId=&createdBy=`, в админке и у супервизора — таблицы роёв с тратами. Это 3–4 задачи в `contracts`, `api-core`, `adapter-postgres`.

  **Рекомендация: (а)**: 014 — UI поверх готового API, расход строится один раз в 025 вместе с балансом ИИ.
- [x] **Q-7.** *(из D-38, часть «экран супервизора»)* Счёт платформы у супервизора. Данных нет: поступлений до реальной оплаты нет, агрегатов `providerCostMicroUsd` нет. *(Claude, 2026-11-01)* **Ответ человека (2026-11-01): по рекомендации — (а) не в 014, экран — в 025.**
  - **(а)** Не в 014: экран делается в 025 вместе с данными, D-38 адресован 025.
  - **(б)** В 014 экран-заглушка «нет данных».

  **Рекомендация: (а)**: заглушка ничего не проверяет и потом переделывается.
- [x] **Q-8.** Порог NFR-014-1. *(Claude, 2026-11-01)* **Ответ человека (2026-11-01): по рекомендации — 250 КБ gzip.**
  Числа в роадмапе нет. Варианты:
  - 250 КБ gzip начального JS каркаса с общими зависимостями;
  - 200 КБ;
  - без порога, только замер в журнал.

  Оценка Angular 22 с роутером и формами — порядка 100–150 КБ gzip. Это прикидка, а не замер.

  **Рекомендация:** 250 КБ, после замера в T-20 при необходимости пересмотреть на приёмке.

- [x] **Q-9.** *(от человека, 2026-11-01, во время реализации после T-11)* Где живут состояние и сценарии UI. *(Claude, 2026-11-01)* **Ответ человека (2026-11-01): вся логика UI — в сторах `ui-core` на `@preact/signals-core`, компоненты — только шаблоны с подпиской и вызовом команд; один `SessionUserStore` и по стору на фронтенд; 014 останавливается и дополняется (4.12, T-21…T-25).**

  Требование человека:
  - логика не размазывается по компонентам;
  - ядро описывает состояние, переходы, загрузку данных, ограничения и сценарии;
  - у каждого микрофронтенда один стор;
  - сторы общаются между собой, данные сессионного пользователя — в `SessionUserStore`;
  - все сторы — в одном месте.

  Рассмотрены:
  - (а) `@ngrx/signals` в `ui-core`. Пакет импортирует `@angular/core` (`inject`, `Injectable`, `effect`) и `rxjs-interop`, ядро стало бы зависеть от Angular. Человек выбрал его первым, затем заменил на (б);
  - (б) `@preact/signals-core` — сигналы без фреймворка, мост `connectStore` в `@swag/ui-angular`;
  - (в) `alien-signals` — то же, API беднее;
  - (г) `signal-polyfill` — предложение TC39 на стадии 1;
  - (д) `@xstate/store`, `nanostores` — вычисления не на сигналах.

  Последствия:
  - D-139 (кэш `ensureRestored`) и D-146 (перечитывание `AuthMe` при смене токена) сняты, поведение задано в 4.12;
  - `swag-balance-panel` T-10 и страницы T-11 переделываются в T-24.

## 10. Журнал реализации

Заполняет агент.

| Дата | Ветка / коммит | Что сделано | Отклонения от спеки |
|---|---|---|---|
| 2026-11-01 | `spec/014-t1` / ab82477 (не сливается) | T-1: проверка федерации на Angular 22.2.3 и `@angular-architects/native-federation` 22.2.4, итоги — ниже. T-1 выполнил Sonnet, а не Haiku: задача проверки технологии (раздел 8, «Исполнитель») | Уточнения 4.5 и 4.9 без смены контракта: файл `federation.config.mjs` вместо `.js` (пакеты `"type": "module"`); `shareAll(cfg, { skipList })` с исключением `@swag/*` и сборочных пакетов; `features.ignoreUnusedDeps: false`; `baseHref` remote в `serve`; `public/` каркаса в `assets`; явный `@angular/compiler-cli` 22.2.3 |
| 2026-11-01 | `spec/014-t5` / f40122f | T-5: пакет `@swag/ui-angular`. T-6: в пакет перенесены `session.ts`, `http.ts`, `auth-api.ts`, `balance-api.ts`, добавлен `users-api.ts`; кабинет переведён на пакет | Явный `@angular/forms` 22.2.3 в зависимостях `ui-angular`, которого нет в списке 4.7: без него `npm install` падает с ERESOLVE (peer `@angular/cdk` тянет forms 22.2.4). Тело ошибки не JSON даёт `HttpError(status, 'unknown')` вместо прежнего `SyntaxError` в кабинете (по 4.7 и AC-014-19). «Неудача — `onSignedOut`» из 4.7 трактуется так: `createRequest` отдаёт вызывающему 401, `onSignedOut` вызывает сам `AuthSessionKeeper` при неудачном `renew` (как в кабинете до переноса); поэтому `RequestSession` — только `accessToken` и `renew`. Строка T-1 перенесена сюда из таблицы 4.3, куда попала по ошибке |
| 2026-11-01 | `spec/014-t7` / `908e897` | T-7: скилл `frontend-design` (anthropics/skills, ca45fc4) в `.claude/skills/frontend-design`; `packages/ui-angular/styles/tokens.css` — токены 4.8 для обеих тем, обоснование в README пакета; `scripts/ui-config.test.ts` — первая часть AC-014-10 (контраст, #rrggbb, полнота токенов). В глоссарий добавлена строка «Дизайн-токены» | T-7 выполнил Sonnet, а не Haiku (Q-3). Скилл Impeccable не установлен: его `SKILL.md` и `audit` запускают лаунчер, который скачивает бинарник (D-132). Селекторы тёмной темы в `tokens.css` с одинарными кавычками (`[data-theme='dark']`): так требует prettier, для CSS это то же самое. Шрифты — системные стеки. Тёмная тема продублирована в двух селекторах (CSS не позволяет переиспользовать блок), тест сверяет, что значения совпадают |
| 2026-11-01 | `spec/014-t7` / `4516393` | T-8: `packages/ui-angular/styles/base.css` (стили из `index.html` кабинета на токенах), `src/theme.ts` (`ThemeService`), экспорт из `index.ts`; кабинет: `styles` в `angular.json` (`@swag/ui-angular/styles/*` резолвится по имени пакета), `<style>` из `index.html` удалён, `swarm-graph.ts` и `app.ts` на `var(--swag-…)`; `scripts/ui-config.test.ts` — вторая часть AC-014-10 (литералы в кабинете и пакете) | `ThemeService`: `mode` — signal, добавлен `setMode` (трактовка, D-133). Цвета статусов графа — `color-mix` от токенов, пастель не совпадает точно (D-134). Кнопки и ссылки кабинета — `--swag-color-primary` (замечание ревью: сначала стояли на `focus`; текст на кнопке `primary-text`, пара в тесте контраста); `focus` — только для обводки фокуса; шапка инвертирована (`text`/`bg`); размеры шрифтов и отступы — ближайшие токены (22→24 px, 17→18 px) |
| 2026-11-01 | `spec/014-t9` / 0fbd615 | T-9: `components/button.ts` (директива `button[swag-button]`: `variant`, `disabled`, `busy`), `components/field.ts` (`swag-field`: `label`, `error`), `components/card.ts` (`swag-card`: `title`), `components/alert.ts` (`swag-alert`: `kind`), экспорт из `index.ts`; фокус `:focus-visible` и варианты кнопок — в `styles/base.css` | Трактовка: `swag-button` сделан атрибутным селектором `button[swag-button]`, чтобы `type` остался нативным (submit в формах) без нового входа в 4.8. `swag-field` без директивы: после рендера компонент ставит `aria-describedby` и `aria-invalid` на проецируемый контрол (описано в README). Шаблоны компонентов `ng build` кабинета пока не компилирует (нет использования); проверятся в T-10. Вопросы на подтверждение: D-135 (`button[swag-button]`, `busy` как нативный `disabled`), D-136 (связка `swag-field` с ошибкой) |
| 2026-11-01 | `spec/014-t9` / c0fc54f | T-10: `components/table.ts` (`swag-table`, вход `empty`), `components/page.ts` (`swag-page`, `title`), `components/confirm.ts` (`swag-confirm`, `text`, `confirmed`, `cancelled`, на `@angular/cdk/dialog`), `guards.ts` (`ensureRestored`, `sessionGuard`, `areaGuard`), `balance-panel.ts` (`swag-balance-panel`, `orgId`, `requireComment`); кабинет: `balance.page.ts` — обёртка над панелью, `auth.guard.ts` удалён, маршрут за `canMatch: [sessionGuard]`; стили таблицы и оверлея — в `styles/base.css` | Трактовка: пустота `swag-table` определяется CSS `:has(tbody tr)`, вход только `empty` по 4.8. `swag-confirm` открывает диалог в `ngAfterViewInit` и закрывает в `ngOnDestroy`: в 4.8 нет входа «открыть», потребитель показывает компонент условно (`@if`). `ensureRestored` кэширует промис `restore()` навсегда, как в 4.7; токен проверяет `sessionGuard`. Тест на `ensureRestored` не написан: он берёт SESSION через `inject`, нужен injection context. `sessionGuard` — `canMatch`, не `canActivate`: `CanMatchFn` проверяется до загрузки remote (4.4). `requireComment` в кабинете = false (013, 4.11). `returnTo` в `/login` кабинета пока не читается: вход переезжает в каркас (T-11). Вопросы на подтверждение: D-137 (пустота `swag-table`), D-138 (открытие и закрытие `swag-confirm`), D-139 (кэш `ensureRestored`) |
| 2026-11-01 | `spec/014-t11` / 2e00e98 | T-11: `apps/ui/shell` (`@swag/shell`): `federation.config.mjs`, `angular.json`, `tsconfig*.json` из журнала T-1 (`spike-shell` переименован в `shell`); `main.ts` с `initFederation({})` и `bootstrap.ts`; `remote-registry.ts` (`RemoteRegistry`, `loadRoutes`); `app.routes.ts` по 4.4 (`/login`, раздел под `sessionGuard`, `admin` и `supervisor` под `areaGuard`, `cabinet` — `''`, `**` → `''`); `layout.ts` (`LayoutComponent`, шапка REQ-014-10); `app.ts` (`App`: тема, alert «Раздел недоступен» вне Layout, смена токена на `NavigationEnd`); `login.page.ts` (`/login?returnTo=` на `swag-field`, `swag-alert`, `button[swag-button]`); `public/federation.manifest.json` с `cabinet`; `proxy.conf.json` по 4.9; `Dockerfile`; `README.md`. В `package-lock.json` 33 новых пакета, версии существующих не менялись | Отклонения: (1) `ng serve --host 0.0.0.0 --port 4200` из 4.9 не работает: builder `serve` Native Federation не принимает `host`; `start` — `ng serve --configuration container`, host задаётся в `serve-original` (D-143); (2) в `skipList` добавлен `@angular/cdk/schematics`, без него сборка падает (D-141); (3) в `package.json` каркаса добавлены `@angular/cdk` и `@angular/forms` (D-142), `es-module-shims` зафиксирован точно: `2.8.4` вместо `^2.8.0` из T-1; (4) маршруты `/signup`, `/signup/confirm`, `/invite` и их страницы — T-14 (D-144); ссылка «Зарегистрировать компанию» на `/login` до T-14 ведёт на `**`; (5) `<meta name="referrer" content="no-referrer">` стоит в `index.html` каркаса уже в T-11, как требует REQ-014-9; (6) до T-12 раздел `/` показывает «Раздел недоступен»: remote `cabinet` не собран, это ожидаемо по плану задач; (7) `main.ts` и `bootstrap.ts` — два файла (D-145). Трактовка: смена токена перечитывает `AuthMe` на `NavigationEnd`, события смены токена в `AuthSessionKeeper` нет (D-146) |
| 2026-11-01 | `spec/014-state` | Дополнение по Q-9 (решение человека): сторы `ui-core` на `@preact/signals-core` и мост `connectStore` в `@swag/ui-angular` — REQ-014-23…25, раздел 4.12, AC-014-21…27, задачи T-21…T-25, правки T-14…T-17. Спека заблокирована до подтверждения дополнения человеком. D-139 и D-146 сняты: поведение задано в 4.12 (`restore()` и перечитывание `AuthMe` при смене токена) | Разделы 2–8 изменены по решению человека, не агентом самостоятельно: правило 1 `CLAUDE.md` |
| 2026-11-01 | `spec/014-state` | Человек подтвердил дополнение 4.12 с мостом `connectStore`. Спека снова в работе: следующие этапы T-21…T-25, затем T-12…T-20 | — |
| 2026-11-01 | `spec/014-t21` / 44303f4 | T-21: `@preact/signals-core` 1.14.5 в `ui-core`; `arch:check` пускает его только в `ui-core` и без подпутей (`UI_CORE_EXTRA_PACKAGES`); порты `BalanceApi`, `MeApi`, `Preferences`; `createSessionUserStore`, тип `SessionStatus`. Тесты AC-014-21 (`packages/ui-core/test/session-user.store.test.ts`), AC-014-26 часть `arch-check`. Трактовки на подтверждение: D-147 (сбой `MeApi.me`), D-148 (`AuthMe` дважды `null` после renew) | Исключение для preact записано в правило 1 «Правила ядра» (белый список), а не в правило 2, как в 4.12: правило 2 — про фреймворки, белый список — правило 1 |
| 2026-11-01 | `spec/014-t22` / 3d548f9 | T-22: `createBalanceState` (`balance.state.ts`), `createShellStore` (`shell.store.ts`), тип `ThemeMode`; `formatUsd` и `usdToMicro` вынесены в `money.ts` без смены API. Тесты AC-014-27, AC-014-22. Трактовки: зависимости сторов — узкие `Pick<SessionUserStore, …>`; устаревший ответ баланса отбрасывается по счётчику поколений, в том числе на ошибке и у `more`; `open` сбрасывает и `loadingMore`, `submitting`; `topup` после смены организации её не перечитывает; повторные `more` и `topup` в полёте игнорируются; исключение сессии в `ShellStore` даёт `authErrorText('unknown')`; `register` возвращает `Promise<void>` | Стейл-проверка баланса на ошибке — как требует 4.12; прежняя панель проверяла только успех |

### T-1. Итоги проверки федерации

**Пакеты** (точные версии, во всех фронтендах):
- `@angular-architects/native-federation` 22.2.4 — последняя 22.2.x, peer `@angular/build ~22.2.0`, `@angular/localize ~22.2.0`; тянет `@softarc/native-federation` 4.9.0;
- `@softarc/native-federation-orchestrator` 4.9.0 — схематик пишет `^4.8.0`, версия фиксируется;
- `@angular/localize` 22.2.3 — обязательный peer;
- `@angular/compiler-cli` 22.2.3 — явно, иначе `npm install` падает с ERESOLVE: peer `@angular/build` тянет compiler-cli 22.2.4, который требует `@angular/compiler` 22.2.4.

**`federation.config.mjs` remote** (у каркаса тот же, `name` свой и без `exposes`):

```js
import {
  withNativeFederation,
  shareAll,
  mappingsFromWorkspace,
  NG_SKIP_LIST,
} from '@angular-architects/native-federation/config';

const skipList = [
  ...NG_SKIP_LIST,
  'rxjs/ajax',
  'rxjs/fetch',
  'rxjs/testing',
  'rxjs/webSocket',
  /^@angular\/(build|cli|compiler-cli)(\/|$)/,
  /^@swag\//,
];

export default withNativeFederation({
  name: 'cabinet',
  exposes: { './routes': './src/app/routes.ts' },
  shared: shareAll({ singleton: true, strictVersion: true, requiredVersion: 'auto' }, { skipList }),
  sharedMappings: mappingsFromWorkspace({ singleton: true, strictVersion: true })
    .filter(['@swag/ui-angular', '@swag/ui-core', '@swag/contracts'])
    .get(),
  features: { ignoreUnusedDeps: false },
});
```

Почему так:
- `/^@swag\//` в `skipList` обязателен. Иначе `@swag/*` попадают в shared дважды — как npm-пакет и как mapping. npm-копия собирается без AOT, и каркас падает: «injectable 'CurrentUser' needs to be compiled using the JIT compiler».
- `@swag/*` нельзя класть в верхнеуровневый `skip`: он вырезает и mappings, пакеты попадают в каждое приложение своей копией. Шаблон `'@swag/*'` не работает — только строки, регулярки и функции.
- `ignoreUnusedDeps: false`: `angular.json` в каталоге фронтенда делает его корнем, и сканер неиспользуемых зависимостей падает на файлах `packages/*` («is outside of root»). Поэтому `shareAll` публикует все пакеты из `package.json`, и сборочные исключены в `skipList`.

**tsconfig.json фронтенда** — `paths`, по ним `mappingsFromWorkspace` находит пакеты (без них mappings пустые):

```json
"paths": {
  "@swag/ui-angular": ["../../../packages/ui-angular/src/index.ts"],
  "@swag/ui-core": ["../../../packages/ui-core/src/index.ts"],
  "@swag/contracts": ["../../../packages/contracts/src/index.ts"]
}
```

Схематик `ng g @angular-architects/native-federation:init --type host|remote --port N` добавляет `tsconfig.federation.json` (расширяет `tsconfig.app.json`, `include: ["src/**/*.d.ts"]`).

**angular.json** после схематика:
- `build` и `serve` — билдер `@angular-architects/native-federation:build`; прежние `@angular/build:application` и `@angular/build:dev-server` переезжают в `esbuild` и `serve-original`, в `esbuild` добавлен полифил `es-module-shims`;
- remote: в `serve` — `"baseHref": "/mf/<имя>/"`, без него `remoteEntry.json` и чанки отдаются от `/`, а по `/mf/<имя>/` — 404; в `serve-original` — `port`, `host`, `"servePath": "/mf/<имя>/"`;
- каркас: в `esbuild.options.assets` — `{ "glob": "**/*", "input": "public" }`, иначе `public/federation.manifest.json` не отдаётся; в `serve-original` — `"proxyConfig": "proxy.conf.json"`, `host`, `port`;
- схематик не перезаписывает `main.ts` хоста, а у remote заменяет его вариантом с `hostRemoteEntry`.

`proxy.conf.json` каркаса: `{ "/mf/cabinet": { "target": "http://127.0.0.1:4201", "secure": false, "changeOrigin": false } }`.

**Итоги проверок** (браузерная панель, `ng serve` обоих на 127.0.0.1):
1. Ленивость — прошло: на `/` запросов к `/mf/*`, `routes.js` и манифесту нет; после перехода — `/federation.manifest.json`, `/mf/cabinet/remoteEntry.json`, `/mf/cabinet/routes.js`, все 200.
2. Один экземпляр — прошло: `InjectionToken`, экземпляр `@Injectable`-сервиса и модульная константа заглушки `@swag/ui-angular` в каркасе и remote совпадают; функция `@swag/ui-core` одна.
3. `servePath` за прокси — прошло: браузер ходит только на порт каркаса, `changeOrigin: false` работает, `allowedHosts` для Host `127.0.0.1:4200` не нужен.
4. Workspace-пакеты — прошло: `remoteEntry.json` каркаса и remote содержат `@swag/contracts`, `@swag/ui-angular`, `@swag/ui-core` с `singleton` и `strictVersion` в AOT-сборке; `ng build` обоих без ошибок.
5. Команда проверки экземпляра — работает, вывод `{"ui-angular":1,"ui-core":1,"angular-core":1,"in-remote":[]}`.

**Команда для консоли браузера (AC-014-16)**, после перехода на маршрут remote; ожидается три единицы и пустой `in-remote`:

```js
(() => { const n = performance.getEntriesByType('resource').map(r => new URL(r.name).pathname); const c = (re) => new Set(n.filter(p => re.test(p))).size; return JSON.stringify({ 'ui-angular': c(/\/_swag_ui_angular(\.[^/_]*)?\.js$/), 'ui-core': c(/\/_swag_ui_core(\.[^/_]*)?\.js$/), 'angular-core': c(/\/_angular_core(\.[^/_]*)?\.js$/), 'in-remote': n.filter(p => p.startsWith('/mf/') && /_swag_|_angular_/.test(p)) }); })()
```

В dev-сборке имена файлов содержат `-dev` и хэш; регулярку уточнить в T-11 по выводу продакшен-сборки.

**Не проверено в T-1** (проверяется в T-11…T-13): compose и Host вида `ui:4200` у remote (при отказе — `allowedHosts` по 4.9), `--host 0.0.0.0`, несколько remote сразу, guard'ы, `RemoteRegistry` и `isLocalRemoteUrl`.
