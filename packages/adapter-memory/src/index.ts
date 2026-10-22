import type { SwarmStore } from '@swag/api-core';
import { applyEvent, type SwarmView } from '@swag/api-integration';
import type { PlatformEvent } from '@swag/contracts';

// Спека 001, 4.10: SwarmStore в памяти. События и SwarmView хранятся вместе; при перезапуске теряются (003 заменит адаптером Postgres).
export function createMemorySwarmStore(): SwarmStore {
  const events = new Map<string, PlatformEvent[]>();
  const views = new Map<string, SwarmView>();

  return {
    appendEvent(event: PlatformEvent): void {
      const current = views.get(event.swarmId) ?? null;
      const next = applyEvent(current, event); // бросает на недопустимое событие — тогда ничего не сохраняется
      if (next === current) return; // повтор seq — уже учтено
      views.set(event.swarmId, next);
      const list = events.get(event.swarmId) ?? [];
      list.push(event);
      events.set(event.swarmId, list);
    },

    events(swarmId: string, afterSeq: number): PlatformEvent[] {
      return (events.get(swarmId) ?? []).filter((event) => event.seq > afterSeq);
    },

    view(swarmId: string): SwarmView | null {
      return views.get(swarmId) ?? null;
    },

    views(): SwarmView[] {
      return [...views.values()];
    },
  };
}
