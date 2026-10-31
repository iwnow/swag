# @swag/adapter-smtp

Отправка писем identity по SMTP: порт `Mailer` из `@swag/identity-core` на `nodemailer`. Спека 012, 4.7.

## Задачи

- Отправлять письма подтверждения и «аккаунт уже есть» через любой SMTP: Mailpit в разработке, SMTP в проде (REQ-012-2, спека 012, 4.6).
- Отвергать `send` при ошибке отправки или таймауте: это значит «не отправлено», вызывающая сторона решает сама (`mail_unavailable`, REQ-012-18).

## Что внутри сейчас

- `createSmtpMailer({ url, from, timeoutMs })` — `Mailer`: `nodemailer.createTransport({ url, … })`, отправитель — `from` (`MAIL_FROM`), текст plain, без HTML.
- `connectionTimeout`, `greetingTimeout` и `socketTimeout` равны `timeoutMs`.
- `test/smtp.test.ts` — AC-012-28 `[stack]`: письмо читается через API Mailpit. Без `STACK_TEST_MAILPIT_URL` тест пропускается.

## Ограничения

- Только отправка plain-текстом; HTML, вложения и пул соединений не поддерживаются.
- Тест `[stack]` берёт SMTP-адрес из хоста `STACK_TEST_MAILPIT_URL` и порта 1025 (переменной SMTP-адреса в 4.11 нет).

## Связи

- Порт: `Mailer`, `MailMessage` из `@swag/identity-core` (только типы).
- Библиотеки: `nodemailer` 10.1.2 (лицензия MIT-0), `@types/nodemailer` 8.0.2 (dev).
- Потребители: `apps/identity` (T-16); Mailpit из compose (T-17).

## Ключевые решения

- `createTransport({ url, … })` с таймаутами в том же объекте, а не `createTransport(url, options)`: при втором аргументе у `nodemailer` 10.1.2 `connectionTimeout` в `transporter.options` не попадает (проверено: `undefined`), в объектной форме — задан. Отклонение от буквы 4.7 записано в журнале T-15.
- Адаптер не содержит текстов писем: темы и тексты — константы `identity-core` (4.6).

## Спеки

- 012 — 4.6, 4.7, 4.11, AC-012-28; задача T-15.
