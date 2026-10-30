# @swag/helpers

Общие хелперы без зависимостей: повтор запроса с экспоненциальной задержкой, полным разбросом и `Retry-After` (004, 4.10). Две точки входа по [скиллу refactor](../../.claude/skills/refactor/SKILL.md#устройство-пакета):

- `@swag/helpers` — универсальные функции: без `node:*`, `process`, `window`, `document`. Пригодны оболочкам, адаптерам и фронтендам.
- `@swag/helpers/server` — хелперы над `fetch` и ошибками HTTP. Импортируют только адаптеры и оболочки.

## Задачи

- `retry(fn, options)` — повторяет `fn(attempt)` (нумерация с 1), пока `retryable(err)` не вернёт `false` или не кончились попытки. Задержка перед попыткой `n + 1`: `min(maxMs, max(random() · min(maxMs, baseMs · 2^(n−1)), afterMs))`.
- `HttpError` — ошибка ответа с `status` и `retryAfterMs`.
- `httpRetryable(err)` — повторяемы сетевые ошибки (`TypeError` из `fetch`), таймаут (`AbortError`, `TimeoutError`), `HttpError` 408, 429 и 5xx. Для `HttpError` с `Retry-After` возвращает `{ afterMs }`.
- `parseRetryAfter(value, now)` — заголовок `Retry-After` в миллисекундах: целые секунды или HTTP-дата; иначе `null`.

## Что внутри сейчас

- `src/index.ts` — `retry`, `RetryOptions`.
- `src/server/index.ts` — `HttpError`, `httpRetryable`, `parseRetryAfter`.
- `src/env.d.ts` — минимальные описания `AbortSignal`, `setTimeout`, `clearTimeout` для типов без DOM и `@types/node`.
- `test/retry.test.ts` — AC-004-31: паузы, неповторяемая ошибка, все попытки неудачны, прерывание `signal` во время паузы.
- `test/server.test.ts` — AC-004-31: классификация `httpRetryable` и разбор `parseRetryAfter`.

## Ключевые решения

- Две точки входа, а не один файл: `retry` нужен и фронтендам, а `HttpError` и разбор `Retry-After` — только серверу. Раздельные subpath-экспорты не дают браузерному коду тянуть серверные части.
- Ядрам пакет не разрешён: белый список `arch:check` (`CORE_ALLOWED_PACKAGES`) не расширен, как требует 4.10. Ядро, которому нужен повтор, получает его через порт оболочки.
- Вызовы моделей через LiteLLM хелпер не используют: там повторяют LiteLLM и OpenAI SDK (022, Q-4).
- `sleep`, `random` и `signal` — опции, а не глобалы: тесты подменяют их фейками.
- Один `tsconfig` без `types` и без DOM на оба каталога: серверной части не нужны типы `fetch` или `@types/node`, поэтому отдельный проект не понадобился. `AbortSignal`, `setTimeout` и `clearTimeout` в `ES2023` нет, их описания — в `src/env.d.ts`, минимальные и только для используемого.
- `HttpError.name = 'HttpError'` — читаемый `err.name` в логах и стеке (иначе `Error`).
- `src/env.d.ts` — минимальные глобальные объявления `AbortSignal`, `setTimeout`, `clearTimeout`: универсальная точка входа собирается без DOM и `@types/node`. Файл только с объявлениями, в JS не эмитится; пакет отдаёт исходники через `exports`, `dist` нет, потребителей эти объявления не получают.
- `httpRetryable` считает повторяемой любую `TypeError`: отличить ошибку `fetch` от ошибки кода по типу нельзя. Цена — лишние повторы при багах, которые бросают `TypeError`.

## Ограничения

- `retry` не ограничивает общее время, только число попыток и `maxMs` на паузу.
- Отмена через `signal` ловится до попытки и во время паузы; если `fn` бросила `AbortError` сама, `httpRetryable` считает это повторяемым, а дальше сработает проверка `signal`.

## Связи

- Используют: адаптеры и оболочки, которые ходят по сети (`@swag/helpers` и `@swag/helpers/server`).
- Не используют ничего из воркспейса: зависимостей нет.
- Ядра (`*-core`, `contracts`, `api-integration`) пакет не импортируют (4.10, `arch:check` не менялся).

## Спеки

- 004 — `retry` и хелперы `fetch` ([4.10](../../docs/spec/004-money.md#410-swaghelpers-повтор-из-n-10), REQ-004-21, AC-004-31).
- 022 — вызовы через LiteLLM без хелпера (Q-4).
