import type {
  AgentId,
  AgentStatus,
  PlatformEvent,
  PlatformModel,
  SwarmStatus,
} from '@swag/contracts';

// Спека 001, 4.4; правила 022, 4.6. Проекция роя из его событий. Одна реализация для api-core и ui-core.

export interface SwarmView {
  id: string;
  task: string;
  status: SwarmStatus;
  createdAt: string; // ts события swarm.created
  agents: {
    id: AgentId;
    name: string;
    role: string;
    model: PlatformModel;
    status: AgentStatus;
    messagesIn: number;
    messagesOut: number;
    steps: number; // число agent.step — вызовов модели
  }[];
  edges: { from: AgentId; to: AgentId; messages: number }[]; // рёбра по фактическим сообщениям агентов
  result: string | null;
  failure: { reason: string; detail?: string } | null;
  lastSeq: number;
}

const FINAL_AGENT_STATUSES: readonly AgentStatus[] = ['done', 'failed', 'stopped'];
export const FINAL_SWARM_STATUSES: readonly SwarmStatus[] = ['completed', 'stopped', 'failed'];

export function applyEvent(view: SwarmView | null, event: PlatformEvent): SwarmView {
  if (view !== null && event.seq <= view.lastSeq) return view; // повтор или устаревший номер — состояние не меняем
  if (view === null) {
    if (event.type !== 'swarm.created') {
      throw new Error(`событие ${event.type} до swarm.created (рой ${event.swarmId})`);
    }
    return createView(event);
  }
  if (event.type === 'swarm.created') {
    throw new Error(`повторный swarm.created для роя ${event.swarmId}`);
  }
  // Итоговый статус окончателен (003, 4.3): событие двигает только lastSeq.
  if (FINAL_SWARM_STATUSES.includes(view.status)) return { ...view, lastSeq: event.seq };
  return updateView(view, event);
}

export function projectSwarm(events: PlatformEvent[]): SwarmView {
  return events.reduce<SwarmView | null>(applyEvent, null) as SwarmView;
}

function createView(event: Extract<PlatformEvent, { type: 'swarm.created' }>): SwarmView {
  return {
    id: event.swarmId,
    task: event.data.task,
    status: 'starting',
    createdAt: event.ts,
    agents: event.data.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      model: agent.model,
      status: 'starting' as const,
      messagesIn: 0,
      messagesOut: 0,
      steps: 0,
    })),
    edges: [],
    result: null,
    failure: null,
    lastSeq: event.seq,
  };
}

function updateView(view: SwarmView, event: PlatformEvent): SwarmView {
  const next: SwarmView = { ...view, lastSeq: event.seq };
  const withAgent = (
    id: AgentId,
    change: (a: SwarmView['agents'][number]) => SwarmView['agents'][number],
  ): void => {
    next.agents = next.agents.map((a) => (a.id === id ? change(a) : a));
  };

  switch (event.type) {
    case 'swarm.started':
      next.status = 'running';
      break;
    case 'swarm.completed':
      next.status = 'completed';
      next.result = event.data.result;
      break;
    case 'swarm.stopped':
      next.status = 'stopped';
      break;
    case 'swarm.failed':
      next.status = 'failed';
      next.failure =
        event.data.detail === undefined
          ? { reason: event.data.reason }
          : { reason: event.data.reason, detail: event.data.detail };
      break;
    case 'agent.started':
      if (event.agentId) withAgent(event.agentId, (a) => ({ ...a, status: 'idle' }));
      break;
    case 'agent.working':
      if (event.agentId) withAgent(event.agentId, (a) => ({ ...a, status: 'working' }));
      break;
    case 'agent.step':
      if (event.agentId) withAgent(event.agentId, (a) => ({ ...a, steps: a.steps + 1 }));
      break;
    case 'agent.idle':
      if (event.agentId) {
        withAgent(event.agentId, (a) =>
          FINAL_AGENT_STATUSES.includes(a.status) ? a : { ...a, status: 'idle' },
        );
      }
      break;
    case 'agent.result':
      if (event.agentId) withAgent(event.agentId, (a) => ({ ...a, status: 'done' }));
      break;
    case 'agent.stopped':
      if (event.agentId) {
        withAgent(event.agentId, (a) =>
          FINAL_AGENT_STATUSES.includes(a.status) ? a : { ...a, status: 'stopped' },
        );
      }
      break;
    case 'agent.failed':
      if (event.agentId) withAgent(event.agentId, (a) => ({ ...a, status: 'failed' }));
      break;
    case 'bus.message': {
      const { from, to } = event.data;
      withAgent(to, (a) => ({ ...a, messagesIn: a.messagesIn + 1 }));
      if (from !== 'user') {
        withAgent(from, (a) => ({ ...a, messagesOut: a.messagesOut + 1 }));
        const edge = next.edges.find((e) => e.from === from && e.to === to);
        if (edge) {
          next.edges = next.edges.map((e) => (e === edge ? { ...e, messages: e.messages + 1 } : e));
        } else {
          next.edges = [...next.edges, { from, to, messages: 1 }];
        }
      }
      break;
    }
    default:
      // swarm.created и agent.launched не меняют статусы из таблицы 4.4.
      break;
  }
  return next;
}
