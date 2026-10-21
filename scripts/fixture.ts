import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Временный каталог с файлами `{ 'путь': 'содержимое' }`. */
export function createFixture(files: Record<string, string>): { root: string; remove: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'swag-fixture-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

/** Запускает скрипт из `scripts/` отдельным процессом Node, как это делает `npm run`. */
export function runScript(script: string, root: string): { code: number | null; output: string } {
  const path = fileURLToPath(new URL(script, import.meta.url));
  const result = spawnSync(process.execPath, [path, root], { encoding: 'utf8' });
  return { code: result.status, output: result.stdout + result.stderr };
}
