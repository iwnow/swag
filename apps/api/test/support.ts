import { createApiCore, type ApiCore, type OrchestratorClient } from '@swag/api-core';
import { createMemorySwarmStore } from '@swag/adapter-memory';

const nothing = () => undefined;
export const silentLog = { debug: nothing, info: nothing, warn: nothing, error: nothing };

// Ядро api с памятью и фейковым оркестратором для тестов оболочки.
export function makeCore(
  orchestrator: OrchestratorClient = { launch: async () => undefined, stop: async () => undefined },
): ApiCore {
  let counter = 0;
  return createApiCore({
    version: 'test',
    store: createMemorySwarmStore(),
    orchestrator,
    clock: { now: () => '2026-10-22T10:00:00.000Z' },
    ids: { uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}` },
    log: silentLog,
    trace: { currentTraceId: () => null },
    limits: { maxActiveSwarms: 3, maxBudgetMicroUsd: 5000000 },
  });
}

export const body = (count: number) => ({
  task: 'Задача',
  budgetMicroUsd: 1000000,
  agents: Array.from({ length: count }, (_, i) => ({
    name: `Агент ${i + 1}`,
    role: `роль ${i + 1}`,
  })),
});
