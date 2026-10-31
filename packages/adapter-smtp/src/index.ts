import nodemailer from 'nodemailer';
import type { MailMessage, Mailer } from '@swag/identity-core';

// Спека 012, 4.7: отправка писем по SMTP на nodemailer. Текст plain, без HTML (4.6).

export function createSmtpMailer({
  url,
  from,
  timeoutMs,
}: {
  url: string;
  from: string;
  timeoutMs: number;
}): Mailer {
  const transport = nodemailer.createTransport({
    url,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
  return {
    async send({ to, subject, text }: MailMessage): Promise<void> {
      await transport.sendMail({ from, to, subject, text });
    },
  };
}
