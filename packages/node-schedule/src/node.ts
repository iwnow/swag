import { defineNode } from '@swag/node-sdk';
import { z } from 'zod';

// Спека 033, 4.5: встроенный триггер; исполняется планировщиком, не через poll узла.
export default defineNode({
  type: 'swag/schedule',
  version: '1.0.0',
  kind: 'trigger',
  title: 'Расписание',
  description:
    'Запуск процесса по интервалу или по cron. Исполняется планировщиком, без песочницы.',
  settings: z.strictObject({
    everySec: z.number().int().min(60).max(604_800).nullable().default(null),
    cron: z.string().trim().min(1).max(100).nullable().default(null), // 5 полей: минута час день месяц день-недели
    timezone: z.string().min(1).max(64).default('UTC'), // IANA
  }),
  outputs: z.strictObject({ scheduledAt: z.iso.datetime(), firedAt: z.iso.datetime() }),
  poll: async () => {
    throw new Error('swag/schedule is run by the scheduler');
  },
});
