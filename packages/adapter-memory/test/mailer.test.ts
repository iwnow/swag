import { describe, expect, it } from 'vitest';
import { createMemoryMailer } from '../src/index.ts';

const message = { to: 'a@example.test', subject: 'Тема', text: 'Текст' };

describe('createMemoryMailer', () => {
  it('send сохраняет письмо в sent', async () => {
    const mailer = createMemoryMailer();

    await mailer.send(message);

    expect(mailer.sent).toEqual([message]);
  });

  it('fail = true: send отвергает и письмо не сохраняется', async () => {
    const mailer = createMemoryMailer();
    mailer.fail = true;

    await expect(mailer.send(message)).rejects.toThrow();
    expect(mailer.sent).toEqual([]);
  });
});
