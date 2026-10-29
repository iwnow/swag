import type { SwarmStore } from '@swag/api-core';
import { applyEvent, type SwarmView } from '@swag/api-integration';
import type { PlatformEvent } from '@swag/contracts';

// Спека 001, 4.10; спека 003, REQ-003-10: SwarmStore в памяти с тем же асинхронным портом.
// Остаётся для тестов ядра; при перезапуске всё теряется. Рабочее хранилище — @swag/adapter-postgres (спека 003, T-5, T-6).
export function createMemorySwarmStore(): SwarmStore {
  const events = new Map<string, PlatformEvent[]>();
  const views = new Map<string, SwarmView>();

  return {
    async appendEvent(event: PlatformEvent): Promise<void> {
      const current = views.get(event.swarmId) ?? null;
      const next = applyEvent(current, event); // бросает на недопустимое событие — тогда ничего не сохраняется
      if (next === current) return; // повтор seq — уже учтено
      views.set(event.swarmId, next);
      const list = events.get(event.swarmId) ?? [];
      list.push(event);
      events.set(event.swarmId, list);
    },

    async events(swarmId: string, afterSeq: number): Promise<PlatformEvent[]> {
      return (events.get(swarmId) ?? []).filter((event) => event.seq > afterSeq);
    },

    async view(swarmId: string): Promise<SwarmView | null> {
      return views.get(swarmId) ?? null;
    },

    async views(): Promise<SwarmView[]> {
      return [...views.values()];
    },
  };
}
