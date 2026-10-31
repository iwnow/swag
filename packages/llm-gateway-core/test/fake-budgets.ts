import type { LlmCaller, LlmSwarmRegistration } from '@swag/contracts';
import type { BudgetStore, LedgerEntry } from '../src/index.ts';

// Спека 004, 4.4 и 4.5: BudgetStore в памяти теста. Те же правила, что условные update в 4.5, без БД.

interface AgentState {
  model: string;
  budget: number | null;
  spent: number;
  held: number;
}

interface SwarmState {
  budget: number;
  spent: number;
  held: number;
  expiresAt: Date | null;
  closed: boolean;
  agents: Map<string, AgentState>;
}

interface HoldState {
  swarmId: string;
  agentId: string;
  amount: number;
}

export interface FakeBudgets extends BudgetStore {
  readonly ledger: LedgerEntry[];
  // Синхронная регистрация для фикстуры; тесты ядра регистрируют через registerSwarm.
  seed(reg: LlmSwarmRegistration): void;
  swarm(swarmId: string): { spentMicroUsd: number; heldMicroUsd: number } | undefined;
  agent(
    swarmId: string,
    agentId: string,
  ): { spentMicroUsd: number; heldMicroUsd: number } | undefined;
  holdCallIds(): string[];
}

// settleFails: settle бросает (AC-004-17).
export function fakeBudgets(options: { settleFails?: boolean } = {}): FakeBudgets {
  const swarms = new Map<string, SwarmState>();
  const holds = new Map<string, HoldState>();
  const ledger: LedgerEntry[] = [];

  function register(reg: LlmSwarmRegistration): boolean {
    if (swarms.has(reg.swarmId)) return false;
    swarms.set(reg.swarmId, {
      budget: reg.budgetMicroUsd,
      spent: 0,
      held: 0,
      expiresAt: reg.expiresAt === null ? null : new Date(reg.expiresAt),
      closed: false,
      agents: new Map(
        reg.agents.map((agent) => [
          agent.agentId,
          { model: agent.model, budget: agent.budgetMicroUsd, spent: 0, held: 0 },
        ]),
      ),
    });
    return true;
  }

  const totals = (state: { spent: number; held: number }) => ({
    spentMicroUsd: state.spent,
    heldMicroUsd: state.held,
  });

  return {
    ledger,
    register: async (reg) => register(reg),
    seed(reg) {
      register(reg);
    },
    async findAgent(swarmId, agentId) {
      const swarm = swarms.get(swarmId);
      const agent = swarm?.agents.get(agentId);
      if (!swarm || !agent) return null;
      return { model: agent.model, expiresAt: swarm.expiresAt, closed: swarm.closed };
    },
    async reserve(callId, caller: LlmCaller, amount) {
      const swarm = swarms.get(caller.swarmId);
      if (!swarm || swarm.closed || swarm.spent + swarm.held + amount > swarm.budget) {
        return { ok: false, code: 'swarm_budget_exceeded' };
      }
      const agent = swarm.agents.get(caller.agentId);
      if (!agent) return { ok: false, code: 'agent_budget_exceeded' };
      if (agent.budget !== null && agent.spent + agent.held + amount > agent.budget) {
        return { ok: false, code: 'agent_budget_exceeded' };
      }
      swarm.held += amount;
      agent.held += amount;
      holds.set(callId, { swarmId: caller.swarmId, agentId: caller.agentId, amount });
      return { ok: true };
    },
    async settle(entry) {
      if (options.settleFails) throw new Error('fake budgets: сбой записи списания');
      if (ledger.some((existing) => existing.callId === entry.callId)) return;
      const swarm = swarms.get(entry.swarmId);
      const agent = swarm?.agents.get(entry.agentId);
      const hold = holds.get(entry.callId);
      if (swarm && agent && hold) {
        holds.delete(entry.callId);
        swarm.held -= hold.amount;
        agent.held -= hold.amount;
      }
      if (swarm && agent) {
        swarm.spent += entry.amountMicroUsd;
        agent.spent += entry.amountMicroUsd;
      }
      ledger.push(entry);
    },
    async close(swarmId) {
      const swarm = swarms.get(swarmId);
      if (!swarm) return null;
      swarm.closed = true;
      return totals(swarm);
    },
    async totals(swarmId) {
      const swarm = swarms.get(swarmId);
      return swarm ? totals(swarm) : null;
    },
    async releaseHolds() {
      const released = [...holds].map(([callId, hold]) => ({
        callId,
        swarmId: hold.swarmId,
        amountMicroUsd: hold.amount,
      }));
      for (const hold of holds.values()) {
        const swarm = swarms.get(hold.swarmId);
        const agent = swarm?.agents.get(hold.agentId);
        if (swarm && agent) {
          swarm.held -= hold.amount;
          agent.held -= hold.amount;
        }
      }
      holds.clear();
      return released;
    },
    swarm: (swarmId) => {
      const swarm = swarms.get(swarmId);
      return swarm && totals(swarm);
    },
    agent: (swarmId, agentId) => {
      const agent = swarms.get(swarmId)?.agents.get(agentId);
      return agent && totals(agent);
    },
    holdCallIds: () => [...holds.keys()],
  };
}
