import { afterEach, describe, expect, it } from 'vitest';
import { createFixture, runScript } from './fixture.ts';

const spec = (id: string, status: string, criteria: string[]) =>
  [
    '---',
    `id: "${id}"`,
    'title: Фикстура',
    `status: ${status}`,
    '---',
    '',
    '## 5. Критерии приёмки',
    '',
    ...criteria,
    '',
  ].join('\n');

let remove = () => {};
afterEach(() => remove());

function check(files: Record<string, string>) {
  const fixture = createFixture(files);
  remove = fixture.remove;
  return runScript('spec-check.ts', fixture.root);
}

describe('spec:check', () => {
  it('AC-000-6: спека в review с AC без теста — выход 1 и id критерия в выводе', () => {
    const { code, output } = check({
      'docs/spec/900-demo.md': spec('900', 'review', [
        '- **AC-900-1** — *Given* … *Then* …',
        '- **AC-900-2** — *Given* … *Then* …',
      ]),
      'packages/demo/test/demo.test.ts': "it('AC-900-1: есть тест', () => {});\n",
    });
    expect(code).toBe(1);
    expect(output).toContain('spec 900: AC-900-2 — нет теста');
    expect(output).not.toContain('AC-900-1 ');
  });

  it('AC-000-7: у всех AC есть тесты, кроме [manual] — выход 0', () => {
    const { code, output } = check({
      'docs/spec/901-demo.md': spec('901', 'review', [
        '- **AC-901-1** — *Given* … *Then* …',
        '- **AC-901-2** `[manual]` — проверка руками',
        '- **AC-901-3** — *Given* … *Then* …',
      ]).replaceAll('\n', '\r\n'),
      'apps/demo/test/a.test.ts': "it('AC-901-1: тест', () => {});\n",
      'scripts/b.spec.ts': "it('AC-901-3: тест', () => {});\n",
    });
    expect(output).toContain('у всех критериев есть тесты');
    expect(code).toBe(0);
  });

  it('AC-000-8: спека в draft без тестов не влияет на результат', () => {
    const { code } = check({
      'docs/spec/902-demo.md': spec('902', 'draft', ['- **AC-902-1** — *Given* … *Then* …']),
      'docs/spec/903-demo.md': spec('903', 'done', ['- **AC-903-1** — *Given* … *Then* …']),
      'apps/demo/test/a.test.ts': "it('AC-903-1: тест', () => {});\n",
    });
    expect(code).toBe(0);
  });

  it('спека в in-progress без тестов не влияет на результат (D-40)', () => {
    const { code } = check({
      'docs/spec/905-demo.md': spec('905', 'in-progress', ['- **AC-905-1** — *Given* …']),
    });
    expect(code).toBe(0);
  });

  it('тест в node_modules или dist не закрывает критерий', () => {
    const { code, output } = check({
      'docs/spec/904-demo.md': spec('904', 'review', ['- **AC-904-1** — *Given* …']),
      'node_modules/x/a.test.ts': "it('AC-904-1', () => {});\n",
      'apps/demo/dist/a.test.ts': "it('AC-904-1', () => {});\n",
    });
    expect(code).toBe(1);
    expect(output).toContain('spec 904: AC-904-1 — нет теста');
  });
});
