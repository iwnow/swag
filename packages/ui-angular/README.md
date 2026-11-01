# @swag/ui-angular

Общий Angular-пакет фронтендов платформы (спека 014, 4.7): сессия, HTTP-адаптеры портов `ui-core`, дизайн-токены. Оболочечный код, не ядро: здесь разрешены Angular и DOM. Правила ядра сюда не относятся, `arch:check` проверяет только `*-core`, `contracts` и `api-integration`.

## Задачи

- Сессия — `SessionUserStore` (`SESSION_USER`, `ui-core`): один `AuthSessionKeeper` и `GET /auth/me` на страницу; роль и организация из `/auth/me` (спека 013, D-130; 014, 4.12).
- `createRequest(session, basePath)` — REST с `Authorization: Bearer`, на `401` один `renew()` и повтор, ошибка — `HttpError`.
- `authApi`, `getMe` — адаптер `AuthApi` из `ui-core` на `fetch` по `/auth` (024, 4.15).
- `meApi` — порт `MeApi` поверх `getMe`: `401` → `null`, прочая ошибка — исключение (014, 4.12).
- `preferences` — порт `Preferences` на `localStorage` в `try/catch` (014, 4.12).
- `createSwarmsApi(session)`, `createSwarmStream(session)`, `TRACE_URL_TEMPLATE` — адаптеры роёв для `CabinetStore` и ссылка на трейс; переехали из `apps/ui/cabinet` (014, REQ-014-23).
- `connectStore(store)`, `toAngularSignal(source, destroyRef)`, тип `Connected<S>` — мост сторов `ui-core` в Angular-сигналы (014, 4.12 «Мост в Angular»).
- `SESSION_USER`, `SHELL_STORE`, `CABINET_STORE`, `ADMIN_STORE`, `SUPERVISOR_STORE` — токены сторов; `provideShellStore()`, `provideCabinetStore()`, `provideAdminStore()`, `provideSupervisorStore()` — провайдеры (014, 4.12).
- `createBalanceApi(session)` — баланс организации по `/api` (013, 4.11).
- `createUsersApi(session)`, `createOrganizationsApi(session)` — порты админки и супервизора (014, 4.3) по `/auth` (024, 4.7).
- `styles/tokens.css` — дизайн-токены 4.8 для светлой и тёмной темы (REQ-014-16, REQ-014-21).
- `styles/base.css` — глобальные стили фронтендов (элементы, раскладка, классы кабинета `.feed`, `.agent-row`, `.toolbar`) только на токенах (REQ-014-16); перенесено из `<style>` кабинета (014, 4.7).
- Тема — `SHELL_STORE.theme` и `setTheme` (014, 4.12): выбор хранит `preferences` под `swag.theme`, атрибут `data-theme` на `<html>` ставит каркас (REQ-014-16).

- `sessionGuard`, `areaGuard(area)` — guard's маршрутов на `SESSION_USER` (014, 4.4, 4.12).
- `swag-balance-panel` — панель баланса без своего состояния: вход `state`, выходы `more` и `topup` (013, 4.11; 014, 4.12).
- `swag-user-table` — таблица пользователей админки и супервизора (014, T-16): вход `rows` (`UserRow` из `userRows`), `loaded`; выход `action` `{ userId, action }`; подтверждение блокировки внутри.

## Что внутри сейчас

- `src/http.ts` — `HttpError` (`status`, `code`; без кода в теле — `'unknown'`), `httpError(response)`, `createRequest(session, basePath)`, тип `RequestSession`.
- `src/auth-api.ts` — `authApi`, `getMe(token)`.
- `src/balance-api.ts` — `createBalanceApi`, тип `BalanceApi`.
- `src/swarms-api.ts` — `createSwarmsApi(session)` (REST, basePath `/api`), `createSwarmStream(session)` (WebSocket, подпротокол `swag.bearer.<token>`, `4401` → `renew`). Принимают `RequestSession`.
- `src/preferences.ts` — `preferences` (`Preferences`).
- `src/stores.ts` — мост: `toAngularSignal`, `connectStore`, тип `Connected<S>`; токены `SESSION_USER` (фабрика — `createSessionUserStore` на `authApi` и `meApi`), `SHELL_STORE`, `CABINET_STORE`, `ADMIN_STORE`, `SUPERVISOR_STORE`; `provideShellStore()`, `provideCabinetStore()`, `provideAdminStore()`, `provideSupervisorStore()` (`UsersApi`, `OrganizationsApi` из `users-api.ts` и `BalanceApi` на `SESSION_USER`); `TRACE_URL_TEMPLATE`.
- `test/guards.test.ts` — `redirectOnSignOut` (открытые страницы не уводят на `/login`, закрытые уводят; заглушка роутера разбирает адрес настоящим `DefaultUrlSerializer`).
- `test/stores.test.ts` — AC-014-26 (мост на Angular injection context из `@angular/core`, без TestBed; `dispose` стора при уничтожении инжектора маршрута; `ADMIN_STORE` и `SUPERVISOR_STORE` собираются из `SESSION_USER`) и тест `preferences`.
- `src/users-api.ts` — `createUsersApi`, `createOrganizationsApi`.
- `styles/tokens.css` — токены: светлая тема в `:root`, тёмная в `:root[data-theme='dark']` и в `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) }`. Проверяет `scripts/ui-config.test.ts` (AC-014-10, контраст).
- `styles/base.css` — глобальные стили; цвета, шрифты, отступы и радиусы только `var(--swag-…)`.
- `src/components/button.ts` — директива `button[swag-button]` (`variant`, `disabled`, `busy`), `ButtonVariant`; `field.ts` — `swag-field` (`label`, `error`); `card.ts` — `swag-card` (`title`); `alert.ts` — `swag-alert` (`kind`), `AlertKind`; `table.ts` — `swag-table` (`empty`); `page.ts` — `swag-page` (`title`); `confirm.ts` — `swag-confirm` (`text`; выходы `confirmed`, `cancelled`) на `@angular/cdk/dialog`; `user-table.ts` — `swag-user-table` (`rows`, `loaded`; выход `action`), общая таблица пользователей.
- `src/guards.ts` — `sessionGuard` (`CanMatchFn` для родителя маршрутов: `SESSION_USER.restore()`, без токена — `UrlTree` на `/login?returnTo=`), `areaGuard(area)` (`ensureMe()`, затем `canOpen`; нет доступа — `UrlTree` на `/`), `redirectOnSignOut()` (вызов в injection context: переход с любым статусом `signed-out` на `/login`, если первая навигация уже завершилась и путь текущего адреса не в `OPEN_PATHS` — `/login`, `/signup`, `/signup/confirm`, `/invite`; путь текущего адреса берётся структурным разбором `router.parseUrl` — сегменты первичного outlet через `/`, без query и fragment; `/invitex` — закрытая страница; до первой навигации и при статусе `signed-in` перехода нет). Открытые страницы каркаса без сессии, поэтому выход на них (в том числе «Выйти и продолжить» на `/signup/confirm` и `/invite`, REQ-014-9) не уводит на `/login`. Тест — `test/guards.test.ts`; `effect` Angular в нём заменён моком, колбэк вызывается вручную (без DOM эффект не запускается).
- `src/balance-panel.ts` — `BalancePanelComponent` (`swag-balance-panel`): вход `state` (`Connected<BalanceState>`), выходы `more` и `topup` (`{ amountUsd, comment }`); состояния нет, проверки и запросы — в сторе.
- `src/manifest.ts` — `readFederationManifest()`: `fetch` манифеста федерации (014, 4.4). Приложения `apps/ui/*` `fetch` не вызывают (AC-014-26).
- `src/index.ts` — реэкспорт всего перечисленного.
- `test/http.test.ts` — AC-014-19 (403 без `renew`, `401` → `renew` → повтор, два одновременных `401` → один `renew`).
- `package.json` — `exports`: `.` → `./src/index.ts`, `./styles/*` → `./styles/*`.
- `tsconfig.json` — проверка через корневой `tsconfig.json` (`references`), поэтому `npm run typecheck` проверяет пакет. Настройки Angular — как у `apps/ui/cabinet/tsconfig.json`: `moduleResolution: bundler`, `module: preserve`, `experimentalDecorators: false`, DOM. Кабинет в корневые `references` не входит (его собирает `ng build`). Для `references` нужны `composite` и `outDir: dist` (каталог в `.gitignore`), как у `ui-core`.

## Ключевые решения

- `createRequest` не зависит от Angular: принимает `RequestSession` (`accessToken`, `renew`), тесты идут в Node без TestBed.
- Мост (014, 4.12): кэш по ключу поля — `effect` создаётся при первом чтении, повторное чтение отдаёт тот же объект (`Map`). Записи в `connectStore` — `TypeError` (`set`, `defineProperty`, `deleteProperty`): менять состояние можно только методами стора. Примитивы читаются из стора каждый раз, не кэшируются.
- `connectStore` берёт `DestroyRef` синхронно (`inject(DestroyRef)`), поэтому вызывается в injection context. `dispose()` стора и снятие `effect` вешаются на `DestroyRef` инжектора, где стор предоставлен. Сторы разделов — `provideCabinetStore()`, `provideAdminStore()` и `provideSupervisorStore()` — провайдеры в `providers` корневого маршрута `./routes` remote: стор создаётся при первом заходе в раздел и живёт всю сессию вкладки, потому что каркас инжекторы маршрутов не уничтожает; уничтожаются только компоненты. Актуальность данных — перезагрузка на каждом заходе на экран: страница вызывает загрузку (`loadSwarms`, `openSwarm`, `balance.open`, `load()`) и сбрасывает форму (`resetForm`, `resetInvite`). Решение человека 2026-11-01, одинаково для всех разделов (журнал T-13).
- Адаптеры роёв переехали из `apps/ui/cabinet/src/app/api.ts` в пакет без правки логики: приложения не строят адаптеры сами (REQ-014-23). `timers` для `CabinetStore` — `window.setTimeout`/`clearTimeout`, как в `ui.ts` кабинета.
- `@preact/signals-core` 1.14.5 — точная версия, как в `ui-core` (одна копия на страницу, 4.12).
- Тест моста: `effect` подменяется `vi.fn` через `vi.mock` ради проверки «один `effect` на поле» — без внутренностей preact.
- Одновременные `401` делят один `renew()` внутри `createRequest` (промис хранится до завершения). Keeper из `ui-core` делит refresh ещё раз — это его собственная гарантия.
- Неудача `renew()` — ошибка `401` уходит вызывающему; выход из сессии выполняет keeper и вызывает `onSignedOut`. `createRequest` на `onSignedOut` не подписан и сам его не вызывает.
- `authApi` не использует `createRequest`: у входа и обновления нет Bearer, а `refresh` сам вызывается keeper'ом (иначе цикл).
- `HttpError` из `@swag/ui-angular` и `HttpError` из `@swag/helpers/server` (повтор с задержкой, 004) — разные классы с разными конструкторами. Импортировать каждый из своего пакета.
- Тело ошибки, которое не JSON, даёт `HttpError` с кодом `'unknown'` (раньше в кабинете это был `SyntaxError`).
- `@angular/forms` 22.2.3 — явная зависимость. Без неё `npm install` не сходится: `@angular/cdk@22.2.3` требует `@angular/forms` в диапазоне `^22`, и npm берёт `22.2.4`, у которого peer `@angular/common` 22.2.4. Тот же приём, что в T-1 для `@angular/compiler-cli`.
- Версия `@angular/cdk` — 22.2.3: есть в npm (`npm view @angular/cdk@22.2.3 version`), совпадает с остальными `@angular/*`.
- Пакет подключается по workspace (`packages/*` в `package.json` корня), без `paths`: `node_modules/@swag/ui-angular` ведёт сюда.
- Стили подключаются в `apps/ui/shell/angular.json` (`build.options.styles`) каркасом, кабинет их не подключает, по имени пакета: `@swag/ui-angular/styles/tokens.css`, затем `base.css`. Сборка `ng build` резолвит `exports` без путей `../../../packages/...`; `<style>` из `index.html` кабинета удалён.
- Тема: «system» — атрибут `data-theme` снимается, тему выбирает `prefers-color-scheme` через `tokens.css`; «light» и «dark» — атрибут на `<html>`, перекрывает системную тему. Хранение — `preferences` в `try/catch`; при недоступности выбор живёт до перезагрузки. `ThemeService` удалён (014, 4.12), вопрос D-133 о его API снят.
- `base.css` задаёт `color-scheme: light dark` на `:root`, с `data-theme` — `light` или `dark` соответственно: нативные контролы браузера совпадают с темой.
- `button[swag-button]` — директива на нативной кнопке, а не элемент `swag-button`: `type` остаётся нативным, submit внутри форм работает без нового входа. `busy` ставит нативный `disabled` и `aria-busy="true"` (D-135). Вид disabled один для всех вариантов: `.swag-button:disabled` в `base.css` с селектором (0,2,0) перебивает варианты.
- `swag-field` без директивы: после каждого рендера ставит `aria-describedby` (id ошибки) и `aria-invalid` первому проецируемому `input`, `select` или `textarea`. Чужие id в `aria-describedby` сохраняются, снимается только свой. Ошибка выводится с `role="alert"` (D-136).
- Пустота `swag-table` определяется CSS `:has(tbody tr)` в `base.css`; входа строк нет (D-137).
- `swag-user-table` выносит разметку пользователей из админки, чтобы супервизор не дублировал её (REQ-014-17, REQ-014-23). Компонент держит только открытое подтверждение блокировки, данные и действия — в сторе (`AdminStore`, `SupervisorStore`).
- `swag-confirm` открывает диалог в `ngAfterViewInit` и закрывает в `ngOnDestroy`: потребитель показывает компонент через `@if`. Esc и клик по фону — `cancelled`, `confirmed` только по кнопке «Подтвердить». `aria-describedby` диалога указывает на абзац текста, id уникален на экземпляр (D-138).
- `sessionGuard` вызывает `SESSION_USER.restore()`: один `restore` на стор, повторные вызовы получают тот же промис (014, 4.12). После него без токена уводит на `/login`. `ensureRestored` удалён.
- `sessionGuard` — `canMatch`, а не `canActivate`: проверка до загрузки remote (014, 4.4).
- `swag-balance-panel` без состояния (014, 4.12): данные, проверки формы, запросы и тексты ошибок — в `BalanceState` (`createBalanceState`, `ui-core`). Панель рисует сигналы и отдаёт ввод. Дата в истории — `formatDateTime` из `ui-core`. Поля суммы и комментария — локальные поля ввода, очищаются после отправки без ошибки формы. `requireComment` задаёт вызывающий: `balance.topup(input, requireComment)`.
- Мост `connectStore` вкладывается только в простой объект (`Object.prototype` или `null` в прототипе); массивы, `Date` и прочее отдаются как есть, без кэша. `effect` моста создаётся в `untracked`, потому что мост создаётся лениво, в том числе внутри `computed` и шаблона, где запись в сигнал запрещена (NG0600) (014, 4.12, AC-014-26).
- Видимый фокус (REQ-014-22) — глобальное `:focus-visible` в `base.css`, обводка `--swag-color-focus`.

## Дизайн-токены (T-7)

Скилл `frontend-design` подсказал характер интерфейса: это рабочий инструмент оператора роёв (режим «работать», не «убеждать»), поэтому ставка на читаемость и сдержанность, а не на эффект. Намеренно обойдены типовые решения: кремовый фон с терракотой, чёрный фон с кислотным акцентом, карточки с одинаковой тенью.

- **Нейтрали.** Холодный графит с синевой: светлая `bg #f3f5f7` / `surface #ffffff` / `surface-2 #e8ecf0`, тёмная `#0d1318` / `#151d24` / `#1e2932`. Поверхности отличаются по тону, граница (`border`) тонкая и холодная; тень одна (`shadow-1`), тоньше и плотнее в светлой теме, глубже в тёмной.
- **Основной цвет.** Глубокий сине-бирюзовый `#0f5f8c` (светлая) и более светлый `#5bb8e8` (тёмная); текст на нём белый и тёмно-синий `#05202e`. Кнопки и ссылки берут основной цвет (`primary` и `primary-text` на кнопке). Фокус — отдельный яркий синий (`#0a68d6` / `#6cb6ff`), только для обводки фокуса, чтобы кольцо не сливалось с основным цветом.
- **Статусы.** `danger` красный `#b42318` с белым текстом (тёмная: светлый коралловый `#ff8f84` с тёмным текстом), `success` зелёный, `warning` янтарный.
- **Шрифты.** Системные стеки без загрузок: `--swag-font-sans` (`system-ui` и далее), `--swag-font-mono` (`ui-monospace`, Menlo, Consolas). Внешних шрифтов нет: тише сеть, нет мигания при загрузке.
- **Шкала текста.** 13 / 15 / 18 / 24 px (`sm`/`md`/`lg`/`xl`, в `rem`): плотный интерфейс с основным текстом 15 px. **Отступы.** 4 / 8 / 12 / 16 / 24 / 36 px (`space-1`…`space-6`). **Радиусы.** 3 и 6 px: мелкие элементы остры, поверхности мягче.
- **Контраст** (WCAG 2.2, минимум 4.5:1; посчитан тестом):

| Пара                       | Светлая | Тёмная |
| -------------------------- | ------- | ------ |
| `text` / `bg`              | 15.07   | 15.67  |
| `text` / `surface`         | 16.47   | 14.27  |
| `text-muted` / `surface`   | 7.09    | 7.29   |
| `primary-text` / `primary` | 6.92    | 7.56   |
| `danger-text` / `danger`   | 6.57    | 8.32   |

- Значения тёмной темы повторены в двух селекторах (атрибут и системная настройка): CSS не позволяет переиспользовать блок, тест сверяет, что они совпадают. Селекторы с одинарными кавычками: так форматирует prettier, для CSS это тот же селектор, что в 4.8.
- Цвета только `#rrggbb`, тень — `#rrggbbaa`: так тест считает контраст и находит литералы (AC-014-10).
- `exports` пакета уже содержит `./styles/*`, поэтому файл доступен как `@swag/ui-angular/styles/tokens.css` для T-8 и T-11.

## Скиллы дизайна (T-7, Q-3)

Установлен один (`frontend-design`), Impeccable нет. Скиллы в `.claude/skills/`, из репозиториев без скриптов установки; ничего из скачанного не запускалось.

| Скилл             | Источник                                                                           | Коммит                                     | Лицензия                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `frontend-design` | github.com/anthropics/skills, `skills/frontend-design` (`SKILL.md`, `LICENSE.txt`) | `ca45fc496a3436251f191354091d557da31c15b5` | Apache 2.0 (`LICENSE.txt` в каталоге скилла)                                                                                |
| Impeccable        | github.com/pbakaus/impeccable, `.claude/skills/impeccable`                         | `77ac20b968ee8d8d0992352f1a0b7dcc6e30f62b` | Apache 2.0 — **не установлен**: `SKILL.md` велит запускать `scripts/impeccable context`, лаунчер скачивает бинарник (D-132) |

## Ограничения

- Тестов Angular-части нет (нет TestBed-раннера). Мост проверяет `test/stores.test.ts`; guard's, панель и каркас проверяются сборкой (`ng build`) и ручной проверкой.

## Связи

- Потребители: `apps/ui/cabinet` (`@swag/cabinet`); каркас и remote-приложения (014, 4.7).
- Использует: `@swag/ui-core` (порты, сторы, `createAuthSessionKeeper`), `@swag/contracts`, `@swag/api-integration` (тип `SwarmView`), `@preact/signals-core` (мост).

## Спеки

- 014 — 4.4, 4.7, 4.8 (токены и компоненты), 4.1, 4.3, 4.12 (мост, сторы, guard's, панель без состояния; T-24), AC-014-10 (контраст и литералы, тест в `scripts/ui-config.test.ts`), AC-014-19, AC-014-26 (часть), REQ-014-13, REQ-014-16, REQ-014-17, REQ-014-21, REQ-014-22, T-5 — T-10. Открытые: D-134 (цвета статусов графа), D-135 — D-138 (компоненты, приёмка 014). D-133 и D-139 касались удалённых `ThemeService` и `ensureRestored`.
- 024 — 4.15 (сессия, `/auth`).
- 013 — 4.11 (баланс, `/auth/me`, D-130).
