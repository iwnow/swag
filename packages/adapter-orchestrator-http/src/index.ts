import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { OrchestratorClient } from '@swag/api-core';
import { NodeInvocationResult, type NodeInvocation, type SwarmLaunch } from '@swag/contracts';
import type { NodeInvoker } from '@swag/scheduler-core';

// Спека 001, 4.6.1 и Q-6: api → orchestrator по HTTP.
// Спека 016, 4.5: вызов в клиентском спане, traceparent текущего контекста — в заголовке запроса.
// Спека 024, 4.13: каждый запрос несёт Authorization: Bearer <ORCHESTRATOR_TOKEN>.
// Спека 013, 4.9 (из N-25): таймаут launch и stop; срабатывание — та же ошибка, что недоступность.
// Спека 033, 4.10: invokeNode — POST /node-invocations, таймаут invocation.timeoutMs + 10000.
export interface OrchestratorHttpOptions {
  baseUrl: string; // ORCHESTRATOR_URL, например http://orchestrator:3001
  token: string; // ORCHESTRATOR_TOKEN
  timeoutMs: number;
  fetch?: typeof fetch;
}

const TRACER = '@swag/adapter-orchestrator-http';
const NODE_INVOKE_GRACE_MS = 10_000; // запас над таймаутом вызова узла на сеть и разбор ответа

export function createOrchestratorHttpClient(
  options: OrchestratorHttpOptions,
): OrchestratorClient & NodeInvoker {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const server = new URL(base);

  // Явная передача заголовка без автоинструментации fetch: видно, что уходит, и нет патчинга undici.
  async function post(
    path: string,
    body?: string,
    timeoutMs = options.timeoutMs,
  ): Promise<Response> {
    const url = `${base}${path}`;
    return trace.getTracer(TRACER).startActiveSpan(
      'POST',
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'http.request.method': 'POST',
          'url.full': url,
          'server.address': server.hostname,
          'server.port': Number(server.port || 80),
        },
      },
      async (span) => {
        try {
          const headers: Record<string, string> = { authorization: `Bearer ${options.token}` };
          propagation.inject(context.active(), headers);
          if (body !== undefined) headers['content-type'] = 'application/json';
          const response = await doFetch(url, {
            method: 'POST',
            headers,
            ...(body === undefined ? {} : { body }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          span.setAttribute('http.response.status_code', response.status);
          if (response.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
          return response;
        } catch (error) {
          span.recordException(error instanceof Error ? error : String(error));
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  return {
    async launch(launch: SwarmLaunch): Promise<void> {
      const { status } = await post('/swarms', JSON.stringify(launch));
      if (status !== 202) {
        throw new Error(`оркестратор ответил ${status} на запуск роя`);
      }
    },

    async stop(swarmId: string): Promise<void> {
      const { status } = await post(`/swarms/${encodeURIComponent(swarmId)}/stop`);
      if (status !== 202) {
        throw new Error(`оркестратор ответил ${status} на остановку роя`);
      }
    },

    async invokeNode(invocation: NodeInvocation): Promise<NodeInvocationResult> {
      const timeoutMs = (invocation.timeoutMs ?? options.timeoutMs) + NODE_INVOKE_GRACE_MS;
      const response = await post('/node-invocations', JSON.stringify(invocation), timeoutMs);
      if (!response.ok) {
        throw new Error(`оркестратор ответил ${response.status} на вызов узла`);
      }
      return NodeInvocationResult.parse(await response.json());
    },
  };
}
