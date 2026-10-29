import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError } from 'openai';
import type {
  ChatModel,
  ChatModelErrorCode,
  ChatModelRequest,
  ChatModelResult,
  ToolCall,
} from '@swag/agent-core';
import {
  AGENT_ID_HEADER,
  GatewayErrorCode,
  SWARM_ID_HEADER,
  type LlmCaller,
} from '@swag/contracts';

// Спека 022, 4.3: порт ChatModel поверх OpenAI SDK. Ходит только в llm-gateway.

export interface OpenAiChatModelOptions {
  baseUrl: string; // LLM_GATEWAY_URL, например http://llm-gateway:3002/v1
  token: string; // LLM_GATEWAY_TOKEN
  caller: LlmCaller; // → x-swag-swarm-id, x-swag-agent-id
  traceparent(): string | null; // currentTraceparent из adapter-telemetry; null — заголовок не ставится
  timeoutMs: number; // AGENT_LLM_TIMEOUT_MS
  maxRetries: number; // AGENT_LLM_MAX_RETRIES, повторы SDK (Q-4)
}

export function createOpenAiChatModel(options: OpenAiChatModelOptions): ChatModel {
  const client = new OpenAI({
    baseURL: options.baseUrl,
    apiKey: options.token,
    timeout: options.timeoutMs,
    maxRetries: options.maxRetries,
    defaultHeaders: {
      [SWARM_ID_HEADER]: options.caller.swarmId,
      [AGENT_ID_HEADER]: options.caller.agentId,
    },
  });
  // Пустой токен не редактируем: replaceAll('') вставил бы *** между всеми символами.
  const redact = (text: string): string =>
    options.token === '' ? text : text.replaceAll(options.token, '***');

  return {
    async complete(request: ChatModelRequest): Promise<ChatModelResult> {
      const traceparent = options.traceparent();
      try {
        const completion = await client.chat.completions.create(
          {
            model: request.model,
            messages: request.messages,
            ...(request.tools.length > 0 && {
              tools: request.tools.map((definition) => ({
                type: 'function',
                function: definition,
              })),
            }),
            max_tokens: request.maxTokens,
            stream: false,
          },
          traceparent === null ? undefined : { headers: { traceparent } },
        );
        const choice = completion.choices[0];
        if (choice === undefined) {
          return fail('invalid_response', 'В ответе нет choices[0]');
        }
        // Обрезанный ответ неполон даже с текстом или вызовами (4.3, D-85).
        if (choice.finish_reason === 'length') {
          return fail(
            'max_tokens',
            `Ответ обрезан по лимиту max_tokens (${String(request.maxTokens)}): модель не уложилась в лимит`,
          );
        }
        return {
          ok: true,
          message: {
            content: choice.message.content,
            tool_calls: toolCalls(choice.message.tool_calls),
          },
        };
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error));
        return fail(errorCode(error), message);
      }
    },
  };
}

const fail = (code: ChatModelErrorCode, message: string): ChatModelResult => ({
  ok: false,
  error: { code, message },
});

// Только function-вызовы: порт описывает ToolCall с type 'function', custom-вызовы шлюз не отдаёт.
function toolCalls(
  calls: { id: string; type: string; function?: { name: string; arguments: string } }[] | undefined,
): ToolCall[] {
  return (calls ?? []).flatMap((call) =>
    call.type === 'function' && call.function !== undefined
      ? [{ id: call.id, type: 'function', function: call.function }]
      : [],
  );
}

// Тело ошибки шлюза — `{ error: { code } }`; без кода в теле 429 — rate_limited, прочее — upstream_error.
function errorCode(error: unknown): ChatModelErrorCode {
  if (error instanceof APIConnectionTimeoutError) return 'timeout';
  if (error instanceof APIConnectionError) return 'network';
  if (error instanceof APIError) {
    const gatewayCode = GatewayErrorCode.safeParse(error.code);
    if (gatewayCode.success) return gatewayCode.data;
    return error.status === 429 ? 'rate_limited' : 'upstream_error';
  }
  return 'invalid_response';
}
