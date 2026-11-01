# @swag/ui-angular

Общий Angular-пакет фронтендов платформы (спека 014, 4.7): сессия, HTTP-адаптеры портов `ui-core`, дизайн-токены. Оболочечный код, не ядро: здесь разрешены Angular и DOM. Правила ядра сюда не относятся, `arch:check` проверяет только `*-core`, `contracts` и `api-integration`.

## Задачи

- `SESSION` и `CurrentUser` — один `AuthSessionKeeper` на приложение; роль и организация из `GET /auth/me` (спека 013, D-130).
- `createRequest(session, basePath)` — REST с `Authorization: Bearer`, на `401` один `renew()` и повтор, ошибка — `HttpError`.
- `authApi`, `getMe` — адаптер `AuthApi` из `ui-core` на `fetch` по `/auth` (024, 4.15).
- `createBalanceApi(session)` — баланс организации по `/api` (013, 4.11).
- `createUsersApi(session)`, `createOrganizationsApi(session)` — порты админки и супервизора (014, 4.3) по `/auth` (024, 4.7).
- `styles/tokens.css` — дизайн-токены 4.8 для светлой и тёмной темы (REQ-014-16, REQ-014-21).
- `styles/base.css` — глобальные стили фронтендов (элементы, раскладка, классы кабинета `.feed`, `.agent-row`, `.toolbar`) только на токенах (REQ-014-16); перенесено из `<style>` кабинета (014, 4.7).
- `ThemeService` — режим темы `system` | `light` | `dark`, атрибут `data-theme` на `<html>`, выбор в `localStorage` под `swag.theme` (014, 4.7, REQ-014-16).

Guard'ы и `swag-table`, `swag-page`, `swag-confirm`, `swag-balance-panel` — в T-10, переключатель темы в шапке каркаса — в T-11 (4.7, 4.8).

## Что внутри сейчас

- `src/http.ts` — `HttpError` (`status`, `code`; без кода в теле — `'unknown'`), `httpError(response)`, `createRequest(session, basePath)`, тип `RequestSession`.
- `src/session.ts` — `SESSION` и `CurrentUser`: `role`, `orgId`, публичный `me: Signal<AuthMe | null>` (только чтение), `ensure()`, `clear()`.
- `src/auth-api.ts` — `authApi`, `getMe(token)`.
- `src/balance-api.ts` — `createBalanceApi`, тип `BalanceApi`.
- `src/users-api.ts` — `createUsersApi`, `createOrganizationsApi`.
- `styles/tokens.css` — токены: светлая тема в `:root`, тёмная в `:root[data-theme='dark']` и в `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) }`. Проверяет `scripts/ui-config.test.ts` (AC-014-10, контраст).
- `src/theme.ts` — `ThemeService` (`providedIn: 'root'`): `mode` — signal только для чтения, `setMode(mode)`; `ThemeMode`.
- `styles/base.css` — глобальные стили; цвета, шрифты, отступы и радиусы только `var(--swag-…)`.
- `src/components/button.ts` — директива `button[swag-button]` (`variant`, `disabled`, `busy`), `ButtonVariant`.
- `src/components/field.ts` — `swag-field` (`label`, `error`), `src/components/card.ts` — `swag-card` (`title`), `src/components/alert.ts` — `swag-alert` (`kind`).
- `src/index.ts` — реэкспорт всего перечисленного.
- `test/http.test.ts` — AC-014-19 (403 без `renew`, `401` → `renew` → повтор, два одновременных `401` → один `renew`).
- `package.json` — `exports`: `.` → `./src/index.ts`, `./styles/*` → `./styles/*`.
- `tsconfig.json` — проверка через корневой `tsconfig.json` (`references`), поэтому `npm run typecheck` проверяет пакет. Настройки Angular — как у `apps/ui/cabinet/tsconfig.json`: `moduleResolution: bundler`, `module: preserve`, `experimentalDecorators: false`, DOM. Кабинет в корневые `references` не входит (его собирает `ng build`). Для `references` нужны `composite` и `outDir: dist` (каталог в `.gitignore`), как у `ui-core`.

## Ключевые решения

- `createRequest` не зависит от Angular: принимает `RequestSession` (`accessToken`, `renew`), тесты идут в Node без TestBed.
- Одновременные `401` делят один `renew()` внутри `createRequest` (промис хранится до завершения). Keeper из `ui-core` делит refresh ещё раз — это его собственная гарантия.
- Неудача `renew()` — ошибка `401` уходит вызывающему; выход из сессии выполняет keeper и вызывает `onSignedOut`. `createRequest` на `onSignedOut` не подписан и сам его не вызывает.
- `authApi` не использует `createRequest`: у входа и обновления нет Bearer, а `refresh` сам вызывается keeper'ом (иначе цикл).
- `HttpError` из `@swag/ui-angular` и `HttpError` из `@swag/helpers/server` (повтор с задержкой, 004) — разные классы с разными конструкторами. Импортировать каждый из своего пакета.
- Тело ошибки, которое не JSON, даёт `HttpError` с кодом `'unknown'` (раньше в кабинете это был `SyntaxError`).
- `CurrentUser.me` публичен только для чтения: `Signal` без `set` снаружи.
- `@angular/forms` 22.2.3 — явная зависимость. Без неё `npm install` не сходится: `@angular/cdk@22.2.3` требует `@angular/forms` в диапазоне `^22`, и npm берёт `22.2.4`, у которого peer `@angular/common` 22.2.4. Тот же приём, что в T-1 для `@angular/compiler-cli`.
- Версия `@angular/cdk` — 22.2.3: есть в npm (`npm view @angular/cdk@22.2.3 version`), совпадает с остальными `@angular/*`.
- Пакет подключается по workspace (`packages/*` в `package.json` корня), без `paths`: `node_modules/@swag/ui-angular` ведёт сюда.
- Стили подключаются в `apps/ui/cabinet/angular.json` (`build.options.styles`) по имени пакета: `@swag/ui-angular/styles/tokens.css`, затем `base.css`. Сборка `ng build` резолвит `exports` без путей `../../../packages/...`; `<style>` из `index.html` кабинета удалён.
- `ThemeService`: «system» — атрибут `data-theme` снимается, тему выбирает `prefers-color-scheme` через `tokens.css`; «light» и «dark» — атрибут на `<html>`, перекрывает системную тему. `localStorage` и его ошибки (приватный режим) — в `try/catch`, при недоступности выбор живёт до перезагрузки. Трактовка API (`mode` signal, `setMode`) — D-133.
- `base.css` задаёт `color-scheme: light dark` на `:root`, с `data-theme` — `light` или `dark` соответственно: нативные контролы браузера совпадают с темой.

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

- Тестов Angular-части нет (нет TestBed-раннера). `session.ts` проверяется сборкой кабинета (`ng build`) и ручной проверкой.

## Связи

- Потребители: `apps/ui/cabinet` (`@swag/cabinet`); каркас и remote-приложения (014, 4.7).
- Использует: `@swag/ui-core` (порты, `createAuthSessionKeeper`), `@swag/contracts`.

## Спеки

- 014 — 4.7, 4.8 (токены), 4.1, 4.3, AC-014-10 (контраст и литералы, тест в `scripts/ui-config.test.ts`), AC-014-19, REQ-014-16, REQ-014-21, T-5, T-6, T-7, T-8. Открытые: D-133 (`ThemeService`), D-134 (цвета статусов графа).
- 024 — 4.15 (сессия, `/auth`).
- 013 — 4.11 (баланс, `/auth/me`, D-130).

## Базовые компоненты (T-9, спека 014, 4.8, REQ-014-17, REQ-014-22)

- `button[swag-button]` — директива на нативной `<button>`, а не компонент `<swag-button>`: `type` остаётся нативным, поэтому submit внутри формы работает без нового входа. `busy` ставит нативный `disabled` и `aria-busy="true"`. Варианты `.swag-button--*` стилизуются в `styles/base.css`, рядом с общими правилами `button`.
- `swag-field` — подпись оборачивает проецируемый контрол в `<label>`, ошибка выводится `<p>` с id. Директивы нет: после каждого рендера компонент находит первый `input`, `select` или `textarea` внутри себя и выставляет ему `aria-describedby` (id ошибки) и `aria-invalid`. При пустой ошибке атрибуты снимаются. Трактовка — ради 4.8 без лишнего входа.
- `swag-card` — `<section>` с заголовком `h2`. `swag-alert` — `role="alert"` для `kind="error"`, иначе `role="status"`; вид выставляется атрибутом `data-kind` на хосте.
- Видимый фокус (REQ-014-22) — глобальное правило `:focus-visible` в `styles/base.css`, обводка `--swag-color-focus`.
- Проверка: пакет собирается тайпчеком; `ng build` кабинета пока не использует компоненты, их шаблоны проверятся в T-10 (панель баланса).
