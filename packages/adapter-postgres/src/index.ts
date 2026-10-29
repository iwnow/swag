import { fileURLToPath } from 'node:url';
import type { SwarmStore } from '@swag/api-core';
import { applyEvent, type SwarmView } from '@swag/api-integration';
import { SwarmId, type PlatformEvent } from '@swag/contracts';
import type { Pool, PoolClient } from 'pg';
import { runner } from 'node-pg-migrate';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/** Применяет миграции из `migrations/` пакета (спека 003, 4.4, REQ-003-5). Повторный вызов ничего не меняет. */
export async function runMigrations(
  databaseUrl: string,
  options: { schema?: string } = {},
): Promise<void> {
  const schema = options.schema ?? 'public';
  await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction: 'up',
    schema,
    migrationsSchema: schema,
    migrationsTable: 'pgmigrations',
    advisoryLockMode: 'wait', // параллельные запуски (api, тесты) ждут друг друга, а не падают
    log: () => undefined,
  });
}

// Спека 003, 4.4. Схема берётся из search_path подключения: имена схем в SQL не вшиваются.
export function createPostgresSwarmStore(pool: Pool): SwarmStore {
  return {
    async appendEvent(event: PlatformEvent): Promise<void> {
      // Гонка двух swarm.created одного роя: проигравший откатывается и повторяет запись один раз.
      if (!(await writeOnce(pool, event))) await writeOnce(pool, event);
    },

    async events(swarmId: string, afterSeq: number): Promise<PlatformEvent[]> {
      if (!SwarmId.safeParse(swarmId).success) return [];
      const result = await pool.query<{ event: PlatformEvent }>(
        'select event from swarm_events where swarm_id = $1 and seq > $2 order by seq',
        [swarmId, afterSeq],
      );
      return result.rows.map((row) => row.event);
    },

    async view(swarmId: string): Promise<SwarmView | null> {
      if (!SwarmId.safeParse(swarmId).success) return null;
      const result = await pool.query<{ view: SwarmView }>(
        'select view from swarms where id = $1',
        [swarmId],
      );
      return result.rows[0]?.view ?? null;
    },

    async views(): Promise<SwarmView[]> {
      const result = await pool.query<{ view: SwarmView }>('select view from swarms');
      return result.rows.map((row) => row.view);
    },
  };
}

// Одна транзакция. Возвращает false, если строку роя за это время создал параллельный swarm.created:
// транзакция откатана, запись нужно повторить. Сбой rollback не скрывает исходную ошибку, клиент уходит из пула.
async function writeOnce(pool: Pool, event: PlatformEvent): Promise<boolean> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('begin');
    const written = await writeEvent(client, event);
    await client.query(written ? 'commit' : 'rollback');
    return written;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    client.release(broken);
  }
}

// Блокировка проекции роя, проверка применимости, запись проекции и события.
async function writeEvent(client: PoolClient, event: PlatformEvent): Promise<boolean> {
  const current =
    (
      await client.query<{ view: SwarmView }>('select view from swarms where id = $1 for update', [
        event.swarmId,
      ])
    ).rows[0]?.view ?? null;
  const next = applyEvent(current, event);
  if (next === current) return true; // повтор seq — уже учтено, ничего не пишем

  if (event.type === 'swarm.created') {
    const inserted = await client.query(
      'insert into swarms (id, status, created_at, last_seq, view) values ($1, $2, $3, $4, $5) on conflict (id) do nothing returning id',
      [next.id, next.status, next.createdAt, next.lastSeq, JSON.stringify(next)],
    );
    if (inserted.rowCount === 0) return false;
  } else {
    await client.query('update swarms set status = $2, last_seq = $3, view = $4 where id = $1', [
      next.id,
      next.status,
      next.lastSeq,
      JSON.stringify(next),
    ]);
  }
  await client.query('insert into swarm_events (swarm_id, seq, event) values ($1, $2, $3)', [
    event.swarmId,
    event.seq,
    JSON.stringify(event),
  ]);
  return true;
}
