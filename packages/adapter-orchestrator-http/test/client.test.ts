import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeInvocation } from '@swag/contracts';
import { startTelemetry } from '@swag/adapter-telemetry';
import { createOrchestratorHttpClient } from '../src/index.ts';

const TOKEN = 'fake-orchestrator-token-for-tests-000000';
const SWARM_ID = '0b6f6d2e-6a4c-4c3e-9f5e-444444444444';
const ORG_ID = '0b6f6d2e-6a4c-4c3e-9f5e-555555555555';

// Фейковый оркестратор: отвечает 202 и запоминает заголовки каждого запроса.
let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function fakeOrchestrator(): Promise<{ baseUrl: string; received: IncomingHttpHeaders[] }> {
  const received: IncomingHttpHeaders[] = [];
  server = createServer((request, response) => {
    received.push(request.headers);
    request.resume();
    request.on('end', () => {
      response.writeHead(202).end();
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, received };
}

describe('createOrchestratorHttpClient', () => {
  it('AC-024-22: launch и stop шлют Authorization: Bearer <token> на каждом запросе', async () => {
    const { baseUrl, received } = await fakeOrchestrator();
    const client = createOrchestratorHttpClient({ baseUrl, token: TOKEN, timeoutMs: 5000 });

    await client.launch({
      swarmId: SWARM_ID,
      orgId: ORG_ID,
      task: 'T',
      budgetMicroUsd: 1000000,
      maxTokens: null,
      agents: [
        {
          id: 'agent-1',
          name: 'A',
          role: 'r',
          model: 'chat-small',
          budgetMicroUsd: null,
          maxTokens: null,
        },
      ],
      programs: [],
      edges: [],
      entry: 'agent-1',
      exit: 'agent-1',
      trigger: null,
    });
    await client.stop(SWARM_ID);

    expect(received).toHaveLength(2);
    for (const headers of received) {
      expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('AC-013-21: оркестратор не отвечает — launch падает по timeoutMs, не позже чем через 1 с', async () => {
    const hanging = createServer();
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', () => resolve()));
    try {
      const { port } = hanging.address() as AddressInfo;
      const client = createOrchestratorHttpClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: TOKEN,
        timeoutMs: 100,
      });
      const started = Date.now();
      await expect(
        client.launch({
          swarmId: SWARM_ID,
          orgId: ORG_ID,
          task: 'T',
          budgetMicroUsd: 1000000,
          maxTokens: null,
          agents: [],
          programs: [],
          edges: [],
          entry: 'agent-1',
          exit: 'agent-1',
          trigger: null,
        }),
      ).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });
});

const INVOCATION: NodeInvocation = {
  orgId: ORG_ID,
  type: 'example/echo@1.0.0',
  call: { kind: 'execute', input: { text: 'hi' } },
  settings: {},
  credentials: {},
  stateKey: 'node-1',
  timeoutMs: 1000,
};
const RESULT_OK = { ok: true, output: { text: '> hi' }, durationMs: 3 };

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

// Фейковый оркестратор для вызова узла: отвечает заданным статусом и телом, запоминает запросы.
async function fakeNodeOrchestrator(
  status: number,
  reply: unknown,
): Promise<{ baseUrl: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = [];
  server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
      });
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

describe('createOrchestratorHttpClient: invokeNode', () => {
  it('REQ-033-7: invokeNode шлёт POST /node-invocations с телом и токеном и разбирает ok: true', async () => {
    const { baseUrl, requests } = await fakeNodeOrchestrator(200, RESULT_OK);
    const client = createOrchestratorHttpClient({ baseUrl, token: TOKEN, timeoutMs: 5000 });

    const result = await client.invokeNode(INVOCATION);

    expect(result).toEqual(RESULT_OK);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('/node-invocations');
    expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(request?.body ?? 'null')).toEqual(INVOCATION);
  });

  it('REQ-033-7: ok: false от оркестратора возвращается как результат, а не исключение', async () => {
    const failed = {
      ok: false,
      error: { code: 'timeout', message: 'узел не ответил' },
      durationMs: 1000,
    };
    const { baseUrl } = await fakeNodeOrchestrator(200, failed);
    const client = createOrchestratorHttpClient({ baseUrl, token: TOKEN, timeoutMs: 5000 });

    await expect(client.invokeNode(INVOCATION)).resolves.toEqual(failed);
  });

  it('REQ-033-7: не-2xx от оркестратора — исключение', async () => {
    const { baseUrl } = await fakeNodeOrchestrator(400, { error: { code: 'invalid_request' } });
    const client = createOrchestratorHttpClient({ baseUrl, token: TOKEN, timeoutMs: 5000 });

    await expect(client.invokeNode(INVOCATION)).rejects.toThrow('400');
  });

  it('REQ-033-7: таймаут запроса — invocation.timeoutMs + 10000, без timeoutMs — timeoutMs клиента + 10000', async () => {
    const { baseUrl } = await fakeNodeOrchestrator(200, RESULT_OK);
    const client = createOrchestratorHttpClient({ baseUrl, token: TOKEN, timeoutMs: 5000 });
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      await client.invokeNode(INVOCATION);
      await client.invokeNode({ ...INVOCATION, timeoutMs: undefined });

      expect(timeout).toHaveBeenNthCalledWith(1, 11_000);
      expect(timeout).toHaveBeenNthCalledWith(2, 15_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it('REQ-033-7: traceparent текущего спана уходит в заголовке invokeNode', async () => {
    const { baseUrl, requests } = await fakeNodeOrchestrator(200, RESULT_OK);
    const telemetry = startTelemetry({
      service: 'api',
      version: 'test',
      otlpEndpoint: null,
      logLevel: 'info',
      flushTimeoutMs: 500,
      stdout: () => undefined,
    });
    try {
      const client = createOrchestratorHttpClient({ baseUrl, token: TOKEN, timeoutMs: 5000 });
      const traceId = await telemetry.inSpan('process.run', { parent: null }, async () => {
        await client.invokeNode(INVOCATION);
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
