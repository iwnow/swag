import { z } from 'zod';
import { AgentId, AgentSpec, SwarmId } from './swarm.ts';

// Спека 001, 4.3. Конверт одинаковый для всех событий; type и data — дискриминированное объединение.
const Envelope = {
  id: z.uuid(), // назначает публикующий
  swarmId: SwarmId,
  ts: z.iso.datetime(), // время публикующего
  source: z.enum(['api', 'orchestrator', 'agent']),
  agentId: AgentId.nullable(), // null — событие роя
};

export const PlatformEventInput = z.discriminatedUnion('type', [
  z.strictObject({ ...Envelope, type: z.literal('swarm.created'), data: z.strictObject({ task: z.string(), agents: z.array(AgentSpec) }) }),
  z.strictObject({ ...Envelope, type: z.literal('swarm.started'), data: z.strictObject({}) }),
  z.strictObject({ ...Envelope, type: z.literal('swarm.completed'), data: z.strictObject({ result: z.string() }) }),
  z.strictObject({ ...Envelope, type: z.literal('swarm.stopped'), data: z.strictObject({ reason: z.literal('user') }) }),
  z.strictObject({
    ...Envelope,
    type: z.literal('swarm.failed'),
    data: z.strictObject({
      reason: z.enum(['agent_start_timeout', 'swarm_timeout', 'orchestrator_unavailable', 'sandbox_error']),
      detail: z.string().optional(),
    }),
  }),
  z.strictObject({ ...Envelope, type: z.literal('agent.launched'), data: z.strictObject({ sandboxId: z.string() }) }),
  z.strictObject({ ...Envelope, type: z.literal('agent.started'), data: z.strictObject({}) }),
  z.strictObject({ ...Envelope, type: z.literal('agent.working'), data: z.strictObject({ messageId: z.uuid() }) }),
  z.strictObject({ ...Envelope, type: z.literal('agent.result'), data: z.strictObject({ text: z.string() }) }),
  z.strictObject({ ...Envelope, type: z.literal('agent.stopped'), data: z.strictObject({}) }),
  z.strictObject({ ...Envelope, type: z.literal('agent.failed'), data: z.strictObject({ reason: z.string() }) }),
  z.strictObject({
    ...Envelope,
    type: z.literal('bus.message'),
    data: z.strictObject({
      messageId: z.uuid(),
      from: z.union([AgentId, z.literal('user')]),
      to: AgentId,
      text: z.string(),
    }),
  }),
]);
export type PlatformEventInput = z.infer<typeof PlatformEventInput>;

// Хранится и отдаётся api: + сквозной номер внутри роя.
export type PlatformEvent = PlatformEventInput & { seq: number }; // seq ≥ 1, без пропусков
