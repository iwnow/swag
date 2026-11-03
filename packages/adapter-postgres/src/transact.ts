import type { Pool, PoolClient } from 'pg';

// Одна транзакция. commit: false откатывает её (отказ по бюджету — ничего не записано).
export async function transact<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<{ commit: boolean; value: T }>,
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('begin');
    const { commit, value } = await work(client);
    await client.query(commit ? 'commit' : 'rollback');
    return value;
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
