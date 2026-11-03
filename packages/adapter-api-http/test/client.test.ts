import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunLaunchRequest, RunLaunchResult } from '@swag/contracts';
import { startTelemetry } from '@swag/adapter-telemetry';
import { createApiInternalHttpClient } from '../src/index.ts';

const TOKEN = 'swag-local-api-internal-token-not-secret-000';
const PROCESS_ID = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';
const RUN_ID = '0b6f6d2e-6a4c-4c3e-9f5e-444444444444';
const RUN_ID_2 = '0b6f6d2e-6a4c-4c3e-9f5e-555555555555';

const LAUNCH: RunLaunchRequest = { runId: RUN_ID, processId: PROCESS_ID, event: { id: 'e-1' } };

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

// Фейковый api: отвечает заданным статусом и телом, запоминает запросы.
async function fakeApi(
  status: number,
  reply: unknown,
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
        body: JSON.parse(raw),
      });
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function clientFor(baseUrl: string) {
  return createApiInternalHttpClient({ baseUrl, token: TOKEN, timeoutMs: 5000 });
}

describe('createApiInternalHttpClient', () => {
  it('REQ-033-23: launchRun шлёт POST /internal/process-runs с RunLaunchRequest и токеном, 200 разбирается в RunLaunchResult', async () => {
    const { baseUrl, requests } = await fakeApi(200, { outcome: 'launched' });

    const result = await clientFor(baseUrl).launchRun(LAUNCH);

    expect(result).toEqual({ outcome: 'launched' });
    const [request] = requests;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/internal/process-runs');
    expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request?.body).toEqual(LAUNCH);
  });

  it('REQ-033-23: launchRun возвращает rejected с причиной как результат', async () => {
    const { baseUrl } = await fakeApi(200, { outcome: 'rejected', reason: 'insufficient_balance' });

    await expect(clientFor(baseUrl).launchRun(LAUNCH)).resolves.toEqual({
      outcome: 'rejected',
      reason: 'insufficient_balance',
    });
  });

  it('REQ-033-23: launchRun на не-2xx — исключение', async () => {
    const { baseUrl } = await fakeApi(401, { error: { code: 'unauthorized' } });

    await expect(clientFor(baseUrl).launchRun(LAUNCH)).rejects.toThrow('401');
  });

  it('REQ-033-23: runStatuses шлёт POST /internal/process-runs/status и возвращает Map с null у неизвестных', async () => {
    const { baseUrl, requests } = await fakeApi(200, {
      items: [
        { runId: RUN_ID, status: 'running' },
        { runId: RUN_ID_2, status: null },
      ],
    });

    const statuses = await clientFor(baseUrl).runStatuses([RUN_ID, RUN_ID_2]);

    expect(statuses).toEqual(
      new Map([
        [RUN_ID, 'running'],
        [RUN_ID_2, null],
      ]),
    );
    const [request] = requests;
    expect(request?.url).toBe('/internal/process-runs/status');
    expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request?.body).toEqual({ runIds: [RUN_ID, RUN_ID_2] });
  });

  it('REQ-033-23: runStatuses на не-2xx — исключение', async () => {
    const { baseUrl } = await fakeApi(500, { error: { code: 'internal' } });

    await expect(clientFor(baseUrl).runStatuses([RUN_ID])).rejects.toThrow('500');
  });

  it.each<[string, RunLaunchResult]>([
    ['launched', { outcome: 'launched' }],
    ['rejected insufficient_balance', { outcome: 'rejected', reason: 'insufficient_balance' }],
    ['rejected invalid_graph', { outcome: 'rejected', reason: 'invalid_graph' }],
    ['busy', { outcome: 'busy' }],
    ['process_not_found', { outcome: 'process_not_found' }],
  ])('REQ-033-23: launchRun разбирает ответ %s', async (_name, reply) => {
    const { baseUrl } = await fakeApi(200, reply);

    await expect(clientFor(baseUrl).launchRun(LAUNCH)).resolves.toEqual(reply);
  });

  it('REQ-033-23: api не отвечает — launchRun падает по timeoutMs, не позже чем через 1 с', async () => {
    const hanging = createServer();
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', () => resolve()));
    try {
      const { port } = hanging.address() as AddressInfo;
      const client = createApiInternalHttpClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: TOKEN,
        timeoutMs: 50,
      });
      const started = Date.now();
      await expect(client.launchRun(LAUNCH)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });

  it('REQ-033-23: traceparent текущего спана уходит в заголовке запроса', async () => {
    const { baseUrl, requests } = await fakeApi(200, { outcome: 'launched' });
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
        await client.launchRun(LAUNCH);
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
