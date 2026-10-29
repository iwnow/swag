import type { GatewayErrorCode, ModelId } from '@swag/contracts';

// Спека 022, 4.2 — агентный цикл. Ядро не знает о рое, шине и событиях: вход — контекст вызова, выход — шаги и итог.

// Формат сообщений — подмножество OpenAI Chat Completions.
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
}

export interface ChatModelRequest {
  model: ModelId;
  messages: ChatMessage[];
  tools: ToolDefinition[]; // пустой — поле tools в запрос не идёт
  maxTokens: number;
}
export type ChatModelErrorCode =
  GatewayErrorCode | 'network' | 'timeout' | 'invalid_response' | 'max_tokens';
export type ChatModelResult =
  | { ok: true; message: { content: string | null; tool_calls: ToolCall[] } } // tool_calls пустой, если их нет
  | { ok: false; error: { code: ChatModelErrorCode; message: string } };

export interface ChatModel {
  complete(request: ChatModelRequest): Promise<ChatModelResult>; // не бросает: любая ошибка — ok: false
}

export interface AgentTool {
  definition: ToolDefinition;
  execute(args: unknown): Promise<ToolOutcome>; // args — уже JSON.parse; проверку схемы делает инструмент
}
export type ToolOutcome = { content: string; stop?: { result: string } };

export interface AgentCallContext {
  model: ModelId;
  systemPrompt: string;
  history: ChatMessage[]; // без system; цикл не мутирует массив
  input: ChatMessage; // новое сообщение, обычно role: user
  tools: AgentTool[];
  limits: { maxSteps: number; maxTokens: number }; // maxSteps — сколько вызовов модели осталось
}
export interface AgentStep {
  stepIndex: number;
  text: string | null;
  toolCalls: { id: string; name: string }[];
}
export type AgentLoopResult = { messages: ChatMessage[]; steps: number } & (
  | { kind: 'text'; text: string | null }
  | { kind: 'stopped'; result: string }
  | { kind: 'max_steps' }
  | { kind: 'model_error'; error: { code: ChatModelErrorCode; message: string } }
);

export async function runAgentLoop(
  deps: { model: ChatModel; onStep(step: AgentStep): Promise<void> },
  context: AgentCallContext,
): Promise<AgentLoopResult> {
  const { model, onStep } = deps;
  const { systemPrompt, history, input, tools, limits } = context;
  const system: ChatMessage = { role: 'system', content: systemPrompt };
  const definitions = tools.map((tool) => tool.definition);
  const messages: ChatMessage[] = [input];
  let steps = 0;

  for (;;) {
    if (steps === limits.maxSteps) return { messages, steps, kind: 'max_steps' };

    const result = await model.complete({
      model: context.model,
      messages: [system, ...history, ...messages],
      tools: definitions,
      maxTokens: limits.maxTokens,
    });
    steps += 1;
    if (!result.ok) return { messages, steps, kind: 'model_error', error: result.error };

    const { content, tool_calls: toolCalls } = result.message;
    messages.push(
      toolCalls.length > 0
        ? { role: 'assistant', content, tool_calls: toolCalls }
        : { role: 'assistant', content },
    );
    await onStep({
      stepIndex: steps,
      text: content,
      toolCalls: toolCalls.map((call) => ({ id: call.id, name: call.function.name })),
    });
    if (toolCalls.length === 0) return { messages, steps, kind: 'text', text: content };

    const runs = await Promise.all(
      toolCalls.map(async (call) => ({ call, outcome: await runTool(tools, call) })),
    );
    for (const { call, outcome } of runs) {
      messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.content });
    }
    const stop = runs.find(({ outcome }) => outcome.stop !== undefined)?.outcome.stop;
    if (stop) return { messages, steps, kind: 'stopped', result: stop.result };
  }
}

// Ошибка инструмента уходит модели текстом `error: …` и не прерывает цикл (REQ-022-3).
async function runTool(tools: AgentTool[], call: ToolCall): Promise<ToolOutcome> {
  const tool = tools.find((candidate) => candidate.definition.name === call.function.name);
  if (!tool) return { content: `error: unknown tool ${call.function.name}` };
  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    return { content: 'error: invalid JSON arguments' };
  }
  try {
    return await tool.execute(args);
  } catch (error) {
    return { content: `error: ${error instanceof Error ? error.message : String(error)}` };
  }
}
