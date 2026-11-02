import { defineNode } from '@swag/node-sdk';
import { z } from 'zod';

// Фикстура 4.8: хост вне egress отклоняется до сетевого запроса.
export default defineNode({
  type: 'test/egress',
  version: '1.0.0',
  kind: 'program',
  title: 'Egress',
  description: 'Фикстура: ctx.http.fetch на хост вне egress.',
  settings: z.strictObject({}),
  inputs: z.strictObject({}),
  outputs: z.strictObject({}),
  execute: async (_input, ctx) => {
    await ctx.http.fetch('http://example.com');
    return {};
  },
});
