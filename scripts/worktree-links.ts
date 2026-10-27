// Хук SessionStart Claude Code: в git worktree связывает node_modules и .env с основным чекаутом.
// node_modules — свой каталог: внешние пакеты — junction на основной чекаут, пакеты воркспейсов —
// junction на каталоги этого worktree (иначе код импортировал бы чужую копию @swag/*).
// Вне worktree и при уже существующих путях ничего не делает; ошибки не роняют сессию.
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function mainCheckout(): { worktree: string; main: string } | undefined {
  const worktree = resolve(git('rev-parse', '--show-toplevel'));
  const commonDir = resolve(worktree, git('rev-parse', '--git-common-dir'));
  if (basename(commonDir) !== '.git') return undefined;
  const main = dirname(commonDir);
  return main === worktree ? undefined : { worktree, main };
}

/** Имя пакета → каталог воркспейса в worktree, по полю workspaces корневого package.json. */
function workspaces(root: string): Map<string, string> {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    workspaces?: string[];
  };
  const result = new Map<string, string>();
  for (const pattern of pkg.workspaces ?? []) {
    // Поддерживаются шаблоны вида dir/* — других в репозитории нет.
    if (!pattern.endsWith('/*')) continue;
    const parent = join(root, pattern.slice(0, -2));
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      const manifest = join(parent, entry.name, 'package.json');
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as { name: string };
      result.set(name, join(parent, entry.name));
    }
  }
  return result;
}

function linkDir(source: string, target: string): void {
  if (!existsSync(target)) symlinkSync(source, target, 'junction');
}

function linkNodeModules(main: string, worktree: string): boolean {
  const source = join(main, 'node_modules');
  const target = join(worktree, 'node_modules');
  if (!existsSync(source) || existsSync(target)) return false;
  const local = workspaces(worktree);
  const scopes = new Set([...local.keys()].map((name) => name.split('/')[0]));
  mkdirSync(target);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (scopes.has(entry.name)) {
      // Скоуп воркспейсов: свои пакеты — из worktree, остальные — из основного чекаута.
      mkdirSync(to);
      for (const scoped of readdirSync(from)) {
        if (!local.has(`${entry.name}/${scoped}`)) linkDir(join(from, scoped), join(to, scoped));
      }
    } else if (entry.isFile()) {
      linkSync(from, to);
    } else if (!local.has(entry.name)) {
      linkDir(from, to);
    }
  }
  for (const [name, dir] of local) {
    mkdirSync(dirname(join(target, name)), { recursive: true });
    linkDir(dir, join(target, name));
  }
  return true;
}

function linkFile(main: string, worktree: string, name: string): boolean {
  const source = join(main, name);
  const target = join(worktree, name);
  if (!existsSync(source) || existsSync(target)) return false;
  linkSync(source, target);
  return true;
}

const linked: string[] = [];
try {
  const checkout = mainCheckout();
  if (checkout) {
    if (linkNodeModules(checkout.main, checkout.worktree)) linked.push('node_modules');
    if (linkFile(checkout.main, checkout.worktree, '.env')) linked.push('.env');
    if (linkFile(checkout.main, checkout.worktree, '.env.llm')) linked.push('.env.llm');
  }
} catch (error) {
  console.log(`worktree-links: ${error instanceof Error ? error.message : String(error)}`);
}
if (linked.length > 0) {
  console.log(`worktree-links: связаны с основным чекаутом: ${linked.join(', ')}`);
}
