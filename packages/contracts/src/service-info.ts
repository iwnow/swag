import { z } from 'zod';

export const ServiceInfo = z.object({
  service: z.enum(['api', 'orchestrator', 'agent', 'llm-gateway', 'identity']),
  version: z.string().min(1),
});
export type ServiceInfo = z.infer<typeof ServiceInfo>;
