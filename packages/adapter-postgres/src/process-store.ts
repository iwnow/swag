import type { ProcessRecord, ProcessStore } from '@swag/api-core';
import type { Pool } from 'pg';

// Спека 033, 4.6 и 4.8: определения процессов. Таблицу пишет только api; внешние ключи — на organizations и users.
type ProcessRow = {
  id: string;
  org_id: string;
  created_by: string;
  definition: ProcessRecord['definition'];
  created_at: Date;
  updated_at: Date;
};

const COLUMNS = 'id, org_id, created_by, definition, created_at, updated_at';

const toProcess = (row: ProcessRow): ProcessRecord => ({
  id: row.id,
  orgId: row.org_id,
  createdBy: row.created_by,
  definition: row.definition,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const params = (record: ProcessRecord): unknown[] => [
  record.id,
  record.orgId,
  record.createdBy,
  JSON.stringify(record.definition),
  record.createdAt,
  record.updatedAt,
];

export function createPostgresProcessStore(pool: Pool): ProcessStore {
  return {
    async create(record) {
      await pool.query(
        `insert into processes (${COLUMNS}) values ($1, $2, $3, $4, $5, $6)`,
        params(record),
      );
    },

    async update(record) {
      const result = await pool.query(
        `update processes set org_id = $2, created_by = $3, definition = $4, created_at = $5, updated_at = $6
         where id = $1`,
        params(record),
      );
      if (!result.rowCount) throw new Error('process not found');
    },

    async get(id) {
      const { rows } = await pool.query<ProcessRow>(
        `select ${COLUMNS} from processes where id = $1`,
        [id],
      );
      return rows[0] ? toProcess(rows[0]) : null;
    },

    async list(orgId) {
      const { rows } = await pool.query<ProcessRow>(
        `select ${COLUMNS} from processes where ($1::uuid is null or org_id = $1) order by updated_at desc`,
        [orgId],
      );
      return rows.map(toProcess);
    },

    async count(orgId) {
      const { rows } = await pool.query<{ count: number }>(
        'select count(*)::int as count from processes where org_id = $1',
        [orgId],
      );
      return rows[0]?.count ?? 0;
    },

    async delete(id) {
      const result = await pool.query('delete from processes where id = $1', [id]);
      return (result.rowCount ?? 0) > 0;
    },
  };
}
