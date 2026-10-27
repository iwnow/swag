import { spawn } from 'node:child_process';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const TOKEN = 'llm-ping-test-token-0123456789abcdef';
const script = fileURLToPath(new URL('llm-ping.ts', import.meta.url));

interface Received {
  headers: IncomingHttpHeaders;
  body: { model: string; stream: boolean };
}

let server: Server;
let port: number;
let received: Received | undefined;
let respond: (res: import('node:http').ServerResponse) => void;

beforeEach(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      received = { headers: req.headers, body: JSON.parse(raw) as Received['body'] };
      respond(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  received = undefined;
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

const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

describe('llm:ping', () => {
  it('REQ-002-17: без потока печатает ответ, usage и задержку, шлёт токен и заголовки 4.13', async () => {
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
    expect(received?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(received?.headers['x-swag-agent-id']).toBe('agent-1');
    expect(received?.headers['x-swag-swarm-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(received?.body).toMatchObject({ model: 'chat-small', stream: false });
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
    expect(received?.body).toMatchObject({ model: 'chat-large', stream: true });
  });

  it('REQ-002-17: ответ не 200 — код выхода 1 и тело ошибки в выводе', async () => {
    respond = (res) => json(res, 401, { error: { message: 'Invalid gateway token' } });

    const { code, output } = await runPing([]);

    expect(code).toBe(1);
    expect(output).toContain('HTTP 401');
    expect(output).toContain('Invalid gateway token');
  });
});
