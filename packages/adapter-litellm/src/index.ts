import { context, propagation } from '@opentelemetry/api';
import type {
  ChatRequest,
  LlmUpstream,
  UpstreamFailure,
  UpstreamResponse,
} from '@swag/llm-gateway-core';

// Спека 002, 4.5: адаптер LiteLLM. Таймаут простоя и поток — следующие задачи (T-10, T-11).

export interface LiteLlmOptions {
  baseUrl: string; // LITELLM_URL
  masterKey: string; // LITELLM_MASTER_KEY → Authorization: Bearer
  idleTimeoutMs: number; // LLM_GATEWAY_UPSTREAM_TIMEOUT_MS
  secrets: string[]; // значения, которые заменяются на *** в message
  fetch?: typeof fetch; // для тестов; по умолчанию глобальный
}

const MESSAGE_LIMIT = 1000;

// Пустые строки игнорируются: иначе replaceAll('', '***') вставит маркер между всеми символами.
export function redact(text: string, secrets: string[]): string {
  return secrets.reduce(
    (result, secret) => (secret === '' ? result : result.replaceAll(secret, '***')),
    text,
  );
}

const errorMessage = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const error = body.error;
  if (typeof error !== 'object' || error === null || !('message' in error)) return null;
  return typeof error.message === 'string' ? error.message : null;
};

async function httpFailure(res: Response, options: LiteLlmOptions): Promise<UpstreamFailure> {
  const message = await res.json().then(
    (body: unknown) => errorMessage(body) ?? `HTTP ${res.status}`,
    () => `HTTP ${res.status}`,
  );
  return {
    kind: 'http',
    status: res.status,
    message: redact(message.slice(0, MESSAGE_LIMIT), options.secrets),
  };
}

export function createLiteLlmUpstream(options: LiteLlmOptions): LlmUpstream {
  const send = options.fetch ?? fetch;
  return {
    async complete(body: ChatRequest, signal: AbortSignal): Promise<UpstreamResponse> {
      // Пропагатор глобальный: его ставит startTelemetry из adapter-telemetry; без SDK заголовка не будет.
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        authorization: `Bearer ${options.masterKey}`,
      };
      propagation.inject(context.active(), headers);
      try {
        const res = await send(`${options.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) return { ok: false, failure: await httpFailure(res, options) };
        return { ok: true, body: await res.json() };
      } catch {
        return { ok: false, failure: { kind: 'network' } };
      }
    },
  };
}
