import { spawn } from 'node:child_process';
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import { fileURLToPath } from 'node:url';
import { LlmSwarmRegistration } from '@swag/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const TOKEN = 'llm-ping-test-token-0123456789abcdef';
const script = fileURLToPath(new URL('llm-ping.ts', import.meta.url));
const SWARM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

let server: Server;
let port: number;
let received: Received[];
let respond: (res: ServerResponse) => void;

beforeEach(async () => {
  received = [];
  respond = (res) => json(res, 200, { choices: [{ message: { content: 'пинг' } }], usage: {} });
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      const url = req.url ?? '';
      received.push({
        method: req.method ?? '',
        url,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      });
      if (url === '/internal/swarms') return res.writeHead(204).end();
      if (url.endsWith('/close')) return json(res, 200, { spentMicroUsd: 0 });
      respond(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function runPing(args: string[]) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, LLM_GATEWAY_PORT: String(port), LLM_GATEWAY_TOKEN: TOKEN },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.on('close', (code) => resolve({ code, output }));
  });
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const chatCall = () => received.find((r) => r.url === '/v1/chat/completions');
const swarmIdOf = () => (received[0]?.body as { swarmId: string }).swarmId;

describe('llm:ping', () => {
  it('AC-004-39: регистрирует рой, вызывает модель с его заголовками и закрывает рой, в этом порядке', async () => {
    const before = Date.now();
    const { code, output } = await runPing([]);

    expect(code).toBe(0);
    expect(received.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST /internal/swarms',
      'POST /v1/chat/completions',
      `POST /internal/swarms/${swarmIdOf()}/close`,
    ]);

    const registration = received[0];
    expect(registration?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(LlmSwarmRegistration.safeParse(registration?.body).success).toBe(true);
    expect(swarmIdOf()).toMatch(SWARM_ID_RE);
    const reg = registration?.body as LlmSwarmRegistration;
    expect(reg.budgetMicroUsd).toBe(1_000_000);
    expect(reg.agents).toEqual([{ agentId: 'agent-1', model: 'chat-small', budgetMicroUsd: null }]);
    expect(Date.parse(reg.expiresAt ?? '') - before).toBeGreaterThan(4.9 * 60_000);
    expect(Date.parse(reg.expiresAt ?? '') - before).toBeLessThanOrEqual(5 * 60_000 + 5_000);

    const chat = chatCall();
    expect(chat?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(chat?.headers['x-swag-swarm-id']).toBe(swarmIdOf());
    expect(chat?.headers['x-swag-agent-id']).toBe('agent-1');
    expect(chat?.body).toMatchObject({ model: 'chat-small', stream: false, max_tokens: 256 });

    expect(received[2]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(output).toContain('модель: chat-small');
    expect(output).toContain('ответ: пинг');
    expect(output).toMatch(/usage: \{\}/);
    expect(output).toMatch(/задержка: \d+ мс/);
  });

  it('REQ-002-17: без потока печатает ответ, usage и задержку', async () => {
    respond = (res) =>
      json(res, 200, {
        choices: [{ message: { content: 'пинг' } }],
        usage: { prompt_tokens: 7, completion_tokens: 1 },
      });

    const { code, output } = await runPing([]);

    expect(code).toBe(0);
    expect(output).toContain('ответ: пинг');
    expect(output).toContain('"prompt_tokens":7');
    expect(output).toMatch(/задержка: \d+ мс/);
  });

  it('REQ-002-17: с --stream склеивает кадры SSE, модель из аргумента, usage из последнего кадра', async () => {
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"пи"}}]}\n\ndata: {"choices":[{"delta":{');
      res.write('"content":"нг"}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n');
      res.end('data: [DONE]\n\n');
    };

    const { code, output } = await runPing(['chat-large', '--stream']);

    expect(code).toBe(0);
    expect(output).toContain('ответ: пинг');
    expect(output).toContain('"completion_tokens":2');
    expect(chatCall()?.body).toMatchObject({ model: 'chat-large', stream: true });
    expect((received[0]?.body as LlmSwarmRegistration).agents[0]?.model).toBe('chat-large');
  });

  it('AC-004-39: ответ модели не 200 — код выхода 1, тело ошибки в выводе, рой всё равно закрыт', async () => {
    respond = (res) => json(res, 401, { error: { message: 'Invalid gateway token' } });

    const { code, output } = await runPing([]);

    expect(code).toBe(1);
    expect(output).toContain('HTTP 401');
    expect(output).toContain('Invalid gateway token');
    expect(received.at(-1)?.url).toBe(`/internal/swarms/${swarmIdOf()}/close`);
  });
});
