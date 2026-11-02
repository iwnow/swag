import { defineNode } from '@swag/node-sdk';
import { z } from 'zod';

// Фикстура 4.8: вывод без перевода строки в конце сохраняется и уходит раньше result.
export default defineNode({
  type: 'test/stdout',
  version: '1.0.0',
  kind: 'program',
  title: 'Вывод',
  description: 'Фикстура: console.log и незавершённая строка в stdout.',
  settings: z.strictObject({}),
  inputs: z.strictObject({}),
  outputs: z.strictObject({}),
  execute: async () => {
    console.log('first');
    process.stdout.write('no-newline');
    return {};
  },
});
