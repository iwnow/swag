import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSmtpMailer } from '../src/index.ts';

// Спека 012, 4.7, 4.11, AC-012-28 [stack]. Нужен Mailpit из compose: STACK_TEST_MAILPIT_URL — его UI/API
// (например http://127.0.0.1:8025). SMTP-порт Mailpit — 1025 на том же хосте (трактовка, см. журнал T-15).
// Письма читаются через API Mailpit: GET /api/v1/search, GET /api/v1/message/{ID}.

const mailpitUrl = process.env['STACK_TEST_MAILPIT_URL'];
const FROM = 'Swag <no-reply@swag.local>';
const SMTP_PORT = 1025;

type SearchResult = { messages: { ID: string }[] | null };
type MailpitMessage = { Subject: string; From: { Address: string }; Text: string };

describe.skipIf(!mailpitUrl)('adapter-smtp [stack]', () => {
  it('AC-012-28: письмо доходит до Mailpit с темой, отправителем MAIL_FROM и текстом', async () => {
    const api = mailpitUrl ?? '';
    const smtpUrl = `smtp://${new URL(api).hostname}:${SMTP_PORT}`;
    const mailer = createSmtpMailer({ url: smtpUrl, from: FROM, timeoutMs: 5000 });

    const to = `ac28-${randomUUID()}@example.test`;
    const subject = `AC-012-28 ${randomUUID()}`;
    const text = `Тело письма ${randomUUID()}`;
    await mailer.send({ to, subject, text });

    const search = (await fetch(
      `${api}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
    ).then((r) => r.json())) as SearchResult;
    expect(search.messages).toHaveLength(1);
    const id = search.messages?.[0]?.ID;

    const message = (await fetch(`${api}/api/v1/message/${id}`).then((r) =>
      r.json(),
    )) as MailpitMessage;
    expect(message.Subject).toBe(subject);
    expect(message.From.Address).toBe('no-reply@swag.local');
    expect(message.Text).toContain(text);
  });
});
