// Трассировка критериев приёмки в тесты: спека 000, раздел 4.6.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

const CHECKED_STATUSES = ['review', 'done'];
const SKIPPED_DIRS = ['node_modules', 'dist'];

const isDigit = (char: string | undefined) => char !== undefined && char >= '0' && char <= '9';

function isSpecFile(name: string): boolean {
  return [0, 1, 2].every((i) => isDigit(name[i])) && name[3] === '-' && name.endsWith('.md');
}

interface SpecMeta {
  id: string;
  status: string;
}

function readFrontmatter(text: string): SpecMeta | undefined {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return undefined;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end === -1) return undefined;
  const data = parse(lines.slice(1, end).join('\n')) as Record<string, unknown> | null;
  if (data?.id === undefined || data.status === undefined) return undefined;
  return { id: String(data.id).padStart(3, '0'), status: String(data.status) };
}

/** id критериев из строк `- **AC-NNN-n**`, кроме помеченных `[manual]`. */
function collectCriteria(lines: string[]): string[] {
  const prefix = '- **';
  const ids: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith(`${prefix}AC-`)) continue;
    const close = line.indexOf('**', prefix.length);
    if (close === -1) continue;
    if (
      line
        .slice(close + 2)
        .trimStart()
        .startsWith('`[manual]`')
    )
      continue;
    ids.push(line.slice(prefix.length, close));
  }
  return ids;
}

function readTestSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Скрытые каталоги (.git, .claude с чужими worktree) не часть кода репозитория.
      if (SKIPPED_DIRS.includes(entry.name) || entry.name.startsWith('.')) return [];
      return readTestSources(path);
    }
    const isTest = entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts');
    return isTest ? [readFileSync(path, 'utf8')] : [];
  });
}

export function specCheck(root: string): string[] {
  const specDir = join(root, 'docs', 'spec');
  if (!existsSync(specDir)) return [];
  let tests: string[] | undefined;
  const missing: string[] = [];

  for (const name of readdirSync(specDir).filter(isSpecFile).sort()) {
    const lines = readFileSync(join(specDir, name), 'utf8').split('\r\n').join('\n').split('\n');
    const meta = readFrontmatter(lines.join('\n'));
    if (!meta || !CHECKED_STATUSES.includes(meta.status)) continue;
    tests ??= readTestSources(root);
    for (const id of collectCriteria(lines)) {
      if (!tests.some((source) => source.includes(id)))
        missing.push(`spec ${meta.id}: ${id} — нет теста`);
    }
  }
  return missing;
}

if (import.meta.main) {
  const missing = specCheck(resolve(process.argv[2] ?? '.'));
  if (missing.length > 0) {
    console.error(missing.join('\n'));
    process.exit(1);
  }
  console.log('spec:check: у всех критериев есть тесты');
}
