import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { defineNode, type NodeDefinition, type SettingsOf } from '../src/index.ts';

// Спека 021, 5: AC-021-23. Проверка типов; во время выполнения только вызов it.
describe('типы defineNode', () => {
  it('AC-021-23: настройки и вход программы типизированы схемами', () => {
    const echo = defineNode({
      type: 'example/echo',
      version: '1.0.0',
      kind: 'program',
      title: 'Эхо',
      description: 'Пример программы.',
      settings: z.strictObject({ prefix: z.string().max(40).default('') }),
      inputs: z.strictObject({ text: z.string().max(4000) }),
      outputs: z.strictObject({ text: z.string() }),
      execute: async (input, ctx) => {
        expectTypeOf(ctx.settings.prefix).toEqualTypeOf<string>();
        expectTypeOf(input.text).toEqualTypeOf<string>();
        // @ts-expect-error prefix — строка, присвоить число нельзя
        ctx.settings.prefix = 1;
        // @ts-expect-error в входе нет поля missing
        void input.missing;
        return { text: ctx.settings.prefix + input.text };
      },
    });
    expectTypeOf(echo.settings.parse({})).toEqualTypeOf<{ prefix: string }>();
  });

  it('AC-021-23: определение узла допускается в NodeDefinition', () => {
    const agent = defineNode({
      type: 'swag/llm-agent',
      version: '1.0.0',
      kind: 'llm-agent',
      title: 'LLM-агент',
      description: 'Агент.',
      settings: z.strictObject({ name: z.string() }),
    });
    expectTypeOf(agent).toExtend<NodeDefinition>();
    expectTypeOf<SettingsOf<typeof agent>>().toEqualTypeOf<{ name: string }>();
  });
});
