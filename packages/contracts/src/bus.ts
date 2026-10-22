import { z } from 'zod';
import { AgentId, SwarmId } from './swarm.ts';

// Спека 001, 4.2. Core NATS без JetStream; тела — JSON в UTF-8.
export const inboxSubject = (swarmId: string, agentId: string): string =>
  `swarm.${swarmId}.agent.${agentId}.inbox`;
export const eventsSubject = (swarmId: string): string => `swarm.${swarmId}.events`;
export const ALL_INBOXES = 'swarm.*.agent.*.inbox';
export const ALL_EVENTS = 'swarm.*.events';

export const BusMessage = z.strictObject({
  id: z.uuid(),
  swarmId: SwarmId,
  from: z.union([AgentId, z.literal('user')]),
  to: AgentId,
  text: z.string(),
  ts: z.iso.datetime(),
});
export type BusMessage = z.infer<typeof BusMessage>;
