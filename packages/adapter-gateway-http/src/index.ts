import { LlmSwarmClosed, type LlmSwarmRegistration } from '@swag/contracts';
import type { LlmSwarms } from '@swag/orchestrator-core';

// Спека 004, 4.6: адаптер порта LlmSwarms оркестратора к внутреннему API gateway (4.2) на fetch.
// Повторов нет: рой с недоступным gateway падает сразу (4.6).

export interface GatewaySwarmsOptions {
  baseUrl: string; // LLM_GATEWAY_URL, например http://llm-gateway:3002
  token: string; // LLM_GATEWAY_TOKEN
  timeoutMs: number; // таймаут одного запроса, задаёт оболочка
}

// Ошибка ответа gateway: код из тела `{ error: { message, code } }` (4.2, 4.12).
export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
  }
}

async function readError(response: Response): Promise<GatewayError> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: unknown; code?: unknown };
  } | null;
  const code = typeof body?.error?.code === 'string' ? body.error.code : `http_${response.status}`;
  const message =
    typeof body?.error?.message === 'string'
      ? body.error.message
      : `gateway HTTP ${response.status}`;
  return new GatewayError(response.status, code, message);
}

export function createGatewaySwarms(options: GatewaySwarmsOptions): LlmSwarms {
  const authorization = `Bearer ${options.token}`;
  // content-type — только у запроса с телом: пустой JSON-запрос close gateway отвергает 400 (Fastify).
  const send = (path: string, body: string | null) =>
    fetch(`${options.baseUrl}${path}`, {
      method: 'POST',
      headers:
        body === null ? { authorization } : { authorization, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(options.timeoutMs),
    });

  return {
    async register(reg: LlmSwarmRegistration): Promise<void> {
      const response = await send('/internal/swarms', JSON.stringify(reg));
      if (response.status !== 204) throw await readError(response);
    },

    // 200 — тело LlmSwarmClosed (013, 4.6), возвращаем spentMicroUsd; 404 — рой уже не зарегистрирован, null.
    async close(swarmId: string): Promise<number | null> {
      const response = await send(`/internal/swarms/${encodeURIComponent(swarmId)}/close`, null);
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) throw await readError(response);
      const parsed = LlmSwarmClosed.safeParse(await response.json());
      if (!parsed.success) throw new Error('gateway close: ответ не по схеме LlmSwarmClosed');
      return parsed.data.spentMicroUsd;
    },
  };
}
