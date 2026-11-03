import { describe, expect, it, vi } from 'vitest';
import {
  inboxMessage,
  runAgentLoop,
  swarmTools,
  systemPrompt,
  type AgentCallContext,
  type AgentPeer,
  type ChatModel,
  type ChatModelResult,
  type PromptAgent,
} from '../src/index.ts';

const peers: AgentPeer[] = [
  { id: 'agent-2', name: 'Редактор', role: 'проверяет текст' },
  { id: 'agent-3', name: 'Аналитик', role: 'считает цифры' },
];
const entry: PromptAgent = {
  agentId: 'agent-1',
  agentName: 'Автор',
  agentRole: 'пишет текст',
  peers,
  entryAgentId: 'agent-1',
};

const SEND_MESSAGE_PARAMETERS = {
  type: 'object',
  properties: {
    to: { type: 'string', enum: ['agent-2', 'agent-3'] },
    text: { type: 'string', minLength: 1 },
  },
  required: ['to', 'text'],
  additionalProperties: false,
};
const FINISH_PARAMETERS = {
  type: 'object',
  properties: { result: { type: 'string', minLength: 1 } },
  required: ['result'],
  additionalProperties: false,
};

describe('промпт и инструменты агента роя (спека 022, 4.5)', () => {
  it('AC-022-12: системный промпт входа и сообщение пользователя совпадают с шаблонами посимвольно', () => {
    expect(systemPrompt(entry)).toBe(
      [
        'Ты — агент «Автор» в команде агентов. Твоя роль: пишет текст',
        'Участники команды:',
        '- agent-2 «Редактор»: проверяет текст',
        '- agent-3 «Аналитик»: считает цифры',
        'Писать участникам можно только инструментом send_message. Текст ответа без инструмента видит только платформа.',
        'Задачу тебе ставит пользователь. Когда задача решена, вызови finish с итоговым результатом: его получит пользователь.',
      ].join('\n'),
    );
    expect(inboxMessage({ from: 'user', text: 'четверостишие про осень' }, peers)).toEqual({
      role: 'user',
      content: 'Задача от пользователя:\nчетверостишие про осень',
    });
    expect(inboxMessage({ from: 'agent-2', text: 'готово' }, peers)).toEqual({
      role: 'user',
      content: 'Сообщение от agent-2 «Редактор»:\nготово',
    });
  });

  it('AC-022-12: у входа два инструмента — send_message с enum из участников и finish, схемы буквально по 4.5', () => {
    const tools = swarmTools(entry, async () => {});
    expect(tools.map((tool) => tool.definition)).toEqual([
      {
        name: 'send_message',
        description: 'Отправить сообщение участнику команды',
        parameters: SEND_MESSAGE_PARAMETERS,
      },
      {
        name: 'finish',
        description: 'Завершить задачу и вернуть итог пользователю',
        parameters: FINISH_PARAMETERS,
      },
    ]);
  });

  it('AC-022-12: агент без участников и не вход — ни промпт-блока участников, ни инструментов', () => {
    const solo: PromptAgent = {
      ...entry,
      agentId: 'agent-2',
      agentName: 'Соло',
      agentRole: 'один',
      peers: [],
    };
    expect(systemPrompt(solo)).toBe(
      [
        'Ты — агент «Соло» в команде агентов. Твоя роль: один',
        'Результат своей работы отправь через send_message тому, кто дал тебе задание.',
      ].join('\n'),
    );
    expect(swarmTools(solo, async () => {})).toEqual([]);
  });

  it('AC-022-14: send_message к себе, к user и к несуществующему агенту — ошибка модели, BusMessage не уходит', async () => {
    const send = vi.fn(async () => {});
    const worker: PromptAgent = {
      ...entry,
      agentId: 'agent-2',
      peers: [
        { id: 'agent-1', name: 'Автор', role: 'пишет' },
        { id: 'agent-3', name: 'Аналитик', role: 'считает' },
      ],
    };
    const tools = swarmTools(worker, send);
    const calls = [
      { id: 'c1', to: 'agent-2' },
      { id: 'c2', to: 'user' },
      { id: 'c3', to: 'agent-9' },
    ];
    const script: ChatModelResult[] = [
      {
        ok: true,
        message: {
          content: null,
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: 'send_message',
              arguments: JSON.stringify({ to: call.to, text: 'привет' }),
            },
          })),
        },
      },
      { ok: true, message: { content: 'итог', tool_calls: [] } },
    ];
    const requests: unknown[] = [];
    const model: ChatModel = {
      complete: async (request) => {
        requests.push(request);
        const next = script.shift();
        if (next === undefined) throw new Error('script exhausted');
        return next;
      },
    };
    const context: AgentCallContext = {
      model: 'chat-small',
      systemPrompt: systemPrompt(worker),
      history: [],
      input: { role: 'user', content: 'задача' },
      tools,
      limits: { maxSteps: 5, maxTokens: 100 },
    };

    const result = await runAgentLoop({ model, onStep: async () => {} }, context);

    expect(send).not.toHaveBeenCalled();
    expect(result.kind).toBe('text');
    const second = requests[1] as { messages: { role: string; content: string }[] };
    const toolReplies = second.messages.filter((message) => message.role === 'tool');
    expect(toolReplies.map((message) => message.content)).toEqual([
      expect.stringMatching(/^error: to: /),
      expect.stringMatching(/^error: to: /),
      expect.stringMatching(/^error: to: /),
    ]);
  });

  it('AC-022-12: успешная отправка вызывает колбэк с адресатом и текстом, модель получает подтверждение', async () => {
    const send = vi.fn(async () => {});
    const [sendTool] = swarmTools(entry, send);
    const outcome = await sendTool?.execute({ to: 'agent-3', text: 'цифры' });
    expect(outcome).toEqual({
      content: 'ok: отправлено agent-3. Ответ придёт отдельным сообщением.',
      yieldTurn: true,
    });
    expect(send).toHaveBeenCalledWith('agent-3', 'цифры');
  });

  it('AC-030-4: send_message успешный — yieldTurn и колбэк; неверный адресат — error без yieldTurn, колбэк не вызван', async () => {
    const send = vi.fn(async () => {});
    const [sendTool] = swarmTools(entry, send);
    expect(await sendTool?.execute({ to: 'agent-2', text: 'x' })).toEqual({
      content: 'ok: отправлено agent-2. Ответ придёт отдельным сообщением.',
      yieldTurn: true,
    });
    expect(send).toHaveBeenCalledTimes(1);

    const rejected = await sendTool?.execute({ to: 'agent-9', text: 'x' });
    expect(rejected?.content).toMatch(/^error: /);
    expect(rejected).not.toHaveProperty('yieldTurn');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('AC-022-12: finish возвращает stop с результатом, пустой текст и лишние поля — ошибка', async () => {
    const [, finish] = swarmTools(entry, async () => {});
    expect(await finish?.execute({ result: 'готово' })).toEqual({
      content: 'ok',
      stop: { result: 'готово' },
    });
    expect((await finish?.execute({ result: '' }))?.content).toMatch(/^error: result: /);
    expect((await finish?.execute({ result: 'x', extra: 1 }))?.content).toMatch(/^error: /);
  });
});

describe('промпт агента-входа команды графа (спека 009, 4.8)', () => {
  const cases: {
    taskFrom: 'user' | 'intake';
    resultTo: 'user' | 'process';
    task: string;
    result: string;
    finish: string;
  }[] = [
    {
      taskFrom: 'user',
      resultTo: 'user',
      task: 'Задачу тебе ставит пользователь.',
      result:
        'Когда задача решена, вызови finish с итоговым результатом: его получит пользователь.',
      finish: 'Завершить задачу и вернуть итог пользователю',
    },
    {
      taskFrom: 'user',
      resultTo: 'process',
      task: 'Задачу тебе ставит пользователь.',
      result:
        'Когда задача решена, вызови finish с итоговым результатом: он уйдёт следующему шагу процесса.',
      finish: 'Завершить задачу и вернуть итог следующему шагу процесса',
    },
    {
      taskFrom: 'intake',
      resultTo: 'user',
      task: 'Задачу тебе передаёт шаг процесса intake.',
      result:
        'Когда задача решена, вызови finish с итоговым результатом: его получит пользователь.',
      finish: 'Завершить задачу и вернуть итог пользователю',
    },
    {
      taskFrom: 'intake',
      resultTo: 'process',
      task: 'Задачу тебе передаёт шаг процесса intake.',
      result:
        'Когда задача решена, вызови finish с итоговым результатом: он уйдёт следующему шагу процесса.',
      finish: 'Завершить задачу и вернуть итог следующему шагу процесса',
    },
  ];

  it.each(cases)(
    'AC-009-23: вход $taskFrom → $resultTo — строки промпта и описание finish по таблице 4.8',
    ({ taskFrom, resultTo, task, result, finish }) => {
      const agent: PromptAgent = { ...entry, taskFrom, resultTo };
      const lines = systemPrompt(agent).split('\n');
      expect(lines.at(-1)).toBe(`${task} ${result}`);
      const [, finishTool] = swarmTools(agent, async () => {});
      expect(finishTool?.definition.description).toBe(finish);
    },
  );

  it('AC-009-23: сообщение от шага, не участника команды, подписано как вход от шага процесса', () => {
    expect(inboxMessage({ from: 'intake', text: 'исходные данные' }, peers)).toEqual({
      role: 'user',
      content: 'Вход от шага процесса intake:\nисходные данные',
    });
  });
});
