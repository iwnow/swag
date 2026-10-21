import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('..', import.meta.url);
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);

describe('политики репозитория', () => {
  it('AC-000-9: у каждого package.json private: true и лицензия SEE LICENSE IN LICENSE', () => {
    const files = git('ls-files', '--cached', '--others', '--exclude-standard', '**package.json');
    expect(files).toContain('package.json');
    expect(files).toContain('apps/api/package.json');
    for (const file of files) {
      const pkg = JSON.parse(readFileSync(new URL(file, root), 'utf8')) as Record<string, unknown>;
      expect({ file, private: pkg.private, license: pkg.license }).toEqual({
        file,
        private: true,
        license: 'SEE LICENSE IN LICENSE',
      });
    }
  });

  it('AC-000-10: .env в .gitignore и не отслеживается git', () => {
    const ignored = readFileSync(new URL('.gitignore', root), 'utf8').split('\n');
    expect(ignored).toContain('.env');
    expect(git('ls-files', '--', '.env')).toEqual([]);
    expect(git('check-ignore', '.env')).toEqual(['.env']);
  });
});
