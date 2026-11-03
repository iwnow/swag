# @swag/node-schedule

Тип узла `swag/schedule@1.0.0` — встроенный триггер-расписание: запуск процесса по интервалу (`everySec`) или по cron (`cron`, 5 полей, `timezone` IANA, по умолчанию `UTC`). Спека 033, 4.5 и REQ-033-9. Кода у узла нет: срабатывания считает и ставит в очередь планировщик (`apps/scheduler`, `scheduler-core`), не песочница и не оркестратор.

## Задачи

- Дать каталогу типов узлов тип `swag/schedule` вида `trigger` с настройками расписания и выходом `{ scheduledAt, firedAt }`.
- Держать схему настроек в одном месте: `settings` в `src/node.ts`. Манифест выводится из него.

## Что внутри сейчас

- `src/node.ts` — `export default defineNode({...})`: `type: 'swag/schedule'`, `version: '1.0.0'`, `kind: 'trigger'`, `settings` (`everySec`, `cron`, `timezone`, умолчания `null`, `null`, `UTC`), `outputs` (`scheduledAt`, `firedAt` — ISO datetime). `poll` бросает ошибку: опрос делает планировщик.
- `swag-node.json` — манифест, выгруженный командой `npm run nodes:manifest`. Не править руками.
- `test/node.test.ts` — REQ-033-9: манифест совпадает с определением; пакет загружается через `loadNodePackages` (тип, вид `trigger`, `packageOf`); умолчания настроек.

## Как обновить

1. Изменить `settings` или `outputs` в `src/node.ts`.
2. Выполнить `npm run nodes:manifest` из корня репозитория.
3. Запустить `npx vitest run packages/node-schedule`.

## Ограничения

- Кросс-полевые проверки (ровно одно из `everySec` и `cron`, допустимость cron и часового пояса) — в `api` при сохранении процесса (спека 033, 4.5), не в схеме узла.
- Порт `CronSchedule` и адаптер `croner` — в T-8 (`adapter-croner`), а не здесь.
- Тест загрузки передаёт `resolve` напрямую на файл пакета, поэтому не требует ссылки воркспейса в `node_modules`.

## Связи

- Использует: `@swag/node-sdk` (`defineNode`), `zod`.
- Тесты используют: `@swag/node-packages` (`loadNodePackages`) — только в `devDependencies`.
- Имя типа — константа `SCHEDULE_TRIGGER_TYPE` в `@swag/api-integration` (`swag/schedule@1.0.0`).

## Ключевые решения

- Вид `trigger` с `poll` как заглушкой: опрос сторонних триггеров идёт через оркестратор (спека 026), встроенный — через планировщик, поэтому у узла нет кода исполнения (033, 4.5).
- `settings` — `z.strictObject`: лишние поля отклоняются, как в `AgentDraft`.

## Спеки

- 033 — REQ-033-9; 4.5 (`swag/schedule`, `SCHEDULE_TRIGGER_TYPE`); T-2.
