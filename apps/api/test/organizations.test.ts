import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createOrgDirectory } from '../src/organizations.ts';

// Спека 013, 4.9: справочник организаций поверх identity. Фейковый identity — настоящий HTTP-сервер на localhost.

const TOKEN = 'fake-identity-internal-token-for-tests-0000';
const ORG_ID = '2f6c1f0e-1d2b-4c3a-9e8f-555555555555';

type Reply = { status: number; hang?: boolean };

let server: Server | null = null;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
});

async function fakeIdentity(
  reply: Reply,
): Promise<{
  url: string;
  requests: { path: string | undefined; authorization: string | undefined }[];
}> {
  const requests: { path: string | undefined; authorization: string | undefined }[] = [];
  server = createServer((request: IncomingMessage, response) => {
    requests.push({ path: request.url, authorization: request.headers.authorization });
    if (reply.hang) return;
    response.writeHead(reply.status).end();
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests };
}

describe('createOrgDirectory', () => {
  it('204 от identity — организация существует', async () => {
    const identity = await fakeIdentity({ status: 204 });
    const orgs = createOrgDirectory({ identityUrl: identity.url, token: TOKEN, timeoutMs: 2000 });
    await expect(orgs.exists(ORG_ID)).resolves.toBe(true);
  });

  it('404 от identity — организации нет', async () => {
    const identity = await fakeIdentity({ status: 404 });
    const orgs = createOrgDirectory({ identityUrl: identity.url, token: TOKEN, timeoutMs: 2000 });
    await expect(orgs.exists(ORG_ID)).resolves.toBe(false);
  });

  it('другой статус — исключение с кодом статуса', async () => {
    const identity = await fakeIdentity({ status: 500 });
    const orgs = createOrgDirectory({ identityUrl: identity.url, token: TOKEN, timeoutMs: 2000 });
    await expect(orgs.exists(ORG_ID)).rejects.toThrow('HTTP 500');
  });

  it('запрос идёт на /internal/organizations/:orgId с Bearer-токеном', async () => {
    const identity = await fakeIdentity({ status: 204 });
    const orgs = createOrgDirectory({ identityUrl: identity.url, token: TOKEN, timeoutMs: 2000 });
    await orgs.exists(ORG_ID);
    expect(identity.requests).toEqual([
      { path: `/internal/organizations/${ORG_ID}`, authorization: `Bearer ${TOKEN}` },
    ]);
  });

  it('таймаут identity — исключение', async () => {
    const identity = await fakeIdentity({ status: 204, hang: true });
    const orgs = createOrgDirectory({ identityUrl: identity.url, token: TOKEN, timeoutMs: 100 });
    await expect(orgs.exists(ORG_ID)).rejects.toThrow();
  });
});
