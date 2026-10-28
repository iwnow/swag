import { z } from 'zod';
import type { AgentId } from '@swag/contracts';
import type { AgentTool, ChatMessage } from './loop.ts';

// Спека 022, 4.5 — промпт, входящие сообщения и инструменты агента роя. Чистые функции: отправка — колбэк.

export interface AgentPeer {
  id: AgentId;
  name: string;
  role: string;
}

export interface PromptAgent {
  agentId: AgentId;
  agentName: string;
  agentRole: string;
  peers: AgentPeer[];
  entryAgentId: AgentId;
}

export type SendMessage = (to: AgentId, text: string) => Promise<void>;

const SEND_LINE =
  'Писать участникам можно только инструментом send_message. Текст ответа без инструмента видит только платформа.';
const ENTRY_LINE =
  'Задачу тебе ставит пользователь. Когда задача решена, вызови finish с итоговым результатом: его получит пользователь.';
const WORKER_LINE = 'Результат своей работы отправь через send_message тому, кто дал тебе задание.';

export function systemPrompt(agent: PromptAgent): string {
  const lines = [
    `Ты — агент «${agent.agentName}» в команде агентов. Твоя роль: ${agent.agentRole}`,
  ];
  if (agent.peers.length > 0) {
    lines.push('Участники команды:');
    for (const peer of agent.peers) lines.push(`- ${peer.id} «${peer.name}»: ${peer.role}`);
    lines.push(SEND_LINE);
  }
  lines.push(agent.agentId === agent.entryAgentId ? ENTRY_LINE : WORKER_LINE);
  return lines.join('\n');
}

export function inboxMessage(
  message: { from: AgentId | 'user'; text: string },
  peers: AgentPeer[],
): ChatMessage {
  if (message.from === 'user')
    return { role: 'user', content: `Задача от пользователя:\n${message.text}` };
  const name = peers.find((peer) => peer.id === message.from)?.name ?? '';
  return { role: 'user', content: `Сообщение от ${message.from} «${name}»:\n${message.text}` };
}

export function swarmTools(agent: PromptAgent, send: SendMessage): AgentTool[] {
  const tools: AgentTool[] = [];
  if (agent.peers.length > 0) tools.push(sendMessageTool(agent.peers, send));
  if (agent.agentId === agent.entryAgentId) tools.push(finishTool());
  return tools;
}

function sendMessageTool(peers: AgentPeer[], send: SendMessage): AgentTool {
  const ids = peers.map((peer) => peer.id);
  const args = z.strictObject({
    to: z.enum(ids as [AgentId, ...AgentId[]]),
    text: z.string().min(1),
  });
  return {
    definition: {
      name: 'send_message',
      description: 'Отправить сообщение участнику команды',
      parameters: {
        type: 'object',
        properties: { to: { type: 'string', enum: ids }, text: { type: 'string', minLength: 1 } },
        required: ['to', 'text'],
        additionalProperties: false,
      },
    },
    async execute(raw) {
      const parsed = args.safeParse(raw);
      if (!parsed.success) return { content: `error: ${formatError(parsed.error)}` };
      await send(parsed.data.to, parsed.data.text);
      return { content: `ok: отправлено ${parsed.data.to}` };
    },
  };
}

function finishTool(): AgentTool {
  const args = z.strictObject({ result: z.string().min(1) });
  return {
    definition: {
      name: 'finish',
      description: 'Завершить задачу и вернуть итог пользователю',
      parameters: {
        type: 'object',
        properties: { result: { type: 'string', minLength: 1 } },
        required: ['result'],
        additionalProperties: false,
      },
    },
    async execute(raw) {
      const parsed = args.safeParse(raw);
      if (!parsed.success) return { content: `error: ${formatError(parsed.error)}` };
      return { content: 'ok', stop: { result: parsed.data.result } };
    },
  };
}

// Корень схемы (аргументы не объект) — путь `args`, иначе модель получит пустой путь.
function formatError(error: z.ZodError): string {
  const [issue] = error.issues;
  const path = issue?.path.map(String).join('.') || 'args';
  return `${path}: ${issue?.message ?? 'invalid'}`;
}
