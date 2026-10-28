import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SpanKind } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { subjectAttributes, type NatsBus } from '@swag/adapter-nats';
import {
  createMemoryExporters,
  startTelemetry,
  type MemoryExporters,
  type Telemetry,
} from '@swag/adapter-telemetry';
import { eventsSubject, inboxSubject } from '@swag/contracts';
import { startAgentProcess, type AgentProcess } from '../src/start.ts';

// AC-022-24: маркеры в тексте задачи, ответе модели и аргументах send_message проходят систему,
// но не попадают в логи, stdout и спаны. Модель — настоящий adapter-openai поверх локального HTTP-шлюза,
// шина — фейк NatsBus: обработчик inbox вызывается внутри спана consumer, как в adapter-nats.
// Телеметрия — настоящая с экспортом в память.
const SWARM = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';
const AGENT = 'agent-1';
const TASK_MARKER = 'zq-task-7f3a91';
const REPLY_MARKER = 'zq-reply-4c2b08';
const SEND_MARKER = 'zq-send-9e1d55';
const TOKEN = 'fake-gateway-token-for-tests-0000';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const MARKERS = [TASK_MARKER, REPLY_MARKER, SEND_MARKER, TOKEN];
const TURN_SPAN = 'process swarm.{swarmId}.agent.{agentId}.inbox';

const env = {
  NATS_URL: 'nats://127.0.0.1:1', // не используется: шина подменена
  SWARM_ID: SWARM,
  AGENT_ID: AGENT,
  AGENT_NAME: 'Автор',
  AGENT_ROLE: 'Пишет текст',
  AGENT_MODEL: 'chat-small',
  AGENT_PEERS: '[{"id":"agent-2","name":"Редактор","role":"Проверяет текст"}]',
  AGENT_ENTRY: 'agent-1',
  AGENT_MAX_STEPS: '20',
  AGENT_MAX_TOKENS: '2048',
  LLM_GATEWAY_TOKEN: TOKEN,
  TRACEPARENT: `00-${TRACE}-00f067aa0ba902b7-01`,
  TELEMETRY_FLUSH_TIMEOUT_MS: '500',
};

interface GatewayRequest {
  headers: IncomingMessage['headers'];
  body: string;
}

// Фейковый шлюз: первый вызов модели отвечает текстом с маркером и send_message, второй — итогом.
// При failing — 500 с маркером и токеном в теле.
function fakeGateway(failing: boolean) {
  const requests: GatewayRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      requests.push({ headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (failing) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: `сбой ${REPLY_MARKER} ${TOKEN}` } }));
        return;
      }
      const request = JSON.parse(body) as { messages: { role: string }[] };
      const afterTool = request.messages.at(-1)?.role === 'tool';
      const message = afterTool
        ? { role: 'assistant', content: 'готово' }
        : {
            role: 'assistant',
            content: `ответ ${REPLY_MARKER}`,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'send_message',
                  arguments: JSON.stringify({ to: 'agent-2', text: `передать ${SEND_MARKER}` }),
                },
              },
            ],
          };
      res.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 0,
          model: 'chat-small',
          choices: [{ index: 0, finish_reason: afterTool ? 'stop' : 'tool_calls', message }],
        }),
      );
    });
  });
  return { server, requests };
}

interface Published {
  subject: string;
  value: unknown;
}

interface TurnRun {
  memory: MemoryExporters;
  stdout: string[];
  published: Published[];
  requests: GatewayRequest[];
  logsBeforeTurn: number;
  turnSpan: ReturnType<MemoryExporters['finishedSpans']['find']>;
}

// Один ход входа агента: старт, сообщение в inbox, остановка. Ресурсы закрываются в finally.
async function runTurn(options: { failing: boolean; extraEnv?: Record<string, string> }) {
  const gateway = fakeGateway(options.failing);
  await new Promise<void>((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const port = (gateway.server.address() as AddressInfo).port;

  const memory = createMemoryExporters();
  const stdout: string[] = [];
  const published: Published[] = [];
  const handlers = new Map<string, (value: unknown) => Promise<void>>();
  let telemetry: Telemetry | null = null;
  const bus: NatsBus = {
    publishJson: async (subject, value) => {
      published.push({ subject, value });
    },
    // Как adapter-nats: обработчик идёт внутри спана consumer; исключение не останавливает подписку.
    subscribeJson: (subject, handler) => {
      handlers.set(subject, async (value) => {
        const { template, attributes } = subjectAttributes(subject);
        try {
          await telemetry?.inSpan(
            `process ${template}`,
            {
              kind: 'consumer',
              parent: null,
              attributes: { ...attributes, 'messaging.operation.type': 'process' },
            },
            () => handler(value),
          );
        } catch {
          // ошибка уже записана в спан
        }
      });
      return null as never;
    },
    close: async () => undefined,
  };

  let agent: AgentProcess | null = null;
  let logsBeforeTurn = 0;
  try {
    agent = await startAgentProcess({
      env: {
        ...env,
        LLM_GATEWAY_URL: `http://127.0.0.1:${port}/v1`,
        ...options.extraEnv,
      },
      version: 'test',
      startTelemetry: (telemetryOptions) => {
        telemetry = startTelemetry({
          ...telemetryOptions,
          stdout: (line) => stdout.push(line),
          exporters: { logs: memory.logs, spans: memory.spans },
        });
        return telemetry;
      },
      connect: async () => bus,
      exit: () => {
        throw new Error('старт не должен завершаться с ошибкой');
      },
    });
    expect(agent).not.toBeNull();

    const handler = handlers.get(inboxSubject(SWARM, AGENT));
    expect(handler).toBeDefined();
    logsBeforeTurn = memory.logRecords.length;
    await handler?.({
      id: '0b6f6d2e-6a4c-4c3e-9f5e-222222222222',
      swarmId: SWARM,
      from: 'user',
      to: AGENT,
      text: `Напиши абзац про ${TASK_MARKER}`,
      ts: '2026-10-28T10:00:00.000Z',
    });
  } finally {
    await agent?.stop();
    await new Promise<void>((resolve) => {
      gateway.server.close(() => resolve());
      gateway.server.closeAllConnections();
    });
  }

  const run: TurnRun = {
    memory,
    stdout,
    published,
    requests: gateway.requests,
    logsBeforeTurn,
    turnSpan: memory.finishedSpans.find((s) => s.name === TURN_SPAN),
  };
  return run;
}

// Маркеры и токен не должны попасть в логи, stdout и спаны (имя, атрибуты, события, статус, связи).
function expectNoLeaks(run: TurnRun) {
  const leaked = (text: string) => MARKERS.some((marker) => text.includes(marker));
  expect(leaked(JSON.stringify(run.memory.logRecords))).toBe(false);
  expect(leaked(run.stdout.join('\n'))).toBe(false);
  expect(
    leaked(
      JSON.stringify(
        run.memory.finishedSpans.map((s) => ({
          name: s.name,
          attributes: s.attributes,
          events: s.events,
          status: s.status,
          links: s.links,
        })),
      ),
    ),
  ).toBe(false);
}

describe('ход агента', () => {
  it('AC-022-24: маркеры задачи, ответа модели и send_message проходят через шину, но не попадают в логи и спаны', async () => {
    const run = await runTurn({ failing: false });

    // Маркеры реально прошли систему: в запрос модели, в событие шага и в сообщение агенту-2.
    expect(run.requests[0]?.body).toContain(TASK_MARKER);
    expect(
      run.published.some(
        (p) => p.subject === eventsSubject(SWARM) && JSON.stringify(p.value).includes(REPLY_MARKER),
      ),
    ).toBe(true);
    expect(
      run.published.some(
        (p) =>
          p.subject === inboxSubject(SWARM, 'agent-2') &&
          JSON.stringify(p.value).includes(SEND_MARKER),
      ),
    ).toBe(true);

    // Ход — спан consumer в шаблоне subject. Логи хода: уровень агента info, ход пишет только debug,
    // поэтому записей, созданных во время хода, нет; проверка утечек опирается на стартовые записи.
    expect(run.turnSpan).toBeDefined();
    expect(run.turnSpan?.kind).toBe(SpanKind.CONSUMER);
    expect(run.memory.logRecords.length).toBeGreaterThan(0);
    expect(run.memory.logRecords.length).toBe(run.logsBeforeTurn);
    expect(run.memory.finishedSpans.some((s) => s.name === 'agent.start')).toBe(true);

    // Два запроса к шлюзу (до и после результата инструмента), заголовки и трассировка.
    expect(run.requests).toHaveLength(2);
    for (const request of run.requests) {
      expect(request.headers['x-swag-swarm-id']).toBe(SWARM);
      expect(request.headers['x-swag-agent-id']).toBe(AGENT);
      expect(request.headers['authorization']).toBe(`Bearer ${TOKEN}`);
      const traceparent = String(request.headers['traceparent']);
      expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
      expect(traceparent.split('-')[1]).toBe(run.turnSpan?.spanContext().traceId);
    }

    expectNoLeaks(run);
  });

  it('AC-022-24: ошибка модели — agent.failed после одного запроса (AGENT_LLM_MAX_RETRIES=0), маркеры и токен не утекают', async () => {
    const run = await runTurn({ failing: true, extraEnv: { AGENT_LLM_MAX_RETRIES: '0' } });

    // Проброс maxRetries: без повторов SDK шлюз получает ровно один запрос.
    expect(run.requests).toHaveLength(1);
    expect(
      run.published.some(
        (p) =>
          p.subject === eventsSubject(SWARM) &&
          (p.value as { type: string; data: { reason: string } }).type === 'agent.failed' &&
          (p.value as { data: { reason: string } }).data.reason === 'model_error:upstream_error',
      ),
    ).toBe(true);

    expectNoLeaks(run);
  });
});
