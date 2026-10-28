import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  runAgentLoop,
  type AgentCallContext,
  type AgentStep,
  type AgentTool,
  type ChatModel,
  type ChatModelRequest,
  type ChatModelResult,
  type ToolCall,
  type ToolOutcome,
} from '../src/index.ts';

// Скриптовый ChatModel: отдаёт заранее заданные ответы по порядку и запоминает запросы.
function scripted(script: ChatModelResult[]) {
  const requests: ChatModelRequest[] = [];
  const model: ChatModel = {
    complete: async (request) => {
      requests.push(request);
      const next = script.shift();
      if (next === undefined) throw new Error('script exhausted');
      return next;
    },
  };
  return { model, requests };
}

// Модель, которая на каждый запрос отвечает одинаково.
function always(result: ChatModelResult) {
  const requests: ChatModelRequest[] = [];
  const model: ChatModel = {
    complete: async (request) => {
      requests.push(request);
      return result;
    },
  };
  return { model, requests };
}

const reply = (content: string | null, toolCalls: ToolCall[] = []): ChatModelResult => ({
  ok: true,
  message: { content, tool_calls: toolCalls },
});
const call = (id: string, name: string, args: string): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: args },
});
const tool = (name: string, execute: (args: unknown) => Promise<ToolOutcome>): AgentTool => ({
  definition: { name, description: name, parameters: { type: 'object' } },
  execute,
});
const echo = (name: string) =>
  tool(name, async (args) => ({ content: `${name}:${JSON.stringify(args)}` }));

function recorder() {
  const steps: AgentStep[] = [];
  return { steps, onStep: async (step: AgentStep) => void steps.push(step) };
}

const context = (overrides: Partial<AgentCallContext> = {}): AgentCallContext => ({
  model: 'chat-small',
  systemPrompt: 'SYS',
  history: [
    { role: 'user', content: 'h1' },
    { role: 'assistant', content: 'a1' },
  ],
  input: { role: 'user', content: 'задача' },
  tools: [],
  limits: { maxSteps: 10, maxTokens: 256 },
  ...overrides,
});

describe('agent loop', () => {
  it('AC-022-3: текстовый ответ — kind text, один шаг, onStep один раз, модель получила system, history и input', async () => {
    const { model, requests } = scripted([reply('ответ')]);
    const rec = recorder();
    const result = await runAgentLoop({ model, onStep: rec.onStep }, context());

    expect(result).toMatchObject({ kind: 'text', text: 'ответ', steps: 1 });
    expect(result.messages).toEqual([
      { role: 'user', content: 'задача' },
      { role: 'assistant', content: 'ответ' },
    ]);
    expect(rec.steps).toEqual([{ stepIndex: 1, text: 'ответ', toolCalls: [] }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'h1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'задача' },
    ]);
    expect(requests[0]?.maxTokens).toBe(256);
    expect(requests[0]?.model).toBe('chat-small');
  });

  it('AC-022-4: один tool_call — инструмент получил разобранные аргументы, второй запрос содержит assistant и tool с тем же id, итог text', async () => {
    const received: unknown[] = [];
    const probe = tool('probe', async (args) => {
      received.push(args);
      return { content: 'готово' };
    });
    const { model, requests } = scripted([
      reply(null, [call('c1', 'probe', '{"x":1}')]),
      reply('финал'),
    ]);
    const rec = recorder();
    const result = await runAgentLoop({ model, onStep: rec.onStep }, context({ tools: [probe] }));

    expect(received).toEqual([{ x: 1 }]);
    expect(requests[1]?.messages.slice(-3)).toEqual([
      { role: 'user', content: 'задача' },
      { role: 'assistant', content: null, tool_calls: [call('c1', 'probe', '{"x":1}')] },
      { role: 'tool', tool_call_id: 'c1', content: 'готово' },
    ]);
    expect(result).toMatchObject({ kind: 'text', text: 'финал', steps: 2 });
    expect(rec.steps[0]).toEqual({
      stepIndex: 1,
      text: null,
      toolCalls: [{ id: 'c1', name: 'probe' }],
    });
  });

  it('AC-022-5: два tool_calls — второй стартует до конца первого, tool-результаты идут в порядке tool_calls', async () => {
    const order: string[] = [];
    let releaseA: () => void = () => undefined;
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const slow = tool('a', async () => {
      order.push('a-start');
      await aGate;
      order.push('a-end');
      return { content: 'A' };
    });
    const fast = tool('b', async () => {
      order.push('b-start');
      releaseA();
      order.push('b-end');
      return { content: 'B' };
    });
    const { model, requests } = scripted([
      reply(null, [call('c1', 'a', '{}'), call('c2', 'b', '{}')]),
      reply('done'),
    ]);
    const result = await runAgentLoop(
      { model, onStep: recorder().onStep },
      context({ tools: [slow, fast] }),
    );

    expect(order).toEqual(['a-start', 'b-start', 'b-end', 'a-end']);
    expect(requests[1]?.messages.filter((m) => m.role === 'tool')).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'A' },
      { role: 'tool', tool_call_id: 'c2', content: 'B' },
    ]);
    expect(result).toMatchObject({ kind: 'text', steps: 2 });
  });

  it('AC-022-6: текст и tool_call в одном ответе — onStep получил оба, инструмент исполнен', async () => {
    const probe = echo('probe');
    const { model } = scripted([reply('думаю', [call('c1', 'probe', '{"q":2}')]), reply('ok')]);
    const rec = recorder();
    const result = await runAgentLoop({ model, onStep: rec.onStep }, context({ tools: [probe] }));

    expect(rec.steps[0]).toEqual({
      stepIndex: 1,
      text: 'думаю',
      toolCalls: [{ id: 'c1', name: 'probe' }],
    });
    expect(result.messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: 'probe:{"q":2}',
    });
    expect(result).toMatchObject({ kind: 'text', text: 'ok', steps: 2 });
  });

  it('AC-022-7: неизвестное имя, невалидный JSON и бросающий инструмент дают error-результаты, цикл продолжается', async () => {
    const boom = tool('boom', async () => {
      throw new Error('сломался');
    });
    const { model, requests } = scripted([
      reply(null, [call('c1', 'nope', '{}'), call('c2', 'boom', '{bad'), call('c3', 'boom', '{}')]),
      reply('дальше'),
    ]);
    const result = await runAgentLoop(
      { model, onStep: recorder().onStep },
      context({ tools: [boom] }),
    );

    expect(requests[1]?.messages.filter((m) => m.role === 'tool')).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'error: unknown tool nope' },
      { role: 'tool', tool_call_id: 'c2', content: 'error: invalid JSON arguments' },
      { role: 'tool', tool_call_id: 'c3', content: 'error: сломался' },
    ]);
    expect(result).toMatchObject({ kind: 'text', text: 'дальше', steps: 2 });
  });

  it('AC-022-8: при stop от одного из двух инструментов оба исполнены, kind stopped, третьего вызова модели нет', async () => {
    const executed: string[] = [];
    const plain = tool('plain', async () => {
      executed.push('plain');
      return { content: 'P' };
    });
    const finish = tool('finish', async () => {
      executed.push('finish');
      return { content: 'F', stop: { result: 'итог' } };
    });
    const { model, requests } = scripted([
      reply(null, [call('c1', 'plain', '{}'), call('c2', 'finish', '{}')]),
    ]);
    const result = await runAgentLoop(
      { model, onStep: recorder().onStep },
      context({ tools: [plain, finish] }),
    );

    expect(executed.sort()).toEqual(['finish', 'plain']);
    expect(result).toMatchObject({ kind: 'stopped', result: 'итог', steps: 1 });
    expect(requests).toHaveLength(1);
  });

  it('AC-022-8: при stop у нескольких инструментов результат берётся у первого в порядке tool_calls', async () => {
    const first = tool('first', async () => ({ content: '1', stop: { result: 'первый' } }));
    const second = tool('second', async () => ({ content: '2', stop: { result: 'второй' } }));
    const { model } = scripted([
      reply(null, [call('c1', 'first', '{}'), call('c2', 'second', '{}')]),
    ]);
    const result = await runAgentLoop(
      { model, onStep: recorder().onStep },
      context({ tools: [first, second] }),
    );

    expect(result).toMatchObject({ kind: 'stopped', result: 'первый' });
  });

  it('AC-022-9: maxSteps 2 при всегда tool_call — ровно 2 вызова модели и max_steps', async () => {
    const { model, requests } = always(reply(null, [call('c1', 'probe', '{}')]));
    const result = await runAgentLoop(
      { model, onStep: recorder().onStep },
      context({ tools: [echo('probe')], limits: { maxSteps: 2, maxTokens: 256 } }),
    );

    expect(requests).toHaveLength(2);
    expect(result).toMatchObject({ kind: 'max_steps', steps: 2 });
  });

  it('AC-022-9: maxSteps 0 — ни одного вызова модели и max_steps', async () => {
    const { model, requests } = always(reply('не должно быть'));
    const result = await runAgentLoop(
      { model, onStep: recorder().onStep },
      context({ limits: { maxSteps: 0, maxTokens: 256 } }),
    );

    expect(requests).toHaveLength(0);
    expect(result).toMatchObject({ kind: 'max_steps', steps: 0, messages: [context().input] });
  });

  it('AC-022-10: ошибка модели rate_limited — kind model_error с этим кодом, инструменты не вызываются', async () => {
    const { model, requests } = always({
      ok: false,
      error: { code: 'rate_limited', message: 'слишком часто' },
    });
    const rec = recorder();
    const result = await runAgentLoop({ model, onStep: rec.onStep }, context());

    expect(result).toEqual({
      kind: 'model_error',
      error: { code: 'rate_limited', message: 'слишком часто' },
      steps: 1,
      messages: [context().input],
    });
    expect(requests).toHaveLength(1);
    expect(rec.steps).toEqual([]);
  });

  it('AC-022-11: loop.ts импортирует только import type из @swag/contracts', () => {
    const file = fileURLToPath(new URL('../src/loop.ts', import.meta.url));
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const imports = source.statements.filter(ts.isImportDeclaration).map((node) => ({
      module: (node.moduleSpecifier as ts.StringLiteral).text,
      typeOnly: node.importClause?.isTypeOnly === true,
    }));

    expect(imports).toEqual([{ module: '@swag/contracts', typeOnly: true }]);
  });
});
