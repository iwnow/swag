import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { SchedulerClient } from '@swag/api-core';
import { JobState, JobStateList, ProcessRunList, ProcessRunView } from '@swag/contracts';

// Спека 033, 4.9: api → scheduler по HTTP. Все маршруты с Authorization: Bearer <SCHEDULER_TOKEN>.
// Спека 016, 4.5: клиентский спан, traceparent текущего контекста — в заголовке запроса.
export interface SchedulerHttpOptions {
  baseUrl: string; // SCHEDULER_URL, например http://scheduler:3002
  token: string; // SCHEDULER_TOKEN
  timeoutMs: number; // константа 10000 в оболочке api (4.9)
  fetch?: typeof fetch;
}

const TRACER = '@swag/adapter-scheduler-http';

export function createSchedulerHttpClient(options: SchedulerHttpOptions): SchedulerClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const server = new URL(base);

  // Тот же приём, что в adapter-orchestrator-http: заголовок передаётся явно, без автоинструментации fetch.
  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `${base}${path}`;
    return trace.getTracer(TRACER).startActiveSpan(
      method,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'http.request.method': method,
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
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
    if (!response.ok) throw new Error(`планировщик ответил ${response.status} на ${what}`);
    return response;
  }

  const jobPath = (processId: string): string => `/jobs/${encodeURIComponent(processId)}`;

  return {
    async putJob(processId, spec) {
      const response = expectOk(await send('PUT', jobPath(processId), spec), 'сохранение задания');
      return JobState.parse(await response.json());
    },

    async enable(processId) {
      const response = await send('POST', `${jobPath(processId)}/enable`);
      if (response.status === 404) return 'not_found';
      if (response.status === 409) return 'process_no_trigger';
      return JobState.parse(await expectOk(response, 'включение задания').json());
    },

    async disable(processId, reason) {
      const response = await send('POST', `${jobPath(processId)}/disable`, { reason });
      if (response.status === 404) return 'not_found';
      return JobState.parse(await expectOk(response, 'выключение задания').json());
    },

    async deleteJob(processId) {
      const response = await send('DELETE', jobPath(processId));
      if (response.status === 404) return;
      expectOk(response, 'удаление задания');
    },

    async states(processIds) {
      const response = expectOk(
        await send('POST', '/jobs/states', { processIds }),
        'запрос состояний заданий',
      );
      return JobStateList.parse(await response.json()).items;
    },

    async createRun(processId, event) {
      const response = await send('POST', `${jobPath(processId)}/runs`, { event });
      if (response.status === 404) return 'not_found';
      if (response.status === 409) return 'queue_full';
      return ProcessRunView.parse(await expectOk(response, 'постановку запуска').json());
    },

    async runs(processId) {
      const response = expectOk(await send('GET', `${jobPath(processId)}/runs`), 'список запусков');
      return ProcessRunList.parse(await response.json()).items;
    },
  };
}
