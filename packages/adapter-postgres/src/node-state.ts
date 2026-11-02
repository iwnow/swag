import type { NodeStateStore } from '@swag/orchestrator-core';
import type { Pool } from 'pg';

// Спека 026, 4.5, 4.10. Лимиты key и value проверяет ядро оркестратора до вызова адаптера.
export function createPostgresNodeState(pool: Pool): NodeStateStore {
  return {
    async get(orgId, stateKey, key) {
      const result = await pool.query<{ value: string }>(
        'select value from node_state where org_id = $1 and state_key = $2 and key = $3',
        [orgId, stateKey, key],
      );
      return result.rows[0]?.value ?? null;
    },

    async set(orgId, stateKey, key, value, now) {
      if (value === null) {
        await pool.query(
          'delete from node_state where org_id = $1 and state_key = $2 and key = $3',
          [orgId, stateKey, key],
        );
        return;
      }
      await pool.query(
        `insert into node_state (org_id, state_key, key, value, updated_at)
         values ($1, $2, $3, $4, $5)
         on conflict (org_id, state_key, key) do update
           set value = excluded.value, updated_at = excluded.updated_at`,
        [orgId, stateKey, key, value, now],
      );
    },
  };
}
