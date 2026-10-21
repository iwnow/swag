import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('сборка', () => {
  it('AC-000-1: npm run build завершается с кодом 0', () => {
    const root = new URL('..', import.meta.url);
    const result = spawnSync('npm run build', { cwd: root, shell: true, encoding: 'utf8' });
    expect(result.stdout + result.stderr).not.toContain('error TS');
    expect(result.status).toBe(0);
  }, 120_000);
});
