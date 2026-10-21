import type { ServiceInfo } from '@swag/contracts';

export interface AgentCoreDeps {
  version: string; // передаёт оболочка: ядро не читает package.json
}

export interface AgentCore {
  info(): ServiceInfo;
}

export function createAgentCore(deps: AgentCoreDeps): AgentCore {
  return {
    info: () => ({ service: 'agent', version: deps.version }),
  };
}
