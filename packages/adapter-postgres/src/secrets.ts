import type { SecretStore } from '@swag/api-core';
import type { SecretCipher } from '@swag/adapter-crypto';
import type { SecretName, SecretSummary } from '@swag/contracts';
import type { SecretReader } from '@swag/orchestrator-core';
import type { Pool } from 'pg';

// Спека 026, 4.5, 4.6. Секреты организации: шифротекст AES-256-GCM, AAD `${orgId}:${name}`.
interface SecretRow {
  name: string;
  hint: string | null;
  updated_at: Date;
}

// Последние 4 символа — только если в значении не меньше 16 символов (SecretSummary, 4.1).
// Счёт в единицах UTF-16, как z.string().length(4) в SecretSummary.
function secretHint(value: string): string | null {
  return value.length >= 16 ? value.slice(-4) : null;
}

function toSummary(row: SecretRow): SecretSummary {
  return { name: row.name, hint: row.hint, updatedAt: row.updated_at.toISOString() };
}

export function createPostgresSecretStore(
  pool: Pool,
  cipher: SecretCipher,
): SecretStore & SecretReader {
  return {
    async list(orgId) {
      const result = await pool.query<SecretRow>(
        'select name, hint, updated_at from org_secrets where org_id = $1 order by name',
        [orgId],
      );
      return result.rows.map(toSummary);
    },

    async put(orgId, name: SecretName, value, by, now) {
      const ciphertext = cipher.encrypt(value, `${orgId}:${name}`);
      const result = await pool.query<SecretRow>(
        `insert into org_secrets (org_id, name, ciphertext, hint, updated_at, updated_by)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (org_id, name) do update
           set ciphertext = excluded.ciphertext,
               hint = excluded.hint,
               updated_at = excluded.updated_at,
               updated_by = excluded.updated_by
         returning name, hint, updated_at`,
        [orgId, name, Buffer.from(ciphertext), secretHint(value), now, by],
      );
      const row = result.rows[0];
      if (!row) throw new Error('put secret: запись не вернулась');
      return toSummary(row);
    },

    async delete(orgId, name) {
      const result = await pool.query('delete from org_secrets where org_id = $1 and name = $2', [
        orgId,
        name,
      ]);
      return (result.rowCount ?? 0) > 0;
    },

    async read(orgId, names) {
      if (names.length === 0) return {};
      const result = await pool.query<{ name: string; ciphertext: Buffer }>(
        'select name, ciphertext from org_secrets where org_id = $1 and name = any($2::text[])',
        [orgId, [...names]],
      );
      return Object.fromEntries(
        result.rows.map((row) => [
          row.name,
          cipher.decrypt(new Uint8Array(row.ciphertext), `${orgId}:${row.name}`),
        ]),
      );
    },
  };
}
