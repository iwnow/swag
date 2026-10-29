import { describe, expect, it } from 'vitest';
import type { BusMessage, PlatformEventInput } from '@swag/contracts';
import {
  createAgentCore,
  ENTRY_REMINDER,
  type AgentBus,
  type AgentConfigCore,
  type AgentPeer,
  type ChatMessage,
  type ChatModel,
  type ChatModelRequest,
  type ChatModelResult,
  type LogContext,
} from '../src/index.ts';

const SWARM = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';
const MSG = '0b6f6d2e-6a4c-4c3e-9f5e-333333333333';
const MSG2 = '0b6f6d2e-6a4c-4c3e-9f5e-333333333334';
const MSG3 = '0b6f6d2e-6a4c-4c3e-9f5e-333333333335';
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
const toolCalls = (...calls: [name: string, args: Record<string, unknown>][]): ChatModelResult => ({
  ok: true,
  message: {
    content: null,
    tool_calls: calls.map(([name, args]) => ({
      id: `call_${++callCounter}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    })),
  },
});
const toolCall = (name: string, args: Record<string, unknown>): ChatModelResult =>
  toolCalls([name, args]);
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

const countReminders = (messages: ChatMessage[]) =>
  messages.filter((m) => m.role === 'user' && m.content === ENTRY_REMINDER).length;

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

  it('AC-022-13: агент пишет входу в каждом ходе — send_message уступает ход: working, один шаг, idle; stepIndex сквозной, история накапливается', async () => {
    const { core, events, messages, requests, deliver } = setup(
      {
        agentId: 'agent-2',
        agentName: 'Редактор',
        entryAgentId: 'agent-1',
        peers: [{ id: 'agent-1', name: 'Автор', role: 'пишет' }],
      },
      [
        toolCall('send_message', { to: 'agent-1', text: 'черновик' }),
        toolCall('send_message', { to: 'agent-1', text: 'правка' }),
      ],
    );
    await core.start();
    await deliver(inbox('первая', 'agent-1', 'agent-2', MSG));
    await deliver(inbox('вторая', 'agent-1', 'agent-2', MSG2));

    expect(events.slice(1).map((e) => e.type)).toEqual([
      'agent.working',
      'agent.step',
      'agent.idle',
      'agent.working',
      'agent.step',
      'agent.idle',
    ]);
    expect(events.filter((e) => e.type === 'agent.step').map((e) => e.data)).toMatchObject([
      { messageId: MSG, stepIndex: 1 },
      { messageId: MSG2, stepIndex: 2 },
    ]);
    expect(messages).toMatchObject([
      { from: 'agent-2', to: 'agent-1', text: 'черновик' },
      { from: 'agent-2', to: 'agent-1', text: 'правка' },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'user',
    ]);
    expect(requests[1]?.messages).toContainEqual({
      role: 'user',
      content: 'Сообщение от agent-1 «Автор»:\nпервая',
    });
  });

  it('AC-030-5: агент-вход шлёт участнику и уступает ход; ответ участника — следующий ход с его текстом во входе модели', async () => {
    const { core, events, messages, requests, deliver } = setup({}, [
      toolCall('send_message', { to: 'agent-2', text: 'проверь' }),
      toolCall('finish', { result: 'итог' }),
    ]);
    await core.start();
    await deliver(inbox('T'));
    expect(events.slice(1).map((e) => e.type)).toEqual([
      'agent.working',
      'agent.step',
      'agent.idle',
    ]);
    expect(events[2]).toMatchObject({ data: { messageId: MSG, stepIndex: 1 } });
    expect(messages).toMatchObject([{ from: 'agent-1', to: 'agent-2', text: 'проверь' }]);
    expect(requests).toHaveLength(1);
    expect(countReminders(requests[0]?.messages ?? [])).toBe(0);

    await deliver(inbox('правлено', 'agent-2', 'agent-1', MSG2));
    expect(events[4]).toMatchObject({ type: 'agent.working', data: { messageId: MSG2 } });
    expect(requests[1]?.messages.at(-1)).toEqual({
      role: 'user',
      content: 'Сообщение от agent-2 «Редактор»:\nправлено',
    });
    expect(events.at(-1)).toMatchObject({ type: 'agent.result', data: { text: 'итог' } });
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
      Array.from({ length: 5 }, () => toolCall('send_message', { to: 'agent-9', text: 'x' })),
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

  it('AC-022-16: ошибка модели max_tokens — agent.failed model_error:max_tokens, шагов нет', async () => {
    const { core, events, deliver } = setup({}, [
      { ok: false, error: { code: 'max_tokens', message: 'обрезан' } },
    ]);
    await core.start();
    await deliver(inbox('T'));
    expect(events.slice(1).map((e) => e.type)).toEqual(['agent.working', 'agent.failed']);
    expect(events.at(-1)).toMatchObject({
      type: 'agent.failed',
      data: { reason: 'model_error:max_tokens' },
    });
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
    const { core, entries, deliver } = setup({ agentRole: 'секретная роль' }, [
      reply('ответ'),
      reply('ответ 2'),
    ]);
    await core.start();
    await deliver(inbox('секретный текст'));
    expect(entries.map((e) => [e.level, e.msg])).toEqual([
      ['info', 'agent started'],
      ['debug', 'turn finished'],
    ]);
    expect(JSON.stringify(entries)).not.toContain('секрет');
  });

  it('AC-022-28: агент-вход ответил текстом — одно напоминание 4.5, повторный текст — agent.result «итог»', async () => {
    const { core, events, entries, requests, deliver } = setup({}, [
      reply('черновик'),
      reply('итог'),
    ]);
    await core.start();
    await deliver(inbox('T'));
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)).toEqual({ role: 'user', content: ENTRY_REMINDER });
    expect(countReminders(requests[1]?.messages ?? [])).toBe(1);
    expect(events.slice(1).map((e) => e.type)).toEqual([
      'agent.working',
      'agent.step',
      'agent.step',
      'agent.result',
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'agent.result',
      agentId: 'agent-1',
      data: { text: 'итог' },
    });
    await deliver(inbox('ещё', 'user', 'agent-1', MSG2));
    expect(requests).toHaveLength(2);
    expect(entries).toContainEqual({
      level: 'warn',
      msg: 'message dropped',
      ctx: { swarmId: SWARM, agentId: 'agent-1', reason: 'agent_finished' },
    });
  });

  it('AC-022-28: после напоминания вызов finish — agent.result с результатом finish', async () => {
    const { core, events, requests, deliver } = setup({}, [
      reply('черновик'),
      toolCall('finish', { result: 'итог finish' }),
    ]);
    await core.start();
    await deliver(inbox('T'));
    expect(requests).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: 'agent.result', data: { text: 'итог finish' } });
  });

  it('AC-022-28: агент-вход ждёт agent-2 и agent-3 — текст без напоминания даёт idle; после последнего ответа — напоминание', async () => {
    const { core, events, requests, deliver } = setup(
      { peers: [...PEERS, { id: 'agent-3', name: 'Корректор', role: 'правит текст' }] },
      [
        toolCalls(
          ['send_message', { to: 'agent-2', text: 'a' }],
          ['send_message', { to: 'agent-3', text: 'b' }],
        ),
        reply('ждём'),
        reply('ответ 3'),
        reply('итог'),
      ],
    );
    await core.start();
    await deliver(inbox('T'));
    expect(events.at(-1)).toMatchObject({ type: 'agent.idle' });
    expect(requests).toHaveLength(1);

    await deliver(inbox('ответ 2', 'agent-2', 'agent-1', MSG2));
    expect(events.at(-1)).toMatchObject({ type: 'agent.idle' });
    expect(requests).toHaveLength(2);
    expect(countReminders(requests[1]?.messages ?? [])).toBe(0);

    await deliver(inbox('ответ 3', 'agent-3', 'agent-1', MSG3));
    expect(requests).toHaveLength(4);
    expect(countReminders(requests[2]?.messages ?? [])).toBe(0);
    expect(countReminders(requests[3]?.messages ?? [])).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: 'agent.result', data: { text: 'итог' } });
  });

  it('AC-022-28: агент не-вход при итоге text напоминания не получает — agent.idle после одного вызова модели', async () => {
    const { core, events, requests, deliver } = setup(
      {
        agentId: 'agent-2',
        agentName: 'Редактор',
        entryAgentId: 'agent-1',
        peers: [{ id: 'agent-1', name: 'Автор', role: 'пишет' }],
      },
      [reply('готово')],
    );
    await core.start();
    await deliver(inbox('правь', 'agent-1', 'agent-2', MSG));
    expect(requests).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'agent.idle' });
  });

  it('AC-022-28: после напоминания send_message к agent-2 — agent.idle без agent.result; ответ agent-2 не отбрасывается, finish по нему — agent.result', async () => {
    const { core, events, entries, requests, deliver } = setup({}, [
      reply('черновик'),
      toolCall('send_message', { to: 'agent-2', text: 'проверь' }),
      toolCall('finish', { result: 'итог' }),
    ]);
    await core.start();
    await deliver(inbox('T'));
    expect(events.at(-1)).toMatchObject({ type: 'agent.idle' });
    expect(events.some((e) => e.type === 'agent.result')).toBe(false);

    await deliver(inbox('правка', 'agent-2', 'agent-1', MSG2));
    expect(entries.some((e) => e.msg === 'message dropped')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'agent.result', data: { text: 'итог' } });
    expect(requests).toHaveLength(3);
  });

  it('AC-022-28: после напоминания текст null — agent.failed empty_result, agent.result нет', async () => {
    const { core, events, deliver } = setup({}, [
      reply('черновик'),
      { ok: true, message: { content: null, tool_calls: [] } },
    ]);
    await core.start();
    await deliver(inbox('T'));
    expect(events.at(-1)).toMatchObject({
      type: 'agent.failed',
      agentId: 'agent-1',
      data: { reason: 'empty_result' },
    });
    expect(events.some((e) => e.type === 'agent.result')).toBe(false);
  });

  it('AC-022-28: после напоминания текст из одних пробелов — agent.failed empty_result', async () => {
    const { core, events, deliver } = setup({}, [reply('черновик'), reply('  ')]);
    await core.start();
    await deliver(inbox('T'));
    expect(events.at(-1)).toMatchObject({
      type: 'agent.failed',
      data: { reason: 'empty_result' },
    });
    expect(events.some((e) => e.type === 'agent.result')).toBe(false);
  });
});
