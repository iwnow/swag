import type { OrchestratorClient } from '@swag/api-core';
import type { SwarmLaunch } from '@swag/contracts';

// Спека 001, 4.6.1 и Q-6: api → orchestrator по HTTP.
export interface OrchestratorHttpOptions {
  baseUrl: string; // ORCHESTRATOR_URL, например http://orchestrator:3001
  fetch?: typeof fetch;
}

export function createOrchestratorHttpClient(options: OrchestratorHttpOptions): OrchestratorClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;

  return {
    async launch(launch: SwarmLaunch): Promise<void> {
      const response = await doFetch(`${base}/swarms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(launch),
      });
      if (response.status !== 202) {
        throw new Error(`оркестратор ответил ${response.status} на запуск роя`);
      }
    },

    async stop(swarmId: string): Promise<void> {
      const response = await doFetch(`${base}/swarms/${encodeURIComponent(swarmId)}/stop`, {
        method: 'POST',
      });
      if (response.status !== 202) {
        throw new Error(`оркестратор ответил ${response.status} на остановку роя`);
      }
    },
  };
}
