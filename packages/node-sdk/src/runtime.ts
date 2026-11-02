import type { NodeCall } from '@swag/contracts';
import { z } from 'zod';
import { NodeError, type NodeContext, type NodeDefinition } from './index.ts';

// Спека 026, 4.3 (REQ-026-15). Код без node:* и без process: его используют apps/node-host и тестовая обвязка.

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<корень>'}: ${issue.message}`)
    .join('; ');
}

function check<T>(
  code: 'invalid_settings' | 'invalid_input' | 'invalid_output',
  schema: z.ZodType<T>,
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new NodeError(code, describeIssues(parsed.error));
  return parsed.data;
}

// Вид вызова должен подходить виду узла: execute — программа, operation — коннектор,
// poll — триггер и канал, send — канал. Иначе — unknown_operation.
export async function invokeNode(
  definition: NodeDefinition,
  call: NodeCall,
  ctx: NodeContext<unknown>,
): Promise<unknown> {
  switch (call.kind) {
    case 'execute': {
      if (definition.kind !== 'program') break;
      const input = check('invalid_input', definition.inputs, call.input);
      const output = await definition.execute(input, ctx);
      return check('invalid_output', definition.outputs, output);
    }
    case 'operation': {
      if (definition.kind !== 'connector') break;
      const operation = Object.hasOwn(definition.operations, call.operation)
        ? definition.operations[call.operation]
        : undefined;
      if (!operation)
        throw new NodeError('unknown_operation', `операция ${call.operation} не объявлена`);
      const input = check('invalid_input', operation.input, call.input);
      const output = await operation.execute(input, ctx);
      return check('invalid_output', operation.output, output);
    }
    case 'poll': {
      if (definition.kind !== 'trigger' && definition.kind !== 'channel') break;
      const result = await definition.poll(call.cursor, ctx);
      const events = result.events.map((event) =>
        check('invalid_output', definition.outputs, event),
      );
      return { events, cursor: result.cursor };
    }
    case 'send': {
      if (definition.kind !== 'channel') break;
      const message = check('invalid_input', definition.inputs, call.message);
      await definition.send(message, ctx);
      return null;
    }
  }
  throw new NodeError(
    'unknown_operation',
    `вид вызова ${call.kind} не подходит виду ${definition.kind}`,
  );
}

export function parseSettings(definition: NodeDefinition, settings: unknown): unknown {
  return check('invalid_settings', definition.settings, settings);
}
