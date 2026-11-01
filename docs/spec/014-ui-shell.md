---
id: "014"
title: "UI: каркас с регистрацией и входом, микрофронтенды кабинета, админки и супервизора"
status: draft
roadmap_stage: 5
depends_on: ["012", "024", "013"]
superseded_by: null
updated: 2026-11-01
---

# 014. UI: каркас с регистрацией и входом, микрофронтенды кабинета, админки и супервизора

> **Коротко.**
> - **Каркас `apps/ui/shell`.** Компания регистрируется в браузере: email → письмо → пароль и название → кабинет. Приглашённый пользователь задаёт пароль по ссылке из письма. Вход, выход и навигация живут в каркасе. Каркас подгружает микрофронтенды по правам пользователя из `GET /auth/me`.
> - **Три микрофронтенда.**
>   - `cabinet` — нынешние рои и баланс, без своей страницы входа.
>   - `admin` — пользователи организации: приглашение, смена роли, блокировка.
>   - `supervisor` — организации платформы, их пользователи, их баланс с пополнением.
> - **Права в интерфейсе** вычисляет `ui-core` одной функцией. Микрофронтенд, на который у пользователя нет прав, не загружается вовсе. Доступ по-прежнему проверяет API, интерфейс только прячет.
> - **Новое API не нужно.** Все экраны работают на эндпоинтах 012, 024 и 013. Меняются только адреса страниц в письмах: `/signup/confirm` и `/invite` вместо `/auth/confirm` и `/auth/invite`, потому что `/auth/*` прокси отдаёт identity.
> - **Общий стиль.** У всех фронтендов одни дизайн-токены и базовые компоненты, светлая и тёмная тема.
> - **Решить человеку (раздел 9):**
>   - чем собирать микрофронтенды (Q-1, из D-11);
>   - где живёт общий Angular-код (Q-2);
>   - дизайн-система и скилл дизайна (Q-3, из D-16);
>   - кто видит Grafana (Q-4, из D-15);
>   - порядок со спекой мультиорганизаций (Q-5, D-131);
>   - рои и расходы по пользователям (Q-6);
>   - экран счёта платформы (Q-7, из D-38);
>   - порог размера бандла (Q-8).
>
>   По каждому вопросу дана рекомендация. Разделы 4–8 написаны под рекомендованные варианты. Другой ответ — правка этих разделов до `ready`.

## 1. Контекст и цель

Закрывает пункт «UI: каркас с регистрацией и входом, микрофронтенды — кабинет, админка организации, супервизор» этапа 5 [роадмапа](../../AI_PLATFORM_ROADMAP.md#8-пользователи-доступ-и-баланс) (раздел «Фронтенды»).

**Сейчас.**
- Есть один фронтенд — `apps/ui/cabinet`, самостоятельное приложение.
- В нём страница входа, рои и баланс.
- Регистрацию компании, подтверждение email и принятие приглашения можно пройти только через `curl` и Mailpit: ссылки в письмах ведут на страницы, которых нет.
- Управлять пользователями и смотреть организации можно только через API.

**Цель.**
- Каркас `apps/ui/shell` с регистрацией, подтверждением, приглашением, входом и навигацией.
- Три микрофронтенда, которые собираются и запускаются независимо. Каркас подгружает их во время работы по правам из `GET /auth/me`.
- Сценарий S-1 проходится в браузере целиком.

## 2. Объём

**Входит:**
- `apps/ui/shell` — каркас:
  - страницы `/login`, `/signup`, `/signup/confirm`, `/invite`;
  - шапка с навигацией и выходом;
  - загрузка микрофронтендов по манифесту и правам.
- `apps/ui/cabinet` становится микрофронтендом: экраны роёв и баланса без изменения поведения, страница входа и общая шапка уходят в каркас.
- `apps/ui/admin` — пользователи своей организации:
  - список;
  - приглашение с ролью;
  - смена роли `user` ↔ `admin`;
  - блокировка и разблокировка.
- `apps/ui/supervisor`:
  - список организаций;
  - страница организации: её пользователи с блокировкой, её баланс, история и пополнение.
- `ui-core`:
  - регистрация, подтверждение и приглашение в сессии;
  - тексты ошибок;
  - навигация и доступ к разделам по `AuthMe`;
  - порты пользователей и организаций;
  - действия над пользователем.
- Общий Angular-пакет (Q-2): сессия, текущий пользователь, адаптеры портов на `fetch`, дизайн-токены, базовые компоненты.
- Дизайн-токены, светлая и тёмная темы, базовые компоненты (Q-3).
- Compose: каркас на `UI_PORT`, микрофронтенды без опубликованных портов за прокси каркаса.
- Новые адреса `IDENTITY_CONFIRM_URL` и `IDENTITY_INVITE_URL` в `.env.example` и `.env`.
- Запуск UI на хосте с горячей перезагрузкой (из N-6).
- Ручной прогон S-1 в браузере.

**Не входит** (агент это не делает, даже если кажется логичным):
- **Несколько организаций у пользователя**, переключатель организации, создание второй организации из кабинета — спека по D-131 (Q-5). В 014 у пользователя одна организация из `AuthMe.organization`.
- **Новые эндпоинты и поля API**: рои и расходы по пользователям, `createdBy` и траты в списке роёв (Q-6).
- **Счёт платформы супервизора**: поступления, расходы у провайдеров, маржа (Q-7, D-38) — спека 025.
- **Восстановление и смена пароля** (D-112). Профиль пользователя.
- **Вход через Google или SSO.**
- **Лендинг `apps/ui/landing`.**
- **Продакшен-сборка и деплой фронтендов**: статика за nginx, CDN, манифест на окружение. В 014 только dev-серверы, как в 001.
- **Вход в Grafana и её роли** (Q-4) — спека эксплуатации.
- **Журнал ошибок на экране супервизора** (D-88).
- **Редизайн экранов роя**: граф, лента, форма. Они только переходят на токены и базовые компоненты (REQ-014-17), раскладка и поведение прежние.
- **Браузерные e2e-автотесты** (Playwright и т. п.). Экраны проверяются вручную (AC `[manual]`), логика — тестами `ui-core`.
- **Локализация**: интерфейс только на русском.

## 3. Требования

| ID | Требование | Приоритет |
|---|---|---|
| REQ-014-1 | Каркас `apps/ui/shell` MUST быть отдельным фронтендом и отдельным npm-workspace `@swag/shell`. Он отдаёт страницы входа, регистрации, подтверждения, приглашения и общую шапку, остальные экраны подгружает из микрофронтендов. | MUST |
| REQ-014-2 | Микрофронтенды `cabinet`, `admin`, `supervisor` MUST собираться и запускаться независимо от каркаса и друг от друга: свой workspace, свой dev-сервер и свой сервис compose. Каркас MUST находить их адреса только по манифесту 4.4, а не по импорту исходников. | MUST |
| REQ-014-3 | Каркас MUST загружать код микрофронтенда только при входе в его раздел и только когда `canOpen` (4.2) разрешает этот раздел текущему `AuthMe`. Код раздела, на который прав нет, MUST не запрашиваться с сервера. | MUST |
| REQ-014-4 | Навигация, доступ к разделам и видимость форм MUST вычисляться из `GET /auth/me` (`AuthMe`), а не из claims токена (D-130). `AuthMe` перечитывается при смене токена доступа и сбрасывается при выходе, как в 013. | MUST |
| REQ-014-5 | Без сессии MUST открываться только `/login`, `/signup`, `/signup/confirm`, `/invite`. Любой другой адрес ведёт на `/login`, исходный адрес передаётся в параметре `returnTo`, после входа пользователь попадает на него. `returnTo` принимается, только если это путь этого же приложения: начинается с одного `/` и не содержит `//` и `\`. Иначе после входа открывается `/`. | MUST |
| REQ-014-6 | `/signup` MUST принимать email и вызывать `POST /auth/registrations`. На `202` MUST показывать одно и то же сообщение 4.6 независимо от того, есть ли такой email. Ошибки — тексты 4.6 по коду. | MUST |
| REQ-014-7 | `/signup/confirm?token=` MUST принимать пароль, повтор пароля и название организации и вызывать `POST /auth/registrations/confirm`. На `201` сессия MUST устанавливаться так же, как после входа, и открываться `/`. Пароль проверяется схемой `Password`, название — `OrganizationName`, совпадение повтора — до запроса. | MUST |
| REQ-014-8 | `/invite?token=` MUST принимать пароль и повтор и вызывать `POST /auth/invitations/accept`. На `201` — сессия и `/`, как в REQ-014-7. | MUST |
| REQ-014-9 | Страницы `/signup/confirm` и `/invite` MUST после чтения токена убирать его из адресной строки через `history.replaceState`, не передавать в `Referer` (`<meta name="referrer" content="no-referrer">` в каркасе) и не писать токен в лог и консоль. При `400 invalid_token` MUST показывать текст 4.6 и ссылку на `/signup` (для приглашения — текст без ссылки). | MUST |
| REQ-014-10 | Шапка каркаса MUST показывать пункты `navigationFor(me)` (4.2), email пользователя, название организации (если есть) и кнопку «Выйти». Выход вызывает `logout`, сбрасывает `AuthMe` и открывает `/login`. | MUST |
| REQ-014-11 | Микрофронтенд `cabinet` MUST сохранить адреса и поведение экранов 001, 004, 013, 022, 030, 031: `/`, `/swarms/new`, `/swarms/:id`, `/balance`. Своей страницы входа и шапки у него MUST не быть. | MUST |
| REQ-014-12 | Микрофронтенд `admin` (`/admin/users`) MUST показывать пользователей своей организации из `GET /auth/users`: email, роль, «заблокирован», дату создания. Форма приглашения (email, роль `user` или `admin`) MUST вызывать `POST /auth/invitations`. В строке пользователя MUST быть ровно те действия, которые разрешает `userActions` (4.2). После успешного действия список перечитывается. | MUST |
| REQ-014-13 | Микрофронтенд `supervisor` MUST показывать организации из `GET /auth/organizations` (`/supervisor`): название, число пользователей, дату создания. Страница организации `/supervisor/organizations/:orgId` MUST показывать: пользователей из `GET /auth/users?orgId=` с действиями `userActions`; баланс и историю из `GET /organizations/:orgId/balance` и `…/entries`; форму пополнения `POST /organizations/:orgId/balance/topups` по правилам формы 013, 4.11. | MUST |
| REQ-014-14 | Ответ API `401` во всех фронтендах MUST вести к одному `renew()` и одному повтору, неудача — к выходу на `/login`, как в 024, 4.15. На `403 forbidden` экран MUST показывать текст 4.6 и не выходить из сессии. | MUST |
| REQ-014-15 | Сессия, текущий пользователь и адаптеры API MUST существовать на странице в одном экземпляре на каркас и все загруженные микрофронтенды: один `AuthSessionKeeper`, один токен в памяти, один `refresh` на одновременные `401`. Токен MUST не попадать в `localStorage`, `sessionStorage`, cookie, доступные скрипту, и в адреса. | MUST |
| REQ-014-16 | Все фронтенды MUST использовать общие дизайн-токены 4.8 (цвета, шрифты, отступы, радиусы) через CSS custom properties. Тема — светлая или тёмная по `prefers-color-scheme`, у переключателя в шапке три положения: «как в системе», «светлая», «тёмная». Выбор хранится в `localStorage`, ключ `swag.theme`. | MUST |
| REQ-014-17 | Формы, кнопки, поля с ошибкой, таблицы и сообщения во всех фронтендах MUST строиться из базовых компонентов 4.8. Экраны `cabinet` переходят на них без изменения поведения. | MUST |
| REQ-014-18 | Ссылку «трейс» в ленте роя MUST видеть только супервизор (Q-4). Прокси `/grafana` в dev остаётся. | MUST |
| REQ-014-19 | `IDENTITY_CONFIRM_URL` и `IDENTITY_INVITE_URL` MUST в dev указывать на `http://127.0.0.1:${UI_PORT}/signup/confirm` и `…/invite` в `.env.example` и `.env`. | MUST |
| REQ-014-20 | Команда `npm run ui:dev` MUST запускать каркас и три микрофронтенда на хосте с горячей перезагрузкой. Прокси при этом ведут на опубликованные порты контура на `127.0.0.1`. Остальной контур поднимается `npm run up` (из N-6). | MUST |
| REQ-014-21 | Интерактивные элементы базовых компонентов SHOULD быть доступны с клавиатуры. У них SHOULD быть видимый фокус и подписи (`label`, `aria-*`). Контраст текста и фона в обеих темах SHOULD быть не ниже WCAG 2.2 AA (4.5:1). | SHOULD |

## 4. Контракты

Разделы 4.3–4.5 написаны под рекомендацию Q-1 (Native Federation), 4.7 — под рекомендацию Q-2 (`@swag/ui-angular`), 4.8 — под рекомендацию Q-3.

### 4.1. `@swag/ui-core`: сессия — регистрация и приглашение

Порт `AuthApi` из 024, 4.15 дополняется. Адаптер на `fetch` — 4.7.

```ts
import type { AuthSession, InvitationAcceptRequest, RegistrationConfirmRequest } from '@swag/contracts';

export interface AuthApi {
  // как в 024, 4.15: login, refresh, logout
  register(email: string): Promise<void>;                                     // POST /auth/registrations, 202; reject с кодом — неудача
  confirmRegistration(body: RegistrationConfirmRequest): Promise<AuthSession>; // POST /auth/registrations/confirm, 201
  acceptInvitation(body: InvitationAcceptRequest): Promise<AuthSession>;       // POST /auth/invitations/accept, 201
}

export type AuthResult = { ok: true } | { ok: false; code: string };

export interface AuthSessionKeeper {
  // как в 024, 4.15: restore, login, logout, accessToken, renew, onSignedOut
  register(email: string): Promise<AuthResult>;
  confirmRegistration(body: RegistrationConfirmRequest): Promise<AuthResult>;
  acceptInvitation(body: InvitationAcceptRequest): Promise<AuthResult>;
}
```

Правила:
- `confirmRegistration` и `acceptInvitation` при успехе ставят токен доступа и увеличивают поколение сессии (`epoch`) так же, как `login`.
- `register` токен не трогает.
- Код ошибки берётся как у `login`: `error.code`, иначе `'unknown'`.
- Тип возврата `login` переименовывается в `AuthResult`, форма не меняется.

### 4.2. `@swag/ui-core`: доступ к разделам, навигация, действия

Файл `src/access-ui.ts`, реэкспорт из `src/index.ts`. Чистые функции от `AuthMe`; права — `ROLE_PERMISSIONS` из `@swag/contracts`.

```ts
import type { AuthMe, ManagedUser } from '@swag/contracts';

export const UiArea = z.enum(['swarms', 'balance', 'admin', 'supervisor']);
export type UiArea = z.infer<typeof UiArea>;

export type NavItem = { area: UiArea; label: string; path: string };

export function canOpen(area: UiArea, me: AuthMe | null): boolean;
export function navigationFor(me: AuthMe | null): NavItem[]; // порядок — как в таблице ниже, только canOpen = true

export type UserAction = 'make_admin' | 'make_user' | 'block' | 'unblock';
export function userActions(me: AuthMe, target: ManagedUser): UserAction[]; // порядок — как в перечислении
```

| `area` | `label` | `path` | `canOpen` — `true`, когда |
|---|---|---|---|
| `swarms` | Рои | `/` | есть `swarm.read` |
| `balance` | Баланс | `/balance` | есть `balance.read` и `me.organization !== null` |
| `admin` | Админка | `/admin/users` | есть `user.manage` и `role = 'admin'` |
| `supervisor` | Организации | `/supervisor` | есть `organization.read` |

`me = null` — `canOpen` всегда `false`, `navigationFor` — `[]`.

`userActions(me, target)`:
- пустой список, если `target.id = me.user.id`, `target.role = 'supervisor'` или у `me` нет `user.manage`;
- `admin`: пустой список для пользователя другой организации (`target.orgId !== me.organization?.id`);
- иначе `make_admin`, если `target.role = 'user'`; `make_user`, если `target.role = 'admin'`; `block`, если `!target.blocked`; `unblock`, если `target.blocked`.

Это зеркало правил `PATCH /auth/users/:id` из 024, 4.7. Решает по-прежнему identity.

Действие → тело `PATCH`: `make_admin` → `{ role: 'admin' }`, `make_user` → `{ role: 'user' }`, `block` → `{ blocked: true }`, `unblock` → `{ blocked: false }`. Функция `userActionBody(action): UserUpdate`.

### 4.3. `@swag/ui-core`: порты пользователей и организаций

```ts
import type { InvitationRequest, ManagedUser, OrganizationList, UserList, UserUpdate } from '@swag/contracts';

export interface UsersApi {
  list(orgId: string | null): Promise<UserList>;       // GET /auth/users[?orgId=]
  invite(body: InvitationRequest): Promise<void>;      // POST /auth/invitations, 202
  update(id: string, body: UserUpdate): Promise<ManagedUser>; // PATCH /auth/users/:id
}
export interface OrganizationsApi {
  list(): Promise<OrganizationList>;                   // GET /auth/organizations
}
```

Ошибка — reject с `code` из тела (`error.code`, иначе `'unknown'`), как в `AuthApi`. Повтор после `401` делает адаптер (REQ-014-14).

### 4.4. Манифест микрофронтендов

Файл `apps/ui/shell/public/federation.manifest.json` — формат Native Federation, имя remote → адрес `remoteEntry.json`:

```json
{
  "cabinet": "/mf/cabinet/remoteEntry.json",
  "admin": "/mf/admin/remoteEntry.json",
  "supervisor": "/mf/supervisor/remoteEntry.json"
}
```

- Адреса только относительные, того же origin.
- Каркас грузит манифест при старте (`initFederation('/federation.manifest.json')`) и не принимает адрес, который не начинается с `/mf/`: такой remote не регистрируется, в консоль — предупреждение `remote_rejected` с именем remote.
- Проверка адреса — функция `ui-core` `isLocalRemoteUrl(url): boolean`.

Каждый микрофронтенд экспонирует один модуль `./routes` — массив `Routes` Angular:

| Remote | Префикс в каркасе | Маршруты remote |
|---|---|---|
| `cabinet` | `''` | `''`, `swarms/new`, `swarms/:id`, `balance` |
| `admin` | `admin` | `users` |
| `supervisor` | `supervisor` | `''`, `organizations/:orgId` |

Каркас подключает remote через `loadRemoteModule(name, './routes')` в `loadChildren`. Защита — `canMatch` с `canOpen` для раздела:
- маршрут `admin` → `admin`;
- маршрут `supervisor` → `supervisor`;
- в `cabinet` маршрут `balance` → `balance`, остальное → `swarms`.

`canMatch` не пускает — Angular не вызывает `loadChildren`, код remote не запрашивается (REQ-014-3). Пользователь уходит на `/`. `swarm.read` есть у всех трёх ролей, поэтому `/` открыт любому вошедшему.

### 4.5. Общие зависимости федерации

`federation.config.js` каркаса и каждого remote: `shareAll({ singleton: true, strictVersion: true, requiredVersion: 'auto' })`. Отдельно явно — `@swag/ui-angular`, `@swag/ui-core`, `@swag/contracts` как `singleton: true`.

Так на странице одна копия Angular, одна копия общего пакета и, значит, один `SESSION` и один `CurrentUser` (REQ-014-15). Версии Angular во всех четырёх `package.json` одинаковые и точные.

### 4.6. Тексты

Константы `ui-core`, функция `authErrorText(code: string): string`; неизвестный код — «Что-то пошло не так. Попробуйте ещё раз.».

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

Прочие тексты:
- `/signup` после `202`: «Если адрес верный, мы отправили на него письмо со ссылкой. Откройте его, чтобы закончить регистрацию.»
- `/invite` с `invalid_token`: «Приглашение недействительно или устарело. Попросите администратора прислать новое.»
- `admin` после приглашения: «Приглашение отправлено на <email>.»
- Подтверждение действий: `block` — «Заблокировать <email>? Его сессии завершатся, рои остановятся.» Остальные действия — без подтверждения.
- Подписи действий: `make_admin` — «Сделать администратором», `make_user` — «Сделать пользователем», `block` — «Заблокировать», `unblock` — «Разблокировать».
- Ошибка поля «повтор пароля»: «Пароли не совпадают.»

### 4.7. Общий Angular-пакет `@swag/ui-angular`

Каталог `packages/ui-angular`. Это оболочечный код, общий для фронтендов, а не ядро: в нём можно Angular и DOM, `arch:check` не относит его к ядрам. Содержимое:

| Файл `src/` | Что | Откуда |
|---|---|---|
| `session.ts` | `SESSION`, `CurrentUser` | перенос из `apps/ui/cabinet/src/app/session.ts` без изменения поведения |
| `auth-api.ts` | адаптер `AuthApi` на `fetch` (4.1) | перенос и дополнение `apps/ui/cabinet/src/app/auth-api.ts` |
| `http.ts` | общий запрос с `Authorization: Bearer`, `renew()` и одним повтором на `401`, разбор `error.code` | вынос из `apps/ui/cabinet/src/app/api.ts` |
| `users-api.ts` | адаптеры `UsersApi`, `OrganizationsApi` (4.3) | новое |
| `balance-api.ts` | `createBalanceApi` | перенос из `api.ts` кабинета |
| `guards.ts` | `areaGuard(area)` — `CanMatchFn` на `canOpen` и `CurrentUser.ensure()` | новое |
| `theme.ts` | переключатель темы (REQ-014-16) | новое |
| `components/` | базовые компоненты 4.8 | новое |
| `styles/tokens.css` | дизайн-токены 4.8 | новое |

API роёв (`createSwarmsApi`, `createSwarmStream`) остаётся в `cabinet`: им пользуется только он.

### 4.8. Дизайн-токены и базовые компоненты

Написано под рекомендацию Q-3.

**Токены** — CSS custom properties в `styles/tokens.css`. Значения для светлой темы — в `:root`, для тёмной — в `[data-theme="dark"]` и в `@media (prefers-color-scheme: dark)` под `:root:not([data-theme="light"])`.

Имена токенов:
- цвета: `--swag-color-bg`, `--swag-color-surface`, `--swag-color-text`, `--swag-color-text-muted`, `--swag-color-border`, `--swag-color-primary`, `--swag-color-primary-text`, `--swag-color-danger`, `--swag-color-success`, `--swag-color-focus`;
- шрифты: `--swag-font-sans`, `--swag-font-mono`;
- размер текста: `--swag-text-sm`, `--swag-text-md`, `--swag-text-lg`, `--swag-text-xl`;
- отступы: `--swag-space-1` … `--swag-space-6`;
- радиусы: `--swag-radius-sm`, `--swag-radius-md`;
- тень: `--swag-shadow-1`.

Конкретные значения выбирает реализация скиллом дизайна из Q-3 и записывает в README пакета. Пары текст/фон проходят контраст REQ-014-21.

Базовые компоненты — standalone, префикс `swag-`:

| Компонент | Назначение |
|---|---|
| `swag-button` | `variant: 'primary' \| 'secondary' \| 'danger'`, `disabled`, `busy` |
| `swag-field` | подпись, слот поля, текст ошибки (`aria-describedby`) |
| `swag-card` | блок с заголовком |
| `swag-table` | таблица со строкой «пусто» |
| `swag-alert` | `kind: 'error' \| 'info' \| 'success'`, `role="alert"` для ошибки |
| `swag-page` | заголовок страницы и область содержимого |
| `swag-confirm` | диалог подтверждения: текст, «Подтвердить», «Отмена» |

### 4.9. Compose и dev-серверы

| Сервис | Образ | Порт | Что |
|---|---|---|---|
| `ui` | `apps/ui/shell/Dockerfile` | `127.0.0.1:${UI_PORT}:4200` | каркас, `ng serve` |
| `ui-cabinet` | `apps/ui/cabinet/Dockerfile` | не публикуется, 4201 в сети compose | remote |
| `ui-admin` | `apps/ui/admin/Dockerfile` | не публикуется, 4202 | remote |
| `ui-supervisor` | `apps/ui/supervisor/Dockerfile` | не публикуется, 4203 | remote |

Прокси каркаса `apps/ui/shell/proxy.conf.json`:
- `/api`, `/auth`, `/grafana` — как сейчас у кабинета;
- `/mf/cabinet` → `http://ui-cabinet:4201`, `/mf/admin` → `http://ui-admin:4202`, `/mf/supervisor` → `http://ui-supervisor:4203`, без `pathRewrite`.

Каждый remote отдаётся с `servePath` / `baseHref` `/mf/<имя>/`. `/internal` не проксируется.

У `ui` — `depends_on` с `condition: service_healthy` на `api`, `identity` и три remote. Healthcheck remote — `wget` своего `remoteEntry.json`.

**На хосте (REQ-014-20).**
- `npm run ui:dev` — четыре `ng serve` с `--host 127.0.0.1` на портах `UI_PORT`, `UI_CABINET_PORT`, `UI_ADMIN_PORT`, `UI_SUPERVISOR_PORT`.
- Прокси каркаса — `apps/ui/shell/proxy.host.conf.mjs`, адреса берёт из env:
  - `/api` → `127.0.0.1:${API_PORT}`;
  - `/auth` → `127.0.0.1:${IDENTITY_PORT}`;
  - `/grafana` → `127.0.0.1:${GRAFANA_PORT}`;
  - `/mf/<имя>` → `127.0.0.1:${UI_<ИМЯ>_PORT}`.
- Перед `ui:dev` сервис `ui` контура останавливается (`docker compose stop ui`), иначе `UI_PORT` занят. Команда пишет это в README.

### 4.10. env

`.env.example` и `.env`:

```
UI_CABINET_PORT=4201
UI_ADMIN_PORT=4202
UI_SUPERVISOR_PORT=4203
IDENTITY_CONFIRM_URL=http://127.0.0.1:4200/signup/confirm   # было /auth/confirm (012, 4.10; изменено спекой 014)
IDENTITY_INVITE_URL=http://127.0.0.1:4200/invite            # было /auth/invite (024, 4.14; изменено спекой 014)
```

`UI_*_PORT` нужны только `ui:dev` на хосте. В compose remote слушают фиксированные порты 4201–4203.

### 4.11. Маршруты каркаса

| Путь | Сессия | Что |
|---|---|---|
| `/login?returnTo=` | нет (есть — на `/`) | вход, ссылка «Зарегистрировать компанию» на `/signup` |
| `/signup` | нет | email, отправка, сообщение 4.6; ссылка «Уже есть аккаунт» на `/login` |
| `/signup/confirm?token=` | нет | пароль, повтор, название организации |
| `/invite?token=` | нет | пароль, повтор |
| `''` (и всё remote `cabinet`) | да | `loadChildren` `cabinet` |
| `admin/**` | да | `loadChildren` `admin` |
| `supervisor/**` | да | `loadChildren` `supervisor` |
| `**` | — | на `/` |

Есть ли сессия, решает `restore()` при старте: guard ждёт его и `CurrentUser.ensure()`. `/signup/confirm` и `/invite` при уже открытой сессии сначала вызывают `logout()` и только потом показывают форму: ссылка из письма относится к другому человеку или новой организации.

## 5. Критерии приёмки

- **AC-014-1** — *Given* `AuthApi`-заглушка *When* `confirmRegistration` и `acceptInvitation` с `201` *Then* `accessToken()` — токен из ответа, результат `{ ok: true }`. *When* ответ — reject с `invalid_token` *Then* `{ ok: false, code: 'invalid_token' }`, токен прежний. *When* `register` с `202` и с reject `rate_limited` *Then* `{ ok: true }` и `{ ok: false, code: 'rate_limited' }`, токен не меняется. *When* `refresh`, начатый до `confirmRegistration`, отвечает после *Then* его токен не записывается (поколение 4.1).
- **AC-014-2** — *Given* `AuthMe` ролей `user`, `admin`, `supervisor` и `null` *When* `canOpen` для каждой `UiArea` и `navigationFor` *Then* результаты по таблице 4.2. Супервизор без организации не видит `balance`. Пункты идут в порядке таблицы.
- **AC-014-3** — *Given* `me` администратора организации A *When* `userActions` для:
  - себя;
  - супервизора;
  - пользователя организации B;
  - `user` A;
  - `admin` A;
  - заблокированного `user` A

  *Then* `[]`, `[]`, `[]`, `['make_admin', 'block']`, `['make_user', 'block']`, `['make_admin', 'unblock']`. *Given* супервизор *When* для `admin` организации B *Then* `['make_user', 'block']`. *Given* `user` *When* для любого *Then* `[]`. `userActionBody` для каждого действия — тело 4.2, оно проходит схему `UserUpdate`.
- **AC-014-4** — *Given* `authErrorText` *When* каждый код таблицы 4.6 и неизвестный код *Then* тексты таблицы и текст по умолчанию.
- **AC-014-5** — *Given* `isLocalRemoteUrl` *When*:
  - `/mf/admin/remoteEntry.json`;
  - `https://evil.example/remoteEntry.json`;
  - `//evil.example/x.json`;
  - `/mf/../x`;
  - `javascript:alert(1)`

  *Then* `true`, затем `false` у остальных. Тест читает `apps/ui/shell/public/federation.manifest.json`: у каждого адреса `isLocalRemoteUrl` — `true`, имена — ровно `cabinet`, `admin`, `supervisor`.
- **AC-014-6** — *Given* функция `ui-core` `safeReturnTo(value: string | null): string` *When* `/swarms/x`, `null`, `https://evil.example`, `//evil.example`, `/\evil`, `swarms` *Then* `/swarms/x`, затем `/` у остальных (REQ-014-5).
- **AC-014-7** — *Given* функция `ui-core` `validatePasswordPair(password, repeat)` и схемы `RegistrationConfirmRequest`, `InvitationAcceptRequest` *When* пароль 9 символов, несовпадающий повтор, пустое название, верные данные *Then* ошибка поля `password`, ошибка `repeat` с текстом 4.6, ошибка `organizationName`, успех.
- **AC-014-8** `[manual]` — регистрация в браузере (из S-1, шаги 1–4).
  - *Given* `npm run up`, пустой Mailpit.
  - *When* без входа открыть `/`, `/balance`, `/admin/users` *Then* `/login?returnTo=…`.
  - *When* `/signup` с новым email *Then* сообщение 4.6, письмо в Mailpit со ссылкой на `/signup/confirm?token=`.
  - *When* открыть ссылку *Then* токена в адресной строке нет.
  - *When* задать пароль и название *Then* открыт `/`, в шапке email и название организации, пункты «Рои», «Баланс», «Админка».
  - *When* повторно открыть ту же ссылку *Then* текст `invalid_token` и ссылка на `/signup`.
  - *When* `/signup` с тем же email *Then* то же сообщение 4.6 и письмо «Вы уже зарегистрированы».

  В журнал — шаги и снимки экрана.
- **AC-014-9** `[manual]` — админка и приглашение (из S-1, шаги 5, 7, 9).
  - *Given* администратор из AC-014-8.
  - *When* выйти и войти неверным паролем *Then* текст `invalid_credentials`.
  - *When* войти верным *Then* `/`.
  - *When* «Админка» → пригласить email с ролью `user` *Then* текст «Приглашение отправлено», письмо со ссылкой на `/invite?token=`.
  - *When* в другом профиле браузера открыть ссылку и задать пароль *Then* у приглашённого кабинет без пункта «Админка».
  - *When* приглашённый открывает `/admin/users` *Then* `/`. Во вкладке «Сеть» нет запроса к `/mf/admin/`.
  - *When* администратор блокирует приглашённого с подтверждением *Then* в списке «заблокирован». Следующий запрос приглашённого (обновить список роёв) уводит его на `/login`, вход — текст `user_blocked`.
  - *When* разблокировать и сменить роль на `admin` *Then* список отражает изменения.
- **AC-014-10** `[manual]` — супервизор (из S-1, шаги 8, 10).
  - *Given* две организации из AC-014-8 и ещё одной регистрации.
  - *When* войти супервизором из `.env` *Then* пункты «Рои» и «Организации», «Баланс» и «Админки» нет.
  - *When* «Организации» *Then* обе организации с числом пользователей.
  - *When* открыть организацию *Then* её пользователи и баланс.
  - *When* пополнить на $1 с комментарием *Then* баланс и история обновлены, у администратора этой организации на `/balance` та же запись.
  - *When* супервизор блокирует пользователя организации *Then* статус в списке.
  - *When* администратор организации A пробует открыть `/supervisor` *Then* `/`, запроса к `/mf/supervisor/` нет.
- **AC-014-11** `[manual]` — кабинет как remote не изменился.
  - *Given* администратор с балансом.
  - *When* создать рой, открыть его, остановить, открыть `/balance` *Then* экраны и поведение — как в 013, AC-013-25: граф, лента, деньги, «Стоп», отказ `402` с текстом 013, история баланса.
  - *When* обновить страницу на `/swarms/:id` *Then* сессия восстанавливается, страница роя открыта.
  - Ссылки «трейс» в ленте у администратора нет, у супервизора — есть (REQ-014-18).
- **AC-014-12** `[manual]` — один экземпляр сессии (REQ-014-15).
  - *Given* вход администратором, открыты «Рои», затем «Админка».
  - *When* в DevTools выполнить проверку из журнала: оба раздела используют один `SESSION`.
  - *When* дождаться истечения токена доступа (`IDENTITY_ACCESS_TTL_S` уменьшен до 30 в `.env` на время проверки) и открыть «Админку» и «Рои» *Then* во вкладке «Сеть» ровно один `POST /auth/refresh` на оба раздела.
  - В `localStorage` и `sessionStorage` нет токена, есть только `swag.theme`.
- **AC-014-13** `[manual]` — темы и доступность (REQ-014-16, REQ-014-21).
  - *When* переключатель в положениях «тёмная», «светлая», «как в системе» при тёмной системной теме *Then* тёмная, светлая, тёмная. Выбор переживает перезагрузку.
  - *When* пройти `/login`, `/signup`, «Админку» клавиатурой (Tab, Enter, Esc в диалоге) *Then* все действия доступны, фокус виден.
  - Контраст основного текста и кнопки primary в обеих темах ≥ 4.5:1 по DevTools. Значения — в журнал.
- **AC-014-14** `[manual]` — запуск на хосте (REQ-014-20).
  - *Given* `npm run up`, `docker compose stop ui`.
  - *When* `npm run ui:dev` и правка текста на странице `/login` *Then* изменение видно без перезапуска.
  - Вход и раздел «Админка» работают через прокси на `127.0.0.1`.
- **AC-014-15** — *Given* `.env.example` *When* тест читает `IDENTITY_CONFIRM_URL` и `IDENTITY_INVITE_URL` *Then* пути `/signup/confirm` и `/invite`, порт — `UI_PORT` того же файла. В `.env.example` есть `UI_CABINET_PORT`, `UI_ADMIN_PORT`, `UI_SUPERVISOR_PORT`. `compose.yaml` не публикует порты сервисов `ui-cabinet`, `ui-admin`, `ui-supervisor`, а `ui` публикует только на `127.0.0.1`.
- **AC-014-16** — *Given* `canOpen` и `navigationFor`.
  - *When* `me.user.role` — `user`, а `organization = null` (неконсистентный ответ) *Then* `balance` закрыт, остальное — по таблице 4.2.
  - *When* `me.user.role` — `supervisor` *Then* `canOpen('admin', me)` — `false`, хотя `user.manage` у супервизора есть: админка требует `role = 'admin'`.

## 6. Нефункциональные требования

| ID | Требование | Как измеряется |
|---|---|---|
| NFR-014-1 | Начальный JS каркаса (без remote) — не больше 250 КБ gzip (Q-8) | `ng build` каркаса, сумма gzip начальных чанков из `stats.json`; значение в журнал |
| NFR-014-2 | Переход в раздел другого remote после входа — не дольше 1 с до отрисовки на dev-сервере, локально, второй и последующие переходы | DevTools Performance, 5 замеров, медиана в журнал |

## 7. Безопасность: что не должно сломаться

- **Скрытие в UI — не доступ.** Права проверяют `api` и identity. Существующие AC 024 и 013 на `403` и область видимости остаются зелёными: `npm run check`.
- **Код раздела без прав не загружается.** REQ-014-3: AC-014-2, AC-014-9, AC-014-10 (сеть без `/mf/admin/`, `/mf/supervisor/`).
- **Remote только своего origin.** Чужой адрес в манифесте не регистрируется: AC-014-5.
- **Открытый редирект после входа закрыт** проверкой `returnTo`: AC-014-6.
- **Токены из писем.**
  - Убираются из адреса и не уходят в `Referer`: REQ-014-9, AC-014-8.
  - Не логируются: ревью этапа и поиск `console.` в страницах `/signup/confirm` и `/invite`.
- **Токен доступа только в памяти**, один на страницу: REQ-014-15, AC-014-12.
- **Нет перебора email.** `/signup` показывает одно сообщение на существующий и новый email: REQ-014-6, AC-014-8.
- **Порты.** Remote не опубликованы, каркас — только на `127.0.0.1`: AC-014-15.
- **`/internal` не проксируется** ни одним прокси каркаса: AC-014-15 дополнительно проверяет `proxy.conf.json` и `proxy.host.conf.mjs` на отсутствие `/internal`.
- **Трейсы видит только супервизор** (Q-4): AC-014-11.

## 8. Задачи для агента

Выполняются по порядку. После каждой задачи — коммит. Задачи T-5…T-10 меняют сборку кабинета: до T-9 кабинет и каркас не работают вместе. Поэтому T-5…T-10 — группа через фича-ветку `spec/014-shell` (implement-spec, «Связанные задачи»).

- [ ] **T-1.** `packages/ui-core/src/auth-session.ts`: методы `AuthApi` и `AuthSessionKeeper` из 4.1, тип `AuthResult`. Тесты в `test/auth-session.test.ts`. README `ui-core`, глоссарий: `AuthResult`. Закрывает: REQ-014-7, REQ-014-8, AC-014-1. Готово, когда: тесты пакета зелёные, AC-024-23 не изменён и зелёный.
- [ ] **T-2.** `packages/ui-core/src/access-ui.ts`:
  - `UiArea`, `NavItem`, `canOpen`, `navigationFor`;
  - `UserAction`, `userActions`, `userActionBody`;
  - `isLocalRemoteUrl`, `safeReturnTo`.

  Реэкспорт из `index.ts`. Тесты `test/access-ui.test.ts`. Тест чтения манифеста добавляется в T-7, когда появится файл. Закрывает: REQ-014-3…5, REQ-014-12 (действия), AC-014-2, AC-014-3, AC-014-5 (функция), AC-014-6, AC-014-16. Готово, когда: тесты зелёные, имена в глоссарии.
- [ ] **T-3.** `packages/ui-core/src/auth-texts.ts`:
  - `authErrorText` и тексты 4.6 константами;
  - `validatePasswordPair`.

  Тесты `test/auth-texts.test.ts`. Порты `UsersApi`, `OrganizationsApi` (4.3) в `src/index.ts`. Закрывает: REQ-014-6…9 (тексты), AC-014-4, AC-014-7. Готово, когда: тесты зелёные.
- [ ] **T-4.** Пакет `packages/ui-angular` (`@swag/ui-angular`) по 4.7:
  - `package.json`, `tsconfig.json`, ссылка в корневом `tsconfig.json`, README;
  - строка в `docs/architecture.md`, «Пакеты»: фронтендовый оболочечный пакет, не ядро;
  - если `arch:check` требует классификации — правило «`packages/ui-angular` не ядро» и тест в `scripts/arch-check.test.ts`.

  Перенести `session.ts`, `auth-api.ts`, общий `http.ts` и `createBalanceApi` из кабинета, дописать адаптер 4.1 и `users-api.ts` 4.3, `areaGuard`. Кабинет импортирует перенесённое из пакета, его поведение не меняется. Закрывает: REQ-014-14, REQ-014-15 (код). Готово, когда: `npm run check` зелёный, кабинет в `npm run up` входит и показывает рои.
- [ ] **T-5.** `packages/ui-angular`:
  - `styles/tokens.css`, `theme.ts`;
  - компоненты 4.8 в `components/`.

  Значения токенов — скиллом дизайна из Q-3, решение и источник в README. Закрывает: REQ-014-16, REQ-014-17 (компоненты), REQ-014-21. Готово, когда: пакет собирается, компоненты экспортированы.
- [ ] **T-6.** Каркас `apps/ui/shell` (`@swag/shell`): Angular-приложение, Native Federation host, `federation.config.js` по 4.5, манифест 4.4, `initFederation` с `isLocalRemoteUrl`. Шапка: `navigationFor`, email, организация, тема, «Выйти». Маршруты 4.11 с `areaGuard`. `Dockerfile`, `proxy.conf.json`, README. Закрывает: REQ-014-1, REQ-014-3, REQ-014-10. Готово, когда: каркас собирается (`ng build`), страницы remote пока дают ошибку загрузки — ожидаемо внутри группы.
- [ ] **T-7.** Страницы каркаса `/login` (перенос из кабинета), `/signup`, `/signup/confirm`, `/invite` по 4.11, 4.6, REQ-014-5…9. Добавить в `packages/ui-core/test/access-ui.test.ts` тест чтения манифеста (AC-014-5). Закрывает: REQ-014-5…9, AC-014-5 (манифест). Готово, когда: страницы собираются, тест манифеста зелёный.
- [ ] **T-8.** `apps/ui/cabinet` → remote:
  - Native Federation remote, экспорт `./routes`;
  - удалить `login.page.ts`, шапку `app.ts`, свой `auth.guard.ts`;
  - экраны — на компоненты 4.8 без изменения поведения;
  - ссылка «трейс» — только при `role = 'supervisor'` из `CurrentUser`;
  - `servePath` `/mf/cabinet/`, порт 4201, Dockerfile, README.

  Закрывает: REQ-014-2, REQ-014-11, REQ-014-17, REQ-014-18. Готово, когда: remote собирается, `remoteEntry.json` отдаётся.
- [ ] **T-9.** Compose по 4.9: сервисы `ui` (каркас), `ui-cabinet`, `ui-admin`, `ui-supervisor` (последние два — после T-10, в этой задаче только `ui` и `ui-cabinet`). `infra:check` — каркас и `remoteEntry.json` кабинета. Корневой README. Закрывает: REQ-014-2. Готово, когда: `npm run up` — вход в каркас и экраны кабинета работают.
- [ ] **T-10.** `apps/ui/admin` (`@swag/admin`): remote, `./routes` с `users`, страница REQ-014-12 на `UsersApi` и `userActions`, подтверждение блокировки, тексты 4.6, Dockerfile, README. Сервис `ui-admin` в compose и `infra:check`. Закрывает: REQ-014-12. Готово, когда: `npm run up`, раздел открывается у администратора. После этой задачи — PR фича-ветки `spec/014-shell` в `main`.
- [ ] **T-11.** `apps/ui/supervisor` (`@swag/supervisor`): remote, `./routes`, страницы REQ-014-13 на `OrganizationsApi`, `UsersApi`, `createBalanceApi`, форма пополнения по 013, 4.11, Dockerfile, README, сервис `ui-supervisor` в compose и `infra:check`. Закрывает: REQ-014-13. Готово, когда: `npm run up`, раздел открывается у супервизора.
- [ ] **T-12.** env по 4.10 в `.env.example` и `.env`, дефолты в `compose.yaml`, тест AC-014-15 (`scripts/` или `apps/ui/shell/test/`), README identity — новые адреса страниц. Закрывает: REQ-014-19, AC-014-15. Готово, когда: тест зелёный, письмо регистрации ведёт на `/signup/confirm`.
- [ ] **T-13.** *(из N-6)* `npm run ui:dev`, `apps/ui/shell/proxy.host.conf.mjs` по 4.9, раздел в корневом README и README каркаса. Закрывает: REQ-014-20. Готово, когда: AC-014-14 пройден вручную.
- [ ] **T-14.** Ручные проверки AC-014-8…14 с записью в журнал, замеры NFR-014-1 и NFR-014-2, статус S-1 в `docs/spec/scenarios.md` (шаги 1–5, 7–10 в UI — ручной прогон 014), сверка README всех затронутых пакетов, `apps/ui/README.md` и `docs/architecture.md`. Готово, когда: журнал заполнен, `npm run check` зелёный.

## 9. Открытые вопросы

Пока список не пуст, спека не может быть `ready`.

- [ ] **Q-1.** *(из D-11)* Чем каркас подгружает микрофронтенды. *(Claude, 2026-11-01)*
  - **(а) Native Federation** (`@angular-architects/native-federation`): import maps и ESM, работает поверх сборщика `@angular/build` на esbuild, которым уже собирается кабинет. Общие зависимости — одна копия на странице (`singleton`).
  - **(б) Module Federation на rspack/webpack**: надо уйти с esbuild-сборщика Angular.
  - **(в) Web components и import maps без федерации**: любая технология у каждого фронтенда. Но у каждого своя копия Angular, а общую сессию придётся передавать через `window` или события.
  - **(г) Без рантайм-подгрузки**: каркас импортирует кабинет, админку и супервизор как библиотеки с ленивыми маршрутами. Проще всего, но независимый деплой теряется, что противоречит роадмапу.

  Проверено по npm 2026-11-01: `@angular-architects/native-federation` 22.2.4, peer `@angular/build ~22.2.0`, то есть поддерживает Angular 22.2 (кабинет на 22.2.3). У Module Federation на rspack поддержка Angular 22 не подтверждена. Обёртки Nx для Module Federation объявлены устаревшими в Nx 23. Официальной позиции команды Angular по микрофронтендам не найдено.

  **Рекомендация: (а)** — тот же сборщик и одна копия Angular и сессии. Версия пакета — точная, по минорной версии Angular. Манифест — файл 4.4 рядом с каркасом. В проде его подменяет деплой (вне 014).
- [ ] **Q-2.** *(из D-11)* Где живёт общий фронтендовый код. *(Claude, 2026-11-01)*
  - Логика — одно ядро `ui-core` на все фронтенды, по файлу на область. Отдельные `cabinet-core` и `admin-core` не нужны, общих частей больше, чем различий.
  - Angular-код, общий для фронтендов (сессия, `CurrentUser`, адаптеры на `fetch`, компоненты, токены), — варианты:
    - **(а)** новый пакет `packages/ui-angular` — оболочечный, не ядро, разделяется федерацией как `singleton`;
    - **(б)** копия в каждом фронтенде: нарушает DRY, и у каждого remote появляется своя сессия, а это противоречит REQ-014-15;
    - **(в)** только адаптеры в `ui-angular`, компоненты — web components в отдельном пакете, чтобы их мог взять фронтенд не на Angular.

  **Рекомендация: (а)**: все фронтенды MVP на Angular. Web components — когда появится фронтенд на другой технологии.
- [ ] **Q-3.** *(из D-16)* Дизайн-система: когда, на чём и каким скиллом. *(Claude, 2026-11-01)*
  **Когда.** Варианты D-16: внутри 014; отдельной спекой перед 014; отдельной спекой раньше. Рекомендация — внутри 014 (D-16 (а)): каркас и три новых фронтенда сразу пишутся в общем стиле, и переделывать их потом не придётся.

  **Библиотека.** Версии проверены по npm 2026-11-01:
  - **(а)** свои базовые компоненты 4.8 на токенах и `@angular/cdk` 22.2.x для диалога и ловушки фокуса;
  - **(б)** Angular Material 22.2.5 (M3; peer `@angular/core ^22 || ^23`), тема из токенов;
  - **(в)** Spartan `@spartan-ng/brain` 1.9.0 (подход shadcn; peer `@angular/core >=21 <23`, требует Tailwind ≥ 4, сейчас 4.3.3). Стабильность релизов не оценена;
  - **(г)** PrimeNG 22.1.4 (peer `^22.1.0`), 90+ компонентов.

  **Скилл дизайна.** Проверено 2026-11-01:
  - `frontend-design` из [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design): последнее изменение 2026-09-03. Задаёт эстетику от предмета и аудитории, палитру из 4–6 цветов, шкалу шрифтов, проверку на шаблонность и доступность.
  - [Impeccable](https://github.com/pbakaus/impeccable) (`pbakaus/impeccable`): около 98,7 тыс. звёзд, обновлён 2026-10-31. Команды `critique`, `audit`, `polish` и детектор из 62 правил.
  - Каталоги навыков (awesome-claude-skills, skills.sh) дают производные копии `frontend-design`, их не берём.

  **Рекомендация.**
  - Библиотека — **(а)**. Экранов немного: формы, таблицы, диалог. Своих компонентов 7, и общая зависимость федерации получается маленькой. Тема — только наши токены, без перекраски чужой. CDK даёт доступный диалог без своего кода фокуса. (б) — запасной вариант, если своих компонентов окажется мало.
  - Скилл — `frontend-design`: им в T-5 выбираются эстетика и значения токенов. Impeccable `audit` — на ручной приёмке AC-014-13, итог в журнал.
  - Оба скилла ставятся в `.claude/skills/` проекта с указанием коммита источника. Лицензию проверить при установке и записать в README `ui-angular`.
- [ ] **Q-4.** *(из D-15)* Кто видит Grafana. *(Claude, 2026-11-01)*
  Сейчас прокси `/grafana` в dev-сервере пускает в Grafana любого, кто открыл UI. Grafana слушает только `127.0.0.1`, входа в ней нет. Трейсы показывают промпты, ответы моделей и данные всех организаций.
  - **(а)** В 014 ссылку «трейс» видит только супервизор. Прокси `/grafana` в dev остаётся. Вход в Grafana и её роли — спека эксплуатации (16) до выхода в прод.
  - **(б)** Ссылку видят все, Grafana закрывается прокси с проверкой токена супервизора: нужен свой прокси с проверкой JWT в dev-сервере или в `api`.
  - **(в)** Пользователь и администратор видят трейсы своих роёв: нужна фильтрация Tempo по организации — тяжело и вне MVP.

  **Рекомендация: (а)**: не обещаем организации то, чего не можем ей безопасно показать, а инструмент разработки остаётся под рукой.
- [ ] **Q-5.** *(D-131: «новая спека после 013, до 014»)* Порядок со спекой мультиорганизаций. *(Claude, 2026-11-01)*
  - **(а)** 014 делается до спеки по D-131. Экраны берут одну организацию из `AuthMe.organization`, весь доступ уже идёт через `/auth/me` и `canOpen`. Переключатель организации и создание второй — в спеке D-131: она добавит в шапку каркаса выбор и поменяет `AuthMe`.
  - **(б)** Сначала спека D-131 (identity, `api`, контракты), 014 зависит от неё и сразу рисует переключатель.

  **Рекомендация: (а)**: регистрация и вход в браузере нужны для ручных проверок всех следующих спек, а изменения D-131 в UI сводятся к шапке и `AuthMe`. D-131 остаётся в `questions.md`; при ответе (а) в нём меняется «до 014» на «после 014».
- [ ] **Q-6.** Рои и расходы по пользователям в админке, «все рои и расходы» у супервизора. Роадмап кладёт их в админку, но в `SwarmSummary` нет `orgId`, `createdBy` и трат. *(Claude, 2026-11-01)*
  - **(а)** Не в 014. Админ и супервизор видят рои в разделе «Рои», как сейчас: область видимости по роли — из 024. Расходы по пользователям и узлам — 025, где появляется агрегирование расхода.
  - **(б)** В 014: `SwarmSummary` получает `orgId`, `createdBy`, `spentMicroUsd`, `GET /swarms` — фильтры `?orgId=&createdBy=`, в админке и у супервизора — таблица роёв с тратами. Плюс 3–4 задачи в `contracts`, `api-core`, `adapter-postgres`.

  **Рекомендация: (а)**: 014 — только UI поверх готового API. Расход лучше сделать один раз в 025 вместе с балансом ИИ.
- [ ] **Q-7.** *(из D-38, часть «экран супервизора»)* Счёт платформы на экране супервизора. Данных для него ещё нет: поступлений нет до реальной оплаты, агрегатов `providerCostMicroUsd` нет. *(Claude, 2026-11-01)*
  **Рекомендация:** не в 014. В D-38 «куда» оставить только 025, экран — вместе с данными.
- [ ] **Q-8.** Порог NFR-014-1. *(Claude, 2026-11-01)*
  В роадмапе числа нет. Предложено 250 КБ gzip начального JS каркаса: Angular 22 с роутером и формами — порядка 100–150 КБ gzip, остальное — запас на шапку, страницы входа и компоненты. Варианты: 250 КБ; 200 КБ (строже); без NFR, только замер в журнал.
  **Рекомендация:** 250 КБ.

## 10. Журнал реализации

Заполняет агент.

| Дата | Ветка / коммит | Что сделано | Отклонения от спеки |
|---|---|---|---|
