import { defineNode } from '@swag/node-sdk';
import { z } from 'zod';

// Фикстура AC-026-20: процесс завершается с кодом 3 до result.
export default defineNode({
  type: 'test/exit',
  version: '1.0.0',
  kind: 'program',
  title: 'Выход',
  description: 'Фикстура: process.exit(3) внутри обработчика.',
  settings: z.strictObject({}),
  inputs: z.strictObject({}),
  outputs: z.strictObject({}),
  execute: async () => {
    process.exit(3);
  },
});
