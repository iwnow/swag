import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { RunLaunchResult, RunStatusList, type RunLaunchRequest } from '@swag/contracts';
import type { ApiClient } from '@swag/scheduler-core';

// Спека 033, 4.10: scheduler → api по HTTP. Все маршруты с Authorization: Bearer <API_INTERNAL_TOKEN>.
// Спека 016, 4.5: клиентский спан, traceparent текущего контекста — в заголовке запроса.
export interface ApiInternalHttpOptions {
  baseUrl: string; // API_URL, например http://api:3000
  token: string; // API_INTERNAL_TOKEN
  timeoutMs: number; // константа 10000 в оболочке планировщика (4.9)
  fetch?: typeof fetch;
}

const TRACER = '@swag/adapter-api-http';

export function createApiInternalHttpClient(options: ApiInternalHttpOptions): ApiClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const server = new URL(base);

  // Заголовок traceparent передаётся явно, без автоинструментации fetch; обёртка повторяет adapter-orchestrator-http, вынос — N-38.
  async function post(path: string, body: unknown): Promise<Response> {
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
          const headers: Record<string, string> = {
            authorization: `Bearer ${options.token}`,
            'content-type': 'application/json',
          };
          propagation.inject(context.active(), headers);
          const response = await doFetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(options.timeoutMs),
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

  function expectOk(response: Response, what: string): Response {
    if (!response.ok) throw new Error(`api ответил ${response.status} на ${what}`);
    return response;
  }

  return {
    async launchRun(request: RunLaunchRequest) {
      const response = await post('/internal/process-runs', request);
      return RunLaunchResult.parse(await expectOk(response, 'запуск процесса').json());
    },

    async runStatuses(runIds) {
      const response = await post('/internal/process-runs/status', { runIds });
      const { items } = RunStatusList.parse(await expectOk(response, 'статусы запусков').json());
      return new Map(items.map((item) => [item.runId, item.status]));
    },
  };
}
