import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { OrchestratorClient } from '@swag/api-core';
import type { SwarmLaunch } from '@swag/contracts';

// Спека 001, 4.6.1 и Q-6: api → orchestrator по HTTP.
// Спека 016, 4.5: вызов в клиентском спане, traceparent текущего контекста — в заголовке запроса.
// Спека 024, 4.13: каждый запрос несёт Authorization: Bearer <ORCHESTRATOR_TOKEN>.
export interface OrchestratorHttpOptions {
  baseUrl: string; // ORCHESTRATOR_URL, например http://orchestrator:3001
  token: string; // ORCHESTRATOR_TOKEN
  fetch?: typeof fetch;
}

const TRACER = '@swag/adapter-orchestrator-http';

export function createOrchestratorHttpClient(options: OrchestratorHttpOptions): OrchestratorClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const server = new URL(base);

  // Явная передача заголовка без автоинструментации fetch: видно, что уходит, и нет патчинга undici.
  async function post(path: string, body?: string): Promise<number> {
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
          });
          span.setAttribute('http.response.status_code', response.status);
          if (response.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
          return response.status;
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
      const status = await post('/swarms', JSON.stringify(launch));
      if (status !== 202) {
        throw new Error(`оркестратор ответил ${status} на запуск роя`);
      }
    },

    async stop(swarmId: string): Promise<void> {
      const status = await post(`/swarms/${encodeURIComponent(swarmId)}/stop`);
      if (status !== 202) {
        throw new Error(`оркестратор ответил ${status} на остановку роя`);
      }
    },
  };
}
