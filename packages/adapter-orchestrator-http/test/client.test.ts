import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createOrchestratorHttpClient } from '../src/index.ts';

const TOKEN = 'fake-orchestrator-token-for-tests-000000';
const SWARM_ID = '0b6f6d2e-6a4c-4c3e-9f5e-444444444444';

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
          task: 'T',
          budgetMicroUsd: 1000000,
          maxTokens: null,
          agents: [],
        }),
      ).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });
});
