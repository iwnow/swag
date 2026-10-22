import { afterEach, describe, expect, it } from 'vitest';
import { createFixture, runScript } from './fixture.ts';

const corePackage = (dependencies: Record<string, string> = {}) =>
  JSON.stringify({ name: '@swag/demo-core', dependencies });

let remove = () => {};
afterEach(() => remove());

function check(files: Record<string, string>) {
  const fixture = createFixture(files);
  remove = fixture.remove;
  return runScript('arch-check.ts', fixture.root);
}

describe('arch:check', () => {
  it('AC-000-17: импорт fastify или node:fs в ядре — выход 1 с файлом, строкой и спецификатором', () => {
    const { code, output } = check({
      'packages/demo-core/package.json': corePackage(),
      'packages/demo-core/src/index.ts':
        "import Fastify from 'fastify';\nexport const app = Fastify;\n",
      'packages/demo-core/src/fs.ts':
        "export const x = 1;\n\nimport { readFile } from 'node:fs';\nexport { readFile };\n",
      'packages/demo-core/src/lazy.ts': "export const load = () => import('pg');\n",
    });
    expect(code).toBe(1);
    expect(output).toContain(
      '@swag/demo-core: packages/demo-core/src/index.ts:1 — запрещённый импорт fastify',
    );
    expect(output).toContain(
      '@swag/demo-core: packages/demo-core/src/fs.ts:3 — запрещённый импорт node:fs',
    );
    expect(output).toContain(
      '@swag/demo-core: packages/demo-core/src/lazy.ts:1 — запрещённый импорт pg',
    );
  });

  it('AC-000-18: fastify в dependencies ядра — выход 1 с именем зависимости', () => {
    const { code, output } = check({
      'packages/demo-core/package.json': corePackage({ zod: '4.0.0', fastify: '5.0.0' }),
      'packages/demo-core/src/index.ts': 'export const x = 1;\n',
    });
    expect(code).toBe(1);
    expect(output).toContain('@swag/demo-core: запрещённая зависимость fastify');
    expect(output).not.toContain('зависимость zod');
  });

  it('AC-000-19: только относительные импорты, zod и @swag/contracts — выход 0', () => {
    const { code, output } = check({
      'packages/demo-core/package.json': corePackage({ zod: '4.0.0', '@swag/contracts': '0.0.0' }),
      'packages/demo-core/src/index.ts': [
        "import { z } from 'zod';",
        "import type { ServiceInfo } from '@swag/contracts';",
        "import { helper } from './nested/helper.ts';",
        "export * from './nested/helper.ts';",
        'export const schema = z.string();',
        'export type Info = ServiceInfo;',
        'export const value = helper;',
      ].join('\n'),
      'packages/demo-core/src/nested/helper.ts':
        "export { other } from '../other.ts';\nexport const helper = 1;\n",
      'packages/demo-core/src/other.ts': 'export const other = 2;\n',
      // Не ядро: правила к нему не применяются.
      'packages/config/package.json': JSON.stringify({
        name: '@swag/config',
        dependencies: { pg: '8' },
      }),
      'packages/config/src/index.ts': "import 'node:fs';\n",
    });
    expect(output).toContain('нарушений нет');
    expect(code).toBe(0);
  });

  it('AC-001-24: contracts с node:fs — выход 1 с файлом, строкой и спецификатором', () => {
    const { code, output } = check({
      'packages/contracts/package.json': JSON.stringify({ name: '@swag/contracts', dependencies: { zod: '4.6.7' } }),
      'packages/contracts/src/index.ts': "export const x = 1;\nimport { readFile } from 'node:fs';\nexport { readFile };\n",
    });
    expect(code).toBe(1);
    expect(output).toContain('@swag/contracts: packages/contracts/src/index.ts:2 — запрещённый импорт node:fs');
  });

  it('AC-001-24: api-integration с зависимостью на ядро api-core — выход 1; ядро, импортирующее api-integration, — выход 0', () => {
    const bad = check({
      'packages/api-integration/package.json': JSON.stringify({
        name: '@swag/api-integration',
        dependencies: { zod: '4.6.7', '@swag/api-core': '0.0.0' },
      }),
      'packages/api-integration/src/index.ts': "export const x = 1;\n",
    });
    expect(bad.code).toBe(1);
    expect(bad.output).toContain('@swag/api-integration: запрещённая зависимость @swag/api-core');

    const good = check({
      'packages/demo-core/package.json': corePackage({ '@swag/api-integration': '0.0.0' }),
      'packages/demo-core/src/index.ts': "import { applyEvent } from '@swag/api-integration';\nexport { applyEvent };\n",
    });
    expect(good.code).toBe(0);
  });
});
