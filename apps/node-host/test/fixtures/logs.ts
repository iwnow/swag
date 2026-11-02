import { defineNode } from '@swag/node-sdk';
import { z } from 'zod';

// Фикстура AC-026-20: логи, прямой вывод в stdout, state и отсутствующий секрет.
export default defineNode({
  type: 'test/logs',
  version: '1.0.0',
  kind: 'program',
  title: 'Логи',
  description: 'Фикстура: ctx.log, console.log, process.stdout, state.get, secrets.get.',
  settings: z.strictObject({}),
  inputs: z.strictObject({}),
  outputs: z.strictObject({}),
  execute: async (_input, ctx) => {
    ctx.log.info('hello', { a: 1 });
    console.log('dbg');
    process.stdout.write('raw\n');
    await ctx.state.get('k');
    await ctx.secrets.get('missing');
    return {};
  },
});
