import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobSpec, JobState, ProcessRunView } from '@swag/contracts';
import { startTelemetry } from '@swag/adapter-telemetry';
import { createSchedulerHttpClient } from '../src/index.ts';

const TOKEN = 'swag-local-scheduler-token-not-secret-000';
const PROCESS_ID = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';
const ORG_ID = '0b6f6d2e-6a4c-4c3e-9f5e-222222222222';
const USER_ID = '0b6f6d2e-6a4c-4c3e-9f5e-333333333333';
const RUN_ID = '0b6f6d2e-6a4c-4c3e-9f5e-444444444444';
const NOW = '2026-11-03T10:00:00.000Z';

const SPEC: JobSpec = {
  orgId: ORG_ID,
  createdBy: USER_ID,
  trigger: null,
  pollIntervalSec: 300,
  maxConcurrent: 1,
};

const JOB_STATE: JobState = {
  processId: PROCESS_ID,
  enabled: true,
  disabledReason: null,
  nextRunAt: NOW,
  lastPollAt: null,
  lastError: null,
  consecutiveFailures: 0,
  queued: 0,
  running: 0,
};

const RUN_VIEW: ProcessRunView = {
  id: RUN_ID,
  processId: PROCESS_ID,
  status: 'queued',
  reason: null,
  source: 'manual',
  createdAt: NOW,
  launchedAt: null,
  finishedAt: null,
};

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

let server: Server | null = null;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
  server = null;
});

// Фейковый планировщик: отвечает заданным статусом и телом (undefined — без тела), запоминает запросы.
async function fakeScheduler(
  status: number,
  reply?: unknown,
): Promise<{ baseUrl: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (raw += chunk));
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: raw === '' ? undefined : JSON.parse(raw),
      });
      if (reply === undefined) {
        response.writeHead(status).end();
      } else {
        response
          .writeHead(status, { 'content-type': 'application/json' })
          .end(JSON.stringify(reply));
      }
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function clientFor(baseUrl: string) {
  return createSchedulerHttpClient({ baseUrl, token: TOKEN, timeoutMs: 5000 });
}

describe('createSchedulerHttpClient', () => {
  it('REQ-033-23: putJob шлёт PUT /jobs/:processId с JobSpec и токеном, 200 разбирается в JobState', async () => {
    const { baseUrl, requests } = await fakeScheduler(200, JOB_STATE);

    const state = await clientFor(baseUrl).putJob(PROCESS_ID, SPEC);

    expect(state).toEqual(JOB_STATE);
    const [request] = requests;
    expect(request?.method).toBe('PUT');
    expect(request?.url).toBe(`/jobs/${PROCESS_ID}`);
    expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request?.body).toEqual(SPEC);
  });

  it('REQ-033-23: enable 200 — JobState, 404 — not_found, 409 — process_no_trigger', async () => {
    const ok = await fakeScheduler(200, JOB_STATE);
    expect(await clientFor(ok.baseUrl).enable(PROCESS_ID)).toEqual(JOB_STATE);
    expect(ok.requests[0]?.method).toBe('POST');
    expect(ok.requests[0]?.url).toBe(`/jobs/${PROCESS_ID}/enable`);

    const missing = await fakeScheduler(404, { error: { code: 'job_not_found' } });
    expect(await clientFor(missing.baseUrl).enable(PROCESS_ID)).toBe('not_found');

    const noTrigger = await fakeScheduler(409, { error: { code: 'process_no_trigger' } });
    expect(await clientFor(noTrigger.baseUrl).enable(PROCESS_ID)).toBe('process_no_trigger');
  });

  it('REQ-033-23: disable шлёт POST /jobs/:processId/disable с { reason }; 404 — not_found', async () => {
    const ok = await fakeScheduler(200, { ...JOB_STATE, enabled: false, disabledReason: 'user' });
    const state = await clientFor(ok.baseUrl).disable(PROCESS_ID, 'user');

    expect(state).toMatchObject({ enabled: false, disabledReason: 'user' });
    expect(ok.requests[0]?.url).toBe(`/jobs/${PROCESS_ID}/disable`);
    expect(ok.requests[0]?.body).toEqual({ reason: 'user' });

    const missing = await fakeScheduler(404, { error: { code: 'job_not_found' } });
    expect(await clientFor(missing.baseUrl).disable(PROCESS_ID, 'author_blocked')).toBe(
      'not_found',
    );
  });

  it('REQ-033-23: deleteJob шлёт DELETE; 204 и 404 — успех, 500 — исключение', async () => {
    const deleted = await fakeScheduler(204);
    await expect(clientFor(deleted.baseUrl).deleteJob(PROCESS_ID)).resolves.toBeUndefined();
    expect(deleted.requests[0]?.method).toBe('DELETE');
    expect(deleted.requests[0]?.url).toBe(`/jobs/${PROCESS_ID}`);

    const missing = await fakeScheduler(404, { error: { code: 'job_not_found' } });
    await expect(clientFor(missing.baseUrl).deleteJob(PROCESS_ID)).resolves.toBeUndefined();

    const broken = await fakeScheduler(500, { error: { code: 'internal' } });
    await expect(clientFor(broken.baseUrl).deleteJob(PROCESS_ID)).rejects.toThrow('500');
  });

  it('REQ-033-23: states шлёт POST /jobs/states с processIds и возвращает items', async () => {
    const { baseUrl, requests } = await fakeScheduler(200, { items: [JOB_STATE] });

    const states = await clientFor(baseUrl).states([PROCESS_ID]);

    expect(states).toEqual([JOB_STATE]);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe('/jobs/states');
    expect(requests[0]?.body).toEqual({ processIds: [PROCESS_ID] });
  });

  it('REQ-033-23: createRun шлёт POST /jobs/:processId/runs с { event }; 201 — ProcessRunView, 404 — not_found, 409 — queue_full', async () => {
    const created = await fakeScheduler(201, RUN_VIEW);
    expect(await clientFor(created.baseUrl).createRun(PROCESS_ID, { id: 'e-1' })).toEqual(RUN_VIEW);
    expect(created.requests[0]?.url).toBe(`/jobs/${PROCESS_ID}/runs`);
    expect(created.requests[0]?.body).toEqual({ event: { id: 'e-1' } });

    const missing = await fakeScheduler(404, { error: { code: 'job_not_found' } });
    expect(await clientFor(missing.baseUrl).createRun(PROCESS_ID, {})).toBe('not_found');

    const full = await fakeScheduler(409, { error: { code: 'queue_full' } });
    expect(await clientFor(full.baseUrl).createRun(PROCESS_ID, {})).toBe('queue_full');
  });

  it('REQ-033-23: runs шлёт GET /jobs/:processId/runs и возвращает items; 404 — исключение', async () => {
    const ok = await fakeScheduler(200, { items: [RUN_VIEW] });
    expect(await clientFor(ok.baseUrl).runs(PROCESS_ID)).toEqual([RUN_VIEW]);
    expect(ok.requests[0]?.method).toBe('GET');
    expect(ok.requests[0]?.url).toBe(`/jobs/${PROCESS_ID}/runs`);

    const missing = await fakeScheduler(404, { error: { code: 'job_not_found' } });
    await expect(clientFor(missing.baseUrl).runs(PROCESS_ID)).rejects.toThrow('404');
  });

  it('REQ-033-23: не-2xx на putJob — исключение; processId в пути экранируется', async () => {
    const broken = await fakeScheduler(500, { error: { code: 'internal' } });
    await expect(clientFor(broken.baseUrl).putJob(PROCESS_ID, SPEC)).rejects.toThrow('500');

    const escaped = await fakeScheduler(200, JOB_STATE);
    await clientFor(escaped.baseUrl).enable('a/b c');
    expect(escaped.requests[0]?.url).toBe('/jobs/a%2Fb%20c/enable');
  });

  it('REQ-033-23: планировщик не отвечает — вызов падает по timeoutMs, не позже чем через 1 с', async () => {
    const hanging = createServer();
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', () => resolve()));
    try {
      const { port } = hanging.address() as AddressInfo;
      const client = createSchedulerHttpClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: TOKEN,
        timeoutMs: 50,
      });
      const started = Date.now();
      await expect(client.putJob(PROCESS_ID, SPEC)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });

  type Client = ReturnType<typeof clientFor>;
  it.each<[string, string, number, unknown, (client: Client) => Promise<unknown>]>([
    ['PUT', '', 200, JOB_STATE, (client) => client.putJob('a/b c', SPEC)],
    ['POST', '/enable', 200, JOB_STATE, (client) => client.enable('a/b c')],
    ['POST', '/disable', 200, JOB_STATE, (client) => client.disable('a/b c', 'user')],
    ['DELETE', '', 204, undefined, (client) => client.deleteJob('a/b c')],
    ['POST', '/runs', 201, RUN_VIEW, (client) => client.createRun('a/b c', {})],
    ['GET', '/runs', 200, { items: [] }, (client) => client.runs('a/b c')],
  ])(
    'REQ-033-23: %s /jobs/:processId%s — processId с "/" и пробелом экранируется в пути',
    async (method, suffix, status, reply, call) => {
      const { baseUrl, requests } = await fakeScheduler(status, reply);

      await call(clientFor(baseUrl));

      expect(requests[0]?.method).toBe(method);
      expect(requests[0]?.url).toBe(`/jobs/a%2Fb%20c${suffix}`);
    },
  );

  it('REQ-033-23: traceparent текущего спана уходит в заголовке запроса', async () => {
    const { baseUrl, requests } = await fakeScheduler(200, JOB_STATE);
    const telemetry = startTelemetry({
      service: 'api',
      version: 'test',
      otlpEndpoint: null,
      logLevel: 'info',
      flushTimeoutMs: 500,
      stdout: () => undefined,
    });
    try {
      const client = clientFor(baseUrl);
      const traceId = await telemetry.inSpan('process.run', { parent: null }, async () => {
        await client.enable(PROCESS_ID);
        return telemetry.trace.currentTraceId();
      });

      expect(requests[0]?.headers.traceparent).toMatch(
        new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`),
      );
    } finally {
      await telemetry.shutdown();
    }
  });
});
