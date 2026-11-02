import { z } from 'zod';
import { defineNode } from '../src/index.ts';

// Копия example/echo из спеки 021, 4.4 (AC-021-11).
export const echo = defineNode({
  type: 'example/echo',
  version: '1.0.0',
  kind: 'program',
  title: 'Эхо',
  description: 'Пример программы: возвращает входной текст с префиксом из настроек.',
  settings: z.strictObject({ prefix: z.string().max(40).default('') }),
  inputs: z.strictObject({ text: z.string().max(4000) }),
  outputs: z.strictObject({ text: z.string() }),
  execute: async ({ text }, ctx) => ({ text: ctx.settings.prefix + text }),
});

// Программа, которая отдаёт выход не по схеме (AC-021-12).
export const wrongOutput = defineNode({
  type: 'example/wrong-output',
  version: '1.0.0',
  kind: 'program',
  title: 'Неверный выход',
  description: 'Фикстура: выход не соответствует схеме.',
  settings: z.strictObject({}),
  inputs: z.strictObject({ text: z.string() }),
  outputs: z.strictObject({ text: z.string() }),
  execute: async () => ({ wrong: true }) as unknown as { text: string },
});

// Коннектор с секретом и egress (AC-021-13).
export const crm = defineNode({
  type: 'example/crm',
  version: '1.0.0',
  kind: 'connector',
  title: 'CRM',
  description: 'Фикстура коннектора: секрет и выход по egress.',
  settings: z.strictObject({}),
  credentials: [{ name: 'apiKey', title: 'Ключ', kind: 'api-key' }],
  egress: ['api.example.com', '*.cdn.example.com'],
  operations: {
    call: {
      title: 'Вызов',
      description: 'Читает секрет и запрашивает адрес.',
      access: 'read',
      input: z.strictObject({ secret: z.string(), url: z.string() }),
      output: z.strictObject({ key: z.string(), status: z.number() }),
      execute: async (input, ctx) => ({
        key: await ctx.secrets.get(input.secret),
        status: (await ctx.http.fetch(input.url)).status,
      }),
    },
  },
});

// Канал: poll пишет состояние, send записывает отправленное сообщение в состояние (AC-021-14).
export const chat = defineNode({
  type: 'example/chat',
  version: '1.0.0',
  kind: 'channel',
  title: 'Чат',
  description: 'Фикстура канала.',
  settings: z.strictObject({}),
  inputs: z.strictObject({ text: z.string() }),
  outputs: z.strictObject({ text: z.string() }),
  poll: async (_cursor, ctx) => {
    await ctx.state.set('seen', 'yes');
    return { events: [{ text: 'hi' }], cursor: 'next' };
  },
  send: async (message, ctx) => {
    await ctx.state.set('sent', message.text);
  },
});

// Канал, poll которого отдаёт событие не по схеме outputs (AC-021-14).
export const badChat = defineNode({
  type: 'example/bad-chat',
  version: '1.0.0',
  kind: 'channel',
  title: 'Плохой чат',
  description: 'Фикстура канала с неверным событием.',
  settings: z.strictObject({}),
  inputs: z.strictObject({ text: z.string() }),
  outputs: z.strictObject({ text: z.string() }),
  poll: async () => ({ events: [{ wrong: true } as unknown as { text: string }], cursor: null }),
  send: async () => {},
});
