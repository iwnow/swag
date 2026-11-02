import { defineNode } from '@swag/node-sdk';
import { z } from 'zod';

// Фикстура 4.8: ответ state с error доходит до узла исключением; узел перехватывает его и пишет в лог.
export default defineNode({
  type: 'test/state-error',
  version: '1.0.0',
  kind: 'program',
  title: 'Ошибка state',
  description: 'Фикстура: ctx.state.get, на который родитель отвечает ошибкой.',
  settings: z.strictObject({}),
  inputs: z.strictObject({}),
  outputs: z.strictObject({}),
  execute: async (_input, ctx) => {
    try {
      await ctx.state.get('k');
    } catch (error) {
      ctx.log.warn(error instanceof Error ? error.message : String(error));
    }
    return {};
  },
});
