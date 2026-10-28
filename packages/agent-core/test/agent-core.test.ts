import { describe, expect, it } from 'vitest';
import type { BusMessage, PlatformEventInput } from '@swag/contracts';
import {
  createAgentCore,
  type AgentBus,
  type AgentConfigCore,
  type AgentPeer,
  type ChatModel,
  type ChatModelRequest,
  type ChatModelResult,
  type LogContext,
} from '../src/index.ts';

const SWARM = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';
const MSG = '0b6f6d2e-6a4c-4c3e-9f5e-333333333333';
const MSG2 = '0b6f6d2e-6a4c-4c3e-9f5e-333333333334';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PEERS: AgentPeer[] = [{ id: 'agent-2', name: 'Редактор', role: 'проверяет текст' }];

function fakeBus() {
  const events: PlatformEventInput[] = [];
  const messages: BusMessage[] = [];
  let handler: ((raw: unknown) => Promise<void>) | undefined;
  const bus: AgentBus = {
    subscribe: async (_subject, next) => {
      handler = next;
    },
    publishEvent: async (event) => {
      events.push(event);
    },
    publishMessage: async (message) => {
      messages.push(message);
    },
  };
  return { bus, events, messages, deliver: (raw: unknown) => handler?.(raw) ?? Promise.resolve() };
}

const config = (overrides: Partial<AgentConfigCore>): AgentConfigCore => ({
  swarmId: SWARM,
  agentId: 'agent-1',
  agentName: 'A',
  agentRole: 'r1',
  model: 'chat-small',
  peers: PEERS,
  entryAgentId: 'agent-1',
  maxSteps: 20,
  maxTokens: 2048,
  ...overrides,
});

interface Entry {
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  ctx?: LogContext;
}

let callCounter = 0;
const toolCall = (name: string, args: Record<string, unknown>): ChatModelResult => ({
  ok: true,
  message: {
    content: null,
    tool_calls: [
      {
        id: `call_${++callCounter}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  },
});
const reply = (content: string): ChatModelResult => ({
  ok: true,
  message: { content, tool_calls: [] },
});

// Скриптовый ChatModel: отдаёт ответы по порядку и запоминает запросы; пустой сценарий — ошибка теста.
function scriptedModel(replies: ChatModelResult[]) {
  const requests: ChatModelRequest[] = [];
  const model: ChatModel = {
    complete: async (request) => {
      requests.push(request);
      const next = replies.shift();
      if (next === undefined) throw new Error('script exhausted');
      return next;
    },
  };
  return { model, requests };
}

function setup(overrides: Partial<AgentConfigCore>, replies: ChatModelResult[] = []) {
  const fake = fakeBus();
  const scripted = scriptedModel(replies);
  const entries: Entry[] = [];
  const at =
    (level: Entry['level']) =>
    (msg: string, ctx?: LogContext): void => {
      entries.push(ctx === undefined ? { level, msg } : { level, msg, ctx });
    };
  let uuids = 0;
  const core = createAgentCore({
    version: 'test',
    bus: fake.bus,
    clock: { now: () => '2026-10-22T10:00:00.000Z' },
    ids: { uuid: () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, '0')}` },
    log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
    trace: { currentTraceId: () => TRACE },
    model: scripted.model,
    config: config(overrides),
  });
  return { core, entries, requests: scripted.requests, ...fake };
}

const inbox = (
  text: string,
  from: BusMessage['from'] = 'user',
  to: BusMessage['to'] = 'agent-1',
  id = MSG,
) => ({ id, swarmId: SWARM, from, to, text, ts: '2026-10-22T10:00:01.000Z' });

describe('agent-core', () => {
  it('AC-000-16: info() возвращает ServiceInfo сервиса agent с версией из оболочки', () => {
    const { core } = setup({});
    expect(core.info()).toEqual({ service: 'agent', version: 'test' });
  });

  it('AC-001-19: agent.started, затем ход агента входа: agent.working, agent.step и agent.result по finish', async () => {
    const { core, events, requests, deliver } = setup({}, [toolCall('finish', { result: 'итог' })]);
    await core.start();
    expect(events.map((e) => e.type)).toEqual(['agent.started']);
    await deliver(inbox('T'));
    expect(events.map((e) => e.type)).toEqual([
      'agent.started',
      'agent.working',
      'agent.step',
      'agent.result',
    ]);
    expect(events[1]).toMatchObject({ type: 'agent.working', data: { messageId: MSG } });
    expect(events[2]).toMatchObject({
      type: 'agent.step',
      data: {
        messageId: MSG,
        stepIndex: 1,
        text: null,
        toolCalls: [{ id: expect.any(String), name: 'finish' }],
      },
    });
    expect(events[3]).toMatchObject({
      type: 'agent.result',
      agentId: 'agent-1',
      data: { text: 'итог' },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages.at(-1)).toEqual({
      role: 'user',
      content: 'Задача от пользователя:\nT',
    });
  });

  it('AC-022-13: агент без finish — два хода подряд: working, два шага, сообщение входу, idle; история и сквозные stepIndex', async () => {
    const { core, events, messages, requests, deliver } = setup(
      {
        agentId: 'agent-2',
        agentName: 'Редактор',
        entryAgentId: 'agent-1',
        peers: [{ id: 'agent-1', name: 'Автор', role: 'пишет' }],
      },
      [
        toolCall('send_message', { to: 'agent-1', text: 'черновик' }),
        reply('готово'),
        toolCall('send_message', { to: 'agent-1', text: 'правка' }),
        reply('готово 2'),
      ],
    );
    await core.start();
    await deliver(inbox('первая', 'agent-1', 'agent-2', MSG));
    await deliver(inbox('вторая', 'agent-1', 'agent-2', MSG2));

    expect(events.slice(1).map((e) => e.type)).toEqual([
      'agent.working',
      'agent.step',
      'agent.step',
      'agent.idle',
      'agent.working',
      'agent.step',
      'agent.step',
      'agent.idle',
    ]);
    expect(events.filter((e) => e.type === 'agent.step').map((e) => e.data)).toMatchObject([
      { messageId: MSG, stepIndex: 1 },
      { messageId: MSG, stepIndex: 2, text: 'готово' },
      { messageId: MSG2, stepIndex: 3 },
      { messageId: MSG2, stepIndex: 4, text: 'готово 2' },
    ]);
    expect(messages).toMatchObject([
      { from: 'agent-2', to: 'agent-1', text: 'черновик' },
      { from: 'agent-2', to: 'agent-1', text: 'правка' },
    ]);
    expect(requests[2]?.messages).toContainEqual({
      role: 'user',
      content: 'Сообщение от agent-1 «Автор»:\nпервая',
    });
  });

  it('AC-022-15: finish у агента-входа — agent.result, следующее сообщение отброшено с warn, модель не вызвана', async () => {
    const { core, events, entries, requests, deliver } = setup({}, [
      toolCall('finish', { result: 'итог' }),
    ]);
    await core.start();
    await deliver(inbox('T'));
    await deliver(inbox('ещё раз', 'user', 'agent-1', MSG2));
    expect(events.slice(1).map((e) => e.type)).toEqual([
      'agent.working',
      'agent.step',
      'agent.result',
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'agent.result', data: { text: 'итог' } });
    expect(entries).toContainEqual({
      level: 'warn',
      msg: 'message dropped',
      ctx: { swarmId: SWARM, agentId: 'agent-1', reason: 'agent_finished' },
    });
    expect(requests).toHaveLength(1);
  });

  it('AC-022-16: AGENT_MAX_STEPS=3 — три шага и agent.failed max_steps, следующее сообщение отброшено', async () => {
    const { core, events, entries, requests, deliver } = setup(
      { maxSteps: 3 },
      Array.from({ length: 5 }, () => toolCall('send_message', { to: 'agent-2', text: 'x' })),
    );
    await core.start();
    await deliver(inbox('T'));
    expect(requests).toHaveLength(3);
    expect(events.filter((e) => e.type === 'agent.step').map((e) => e.data)).toMatchObject([
      { stepIndex: 1 },
      { stepIndex: 2 },
      { stepIndex: 3 },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'agent.failed',
      agentId: 'agent-1',
      data: { reason: 'max_steps' },
    });
    await deliver(inbox('ещё', 'user', 'agent-1', MSG2));
    expect(requests).toHaveLength(3);
    expect(entries).toContainEqual({
      level: 'warn',
      msg: 'message dropped',
      ctx: { swarmId: SWARM, agentId: 'agent-1', reason: 'agent_finished' },
    });
  });

  it('AC-022-16: ошибка модели upstream_timeout — agent.failed model_error:upstream_timeout, шагов нет, дальше сообщения отброшены', async () => {
    const { core, events, requests, deliver } = setup({}, [
      { ok: false, error: { code: 'upstream_timeout', message: 'таймаут' } },
    ]);
    await core.start();
    await deliver(inbox('T'));
    expect(events.slice(1).map((e) => e.type)).toEqual(['agent.working', 'agent.failed']);
    expect(events.at(-1)).toMatchObject({
      type: 'agent.failed',
      data: { reason: 'model_error:upstream_timeout' },
    });
    await deliver(inbox('ещё', 'user', 'agent-1', MSG2));
    expect(requests).toHaveLength(1);
    expect(events).toHaveLength(3);
  });

  it('AC-016-6: agent.started, agent.working, agent.step и agent.result несут traceId порта; логи agent started и turn finished', async () => {
    const { core, events, entries, deliver } = setup({}, [toolCall('finish', { result: 'итог' })]);
    await core.start();
    await deliver(inbox('T'));
    expect(events.map((e) => [e.type, e.traceId])).toEqual([
      ['agent.started', TRACE],
      ['agent.working', TRACE],
      ['agent.step', TRACE],
      ['agent.result', TRACE],
    ]);
    expect(entries).toContainEqual({
      level: 'debug',
      msg: 'turn finished',
      ctx: { swarmId: SWARM, agentId: 'agent-1', messageId: MSG, kind: 'stopped', steps: 1 },
    });
    expect(entries).toContainEqual({
      level: 'info',
      msg: 'agent started',
      ctx: { swarmId: SWARM, agentId: 'agent-1' },
    });
  });

  it('AC-016-7: agent-core пишет логи 4.8 без текста роли и сообщения', async () => {
    const { core, entries, deliver } = setup({ agentRole: 'секретная роль' }, [reply('ответ')]);
    await core.start();
    await deliver(inbox('секретный текст'));
    expect(entries.map((e) => [e.level, e.msg])).toEqual([
      ['info', 'agent started'],
      ['debug', 'turn finished'],
    ]);
    expect(JSON.stringify(entries)).not.toContain('секрет');
  });
});
