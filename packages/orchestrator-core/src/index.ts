import type { ServiceInfo } from '@swag/contracts';

export interface OrchestratorCoreDeps {
  version: string; // передаёт оболочка: ядро не читает package.json
}

export interface OrchestratorCore {
  info(): ServiceInfo;
}

export function createOrchestratorCore(deps: OrchestratorCoreDeps): OrchestratorCore {
  return {
    info: () => ({ service: 'orchestrator', version: deps.version }),
  };
}
