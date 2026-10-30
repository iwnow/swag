import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { onHost } from '../../../scripts/host-url.ts';
import { apiUrl, FETCH_TIMEOUT_MS, required, run } from './stack-support.ts';

// Спека 004, AC-004-34 и AC-004-35 [stack]: настоящий стек (`npm run up`, LLM_PROFILE=test).
// LLM_GATEWAY_URL, например http://127.0.0.1:3002; без неё тесты пропускаются, как в stack.test.ts.
// Из окружения: LLM_GATEWAY_TOKEN и DATABASE_URL (из .env), STACK_API_URL — адрес api.
const gatewayUrl = process.env['LLM_GATEWAY_URL'];
const json = { 'content-type': 'application/json' };
const SWARM_TIMEOUT_MS = 240_000;
const POLL_MS = 500;
const TERMINAL_STATUSES = ['completed', 'stopped', 'failed'];

interface SwarmView {
  id: string;
  status: string;
  spentMicroUsd: number;
  failure: { reason: string; detail?: string } | null;
}

// Имя `postgres` видно только внутри сети compose: с хоста адрес берётся через onHost, как в db:migrate.
function databaseUrl(): string {
  const url = required('DATABASE_URL');
  return new URL(url).hostname === 'postgres' ? onHost(url) : url;
}

async function createSwarm(
  budgetMicroUsd: number,
  agents: { name: string; role: string; model: string }[],
): Promise<string> {
  const response = await fetch(`${apiUrl}/swarms`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ task: 'стек-тест спеки 004', budgetMicroUsd, agents }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

// Ожидание финального статуса роя: опрос раз в полсекунды до дедлайна (стек работает асинхронно).
async function waitForTerminal(swarmId: string): Promise<SwarmView> {
  const deadline = Date.now() + SWARM_TIMEOUT_MS;
  for (;;) {
    const response = await fetch(`${apiUrl}/swarms/${swarmId}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    expect(response.status).toBe(200);
    const view = (await response.json()) as SwarmView;
    if (TERMINAL_STATUSES.includes(view.status) || Date.now() > deadline) return view;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function withDb<T>(use: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = new pg.Client({ connectionString: databaseUrl() });
  await db.connect();
  try {
    return await use(db);
  } finally {
    await db.end();
  }
}

describe.skipIf(!gatewayUrl)('деньги роя на стеке [stack] (спека 004)', () => {
  it('AC-004-34: рой из двух агентов завершён — бюджет закрыт, агенты с моделями из запроса, ledger = spentMicroUsd, вызов после завершения — 403', async () => {
    const swarmId = await createSwarm(500_000, [
      { name: 'первый', role: 'вход роя', model: 'chat-small' },
      { name: 'второй', role: 'помощник', model: 'chat-large' },
    ]);
    const view = await waitForTerminal(swarmId);
    expect(view.status).toBe('completed');

    await withDb(async (db) => {
      const budget = await db.query<{ closed: boolean }>(
        'select closed_at is not null as closed from swarm_budgets where swarm_id = $1',
        [swarmId],
      );
      expect(budget.rows[0]?.closed).toBe(true);

      const agents = await db.query<{ agent_id: string; model: string }>(
        'select agent_id, model from swarm_agents where swarm_id = $1 order by agent_id',
        [swarmId],
      );
      expect(agents.rows).toEqual([
        { agent_id: 'agent-1', model: 'chat-small' },
        { agent_id: 'agent-2', model: 'chat-large' },
      ]);

      const ledger = await db.query<{ sum: string }>(
        'select coalesce(sum(amount_micro_usd), 0)::text as sum from ledger_entries where swarm_id = $1',
        [swarmId],
      );
      expect(Number(ledger.rows[0]?.sum)).toBe(view.spentMicroUsd);
    });

    const after = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        ...json,
        authorization: `Bearer ${required('LLM_GATEWAY_TOKEN')}`,
        'x-swag-swarm-id': swarmId,
        'x-swag-agent-id': 'agent-1',
      },
      body: JSON.stringify({
        model: 'chat-small',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    expect(after.status).toBe(403);
    const body = (await after.json()) as { error: { code: string } };
    expect(body.error.code).toBe('caller_not_registered');
  }, 300_000);

  it('AC-004-35: рой с бюджетом 1 — swarm.failed budget_exceeded, песочниц с меткой swag.kind нет, записей ledger роя нет', async () => {
    const swarmId = await createSwarm(1, [{ name: 'один', role: 'вход роя', model: 'chat-small' }]);
    const view = await waitForTerminal(swarmId);
    expect(view.status).toBe('failed');
    expect(view.failure).toMatchObject({ reason: 'budget_exceeded' });

    const sandboxes = await run('docker', [
      'ps',
      '-a',
      '--filter',
      'label=swag.kind',
      '--format',
      '{{.ID}}',
    ]);
    expect(sandboxes.code).toBe(0);
    expect(sandboxes.stdout.trim()).toBe('');

    const ledger = await withDb((db) =>
      db.query<{ n: number }>('select count(*)::int as n from ledger_entries where swarm_id = $1', [
        swarmId,
      ]),
    );
    expect(ledger.rows[0]?.n).toBe(0);
  }, 300_000);
});
