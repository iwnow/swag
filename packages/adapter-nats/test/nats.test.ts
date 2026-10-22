import { describe, expect, it } from 'vitest';
import { connect } from '@nats-io/transport-node';
import { ALL_EVENTS, ALL_INBOXES, eventsSubject, inboxSubject } from '@swag/contracts';
import { connectNatsBus } from '../src/index.ts';

// Нужен запущенный NATS: NATS_TEST_URL, например nats://127.0.0.1:4222 (compose или сервис в CI).
const url = process.env['NATS_TEST_URL'];
const SWARM = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';

describe.skipIf(!url)('adapter-nats', () => {
  it('AC-001-21: BusMessage и событие приходят неизменёнными; невалидный JSON не ломает подписку', async () => {
    const bus = await connectNatsBus({ url: url ?? '' });
    const raw = await connect({ servers: url ?? '' });
    const inbox: unknown[] = [];
    const events: unknown[] = [];
    bus.subscribeJson(ALL_INBOXES, (value) => inbox.push(value));
    bus.subscribeJson(ALL_EVENTS, (value) => events.push(value));

    const message = {
      id: '0b6f6d2e-6a4c-4c3e-9f5e-222222222222',
      swarmId: SWARM,
      from: 'user',
      to: 'agent-1',
      text: 'Привет',
      ts: '2026-10-22T10:00:00.000Z',
    };
    const event = {
      id: '0b6f6d2e-6a4c-4c3e-9f5e-333333333333',
      swarmId: SWARM,
      ts: '2026-10-22T10:00:00.000Z',
      source: 'orchestrator',
      agentId: null,
      type: 'swarm.started',
      data: {},
    };

    await bus.publishJson(inboxSubject(SWARM, 'agent-1'), message);
    raw.publish(inboxSubject(SWARM, 'agent-1'), new TextEncoder().encode('{не json'));
    await bus.publishJson(eventsSubject(SWARM), event);
    await raw.flush();

    await waitFor(() => expect(inbox).toHaveLength(1));
    await waitFor(() => expect(events).toHaveLength(1));
    expect(inbox[0]).toEqual(message);
    expect(events[0]).toEqual(event);

    await raw.close();
    await bus.close();
  });
});

async function waitFor(assertion: () => void, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
