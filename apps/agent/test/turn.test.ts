import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { NatsBus } from '@swag/adapter-nats';
import { createMemoryExporters, startTelemetry } from '@swag/adapter-telemetry';
import { eventsSubject, inboxSubject } from '@swag/contracts';
import { startAgentProcess } from '../src/start.ts';

// AC-022-24: маркеры в тексте задачи, ответе модели и аргументах send_message проходят систему,
// но не попадают в логи и спаны. Модель — настоящий adapter-openai поверх локального HTTP-шлюза,
// шина — фейк NatsBus, телеметрия — настоящая с экспортом в память.
const SWARM = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';
const TASK_MARKER = 'zq-task-7f3a91';
const REPLY_MARKER = 'zq-reply-4c2b08';
const SEND_MARKER = 'zq-send-9e1d55';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

const env = {
  NATS_URL: 'nats://127.0.0.1:1', // не используется: шина подменена
  SWARM_ID: SWARM,
  AGENT_ID: 'agent-1',
  AGENT_NAME: 'Автор',
  AGENT_ROLE: 'Пишет текст',
  AGENT_MODEL: 'chat-small',
  AGENT_PEERS: '[{"id":"agent-2","name":"Редактор","role":"Проверяет текст"}]',
  AGENT_ENTRY: 'agent-1',
  AGENT_MAX_STEPS: '20',
  AGENT_MAX_TOKENS: '2048',
  TRACEPARENT: `00-${TRACE}-00f067aa0ba902b7-01`,
  TELEMETRY_FLUSH_TIMEOUT_MS: '500',
};

// Фейковый шлюз: первый вызов модели отвечает текстом с маркером и send_message, второй — итогом.
function fakeGateway() {
  const requests: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      requests.push(body);
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
      res.setHeader('content-type', 'application/json');
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

describe('ход агента', () => {
  it('AC-022-24: маркеры задачи, ответа модели и send_message не попадают в логи и спаны, но проходят через шину', async () => {
    const gateway = fakeGateway();
    await new Promise<void>((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
    const port = (gateway.server.address() as AddressInfo).port;

    const memory = createMemoryExporters();
    const stdout: string[] = [];
    const published: { subject: string; value: unknown }[] = [];
    const handlers = new Map<string, (value: unknown) => void | Promise<void>>();
    const bus: NatsBus = {
      publishJson: async (subject, value) => {
        published.push({ subject, value });
      },
      // Подписка не нужна: обработчик вызывает тест напрямую.
      subscribeJson: (subject, handler) => {
        handlers.set(subject, handler);
        return null as never;
      },
      close: async () => undefined,
    };

    try {
      const agent = await startAgentProcess({
        env: {
          ...env,
          LLM_GATEWAY_URL: `http://127.0.0.1:${port}/v1`,
          LLM_GATEWAY_TOKEN: 'fake-gateway-token-for-tests-0000',
        },
        version: 'test',
        startTelemetry: (options) =>
          startTelemetry({
            ...options,
            stdout: (line) => stdout.push(line),
            exporters: { logs: memory.logs, spans: memory.spans },
          }),
        connect: async () => bus,
        exit: () => {
          throw new Error('старт не должен завершаться с ошибкой');
        },
      });
      expect(agent).not.toBeNull();

      const handler = handlers.get(inboxSubject(SWARM, 'agent-1'));
      expect(handler).toBeDefined();
      await handler?.({
        id: '0b6f6d2e-6a4c-4c3e-9f5e-222222222222',
        swarmId: SWARM,
        from: 'user',
        to: 'agent-1',
        text: `Напиши абзац про ${TASK_MARKER}`,
        ts: '2026-10-28T10:00:00.000Z',
      });
      await agent?.stop();

      // Маркеры реально прошли систему: в запрос модели, в событие шага и в сообщение агенту-2.
      expect(gateway.requests[0]).toContain(TASK_MARKER);
      expect(
        published.some(
          (p) =>
            p.subject === eventsSubject(SWARM) && JSON.stringify(p.value).includes(REPLY_MARKER),
        ),
      ).toBe(true);
      expect(
        published.some(
          (p) =>
            p.subject === inboxSubject(SWARM, 'agent-2') &&
            JSON.stringify(p.value).includes(SEND_MARKER),
        ),
      ).toBe(true);

      // Логи и спаны записаны, и в них нет ни одного маркера.
      expect(memory.logRecords.length).toBeGreaterThan(0);
      expect(memory.finishedSpans.some((s) => s.name === 'agent.start')).toBe(true);
      const markers = [TASK_MARKER, REPLY_MARKER, SEND_MARKER];
      const leaked = (text: string) => markers.some((marker) => text.includes(marker));
      expect(leaked(JSON.stringify(memory.logRecords))).toBe(false);
      expect(leaked(stdout.join('\n'))).toBe(false);
      expect(
        leaked(
          JSON.stringify(
            memory.finishedSpans.map((s) => ({
              name: s.name,
              attributes: s.attributes,
              events: s.events,
            })),
          ),
        ),
      ).toBe(false);
    } finally {
      gateway.server.close();
    }
  });
});
