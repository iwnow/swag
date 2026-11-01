import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const listFiles = (dir: string, pattern: RegExp): string[] =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .filter((name) => pattern.test(name))
    .map((name) => join(dir, name));

const css = readFileSync(
  new URL('../packages/ui-angular/styles/tokens.css', import.meta.url),
  'utf8',
);

const colorNames = [
  'bg',
  'surface',
  'surface-2',
  'text',
  'text-muted',
  'border',
  'focus',
  'primary',
  'primary-text',
  'danger',
  'danger-text',
  'success',
  'warning',
].map((name) => `--swag-color-${name}`);
const otherNames = [
  '--swag-font-sans',
  '--swag-font-mono',
  ...['sm', 'md', 'lg', 'xl'].map((size) => `--swag-text-${size}`),
  ...[1, 2, 3, 4, 5, 6].map((step) => `--swag-space-${step}`),
  '--swag-radius-sm',
  '--swag-radius-md',
  '--swag-shadow-1',
];

const pairs = [
  ['text', 'bg'],
  ['text', 'surface'],
  ['text-muted', 'surface'],
  ['primary-text', 'primary'],
  ['danger-text', 'danger'],
] as const;

const declarations = (header: string): Map<string, string> => {
  const start = css.indexOf(`${header} {`);
  expect(start, `блок ${header}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start + header.length + 2, css.indexOf('}', start));
  const result = new Map<string, string>();
  for (const line of body.split(';')) {
    const colon = line.indexOf(':');
    if (colon > 0) result.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return result;
};

const themes = {
  light: declarations(':root'),
  dark: declarations(":root[data-theme='dark']"),
  darkBySystem: declarations(":root:not([data-theme='light'])"),
};

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

const contrast = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
};

const isHex = (value: string | undefined): boolean =>
  value !== undefined &&
  value.length === 7 &&
  value.startsWith('#') &&
  !Number.isNaN(Number(`0x${value.slice(1)}`));

describe('токены дизайн-системы (спека 014, 4.8)', () => {
  it('AC-014-10: у обеих тем есть все токены 4.8, цвета — #rrggbb', () => {
    for (const name of [...colorNames, ...otherNames]) {
      expect(themes.light.has(name), `светлая: ${name}`).toBe(true);
    }
    for (const name of [...colorNames, '--swag-shadow-1']) {
      expect(themes.dark.has(name), `тёмная: ${name}`).toBe(true);
    }
    for (const theme of [themes.light, themes.dark, themes.darkBySystem]) {
      for (const name of colorNames) expect(isHex(theme.get(name)), name).toBe(true);
    }
  });

  it('AC-014-10: тёмная тема по атрибуту и по системе совпадают', () => {
    expect([...themes.darkBySystem]).toEqual([...themes.dark]);
  });

  it('AC-014-10: блок системной тёмной темы лежит внутри @media (prefers-color-scheme: dark)', () => {
    const media = css.indexOf('@media (prefers-color-scheme: dark)');
    const selector = css.indexOf(":root:not([data-theme='light'])");
    expect(media).toBeGreaterThanOrEqual(0);
    expect(selector).toBeGreaterThan(media);
    let depth = 0;
    let closed = false;
    for (const ch of css.slice(media, selector)) {
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) closed = true;
    }
    expect(closed).toBe(false);
    expect(depth).toBeGreaterThan(0);
  });

  it('AC-014-10: пары REQ-014-21 дают контраст не ниже 4.5:1 в обеих темах', () => {
    for (const [themeName, theme] of Object.entries(themes)) {
      for (const [fg, bg] of pairs) {
        const ratio = contrast(theme.get(`--swag-color-${fg}`)!, theme.get(`--swag-color-${bg}`)!);
        expect(ratio, `${themeName}: ${fg}/${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('цветовые литералы (спека 014, REQ-014-16)', () => {
  const colorLiteral =
    /(?<![\w&/-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])|(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi;
  const tokensFile = fileURLToPath(
    new URL('../packages/ui-angular/styles/tokens.css', import.meta.url),
  );
  const sourceDirs = [
    '../apps/ui/cabinet/src',
    '../packages/ui-angular/src',
    '../packages/ui-angular/styles',
  ].map((dir) => fileURLToPath(new URL(dir, import.meta.url)));

  const sourceFiles = (dir: string): string[] =>
    listFiles(dir, /\.(ts|html|css)$/)
      .filter((file) => !/\.(test|spec)\.ts$/.test(file))
      .filter((file) => file !== tokensFile);

  it('AC-014-10: в кабинете и пакете нет цветовых литералов вне tokens.css', () => {
    const files = sourceDirs.flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(0);
    const found = files.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(colorLiteral)].map((match) => `${file}: ${match[0]}`),
    );
    expect(found).toEqual([]);
  });
});

// Спека 014, REQ-014-23, AC-014-26: компоненты не ходят в API, не собирают адаптеры и не открывают сигналы ядра.
const forbiddenSpec = (spec: string): boolean =>
  spec === '@preact/signals-core' || spec.startsWith('@preact/signals-core/');
const forbiddenName = (name: string): boolean =>
  /^(createRequest|authApi|create\w*(Api|Store))$/.test(name);
const globalObjects = new Set(['window', 'globalThis', 'self']);

const frontendViolations = (file: string, text: string): string[] => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
  }
  const checkSpec = (spec: string, kind: string): void => {
    if (forbiddenSpec(spec)) found.push(`${kind} из ${spec}`);
  };
  const checkNames = (
    spec: string,
    kind: string,
    elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[],
  ): void => {
    for (const element of elements) {
      const name = (element.propertyName ?? element.name).text;
      if (forbiddenName(name)) found.push(`${kind} ${name} из ${spec}`);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const spec = (node.moduleSpecifier as ts.StringLiteral).text;
      checkSpec(spec, 'импорт');
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) checkNames(spec, 'импорт', bindings.elements);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const spec = (node.moduleSpecifier as ts.StringLiteral).text;
      checkSpec(spec, 'реэкспорт');
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        checkNames(spec, 'реэкспорт', node.exportClause.elements);
      }
    } else if (ts.isCallExpression(node)) {
      const [arg] = node.arguments;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (arg && ts.isStringLiteral(arg)) checkSpec(arg.text, 'динамический импорт');
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'fetch') {
        found.push('вызов fetch(');
      }
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const object = node.expression.text;
      const member = node.name.text;
      if (globalObjects.has(object) && member === 'fetch') {
        found.push(`обращение ${object}.fetch`);
      } else if (namespaces.has(object) && forbiddenName(member)) {
        found.push(`обращение ${object}.${member}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found.map((violation) => `${file}: ${violation}`);
};

describe('границы фронтендов (спека 014, REQ-014-23, AC-014-26)', () => {
  const uiApps = fileURLToPath(new URL('../apps/ui', import.meta.url));
  const uiSrcDirs = readdirSync(uiApps, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(uiApps, entry.name, 'src'))
    .filter((dir) => existsSync(dir));

  it('AC-014-26: в apps/ui/*/src нет импортов createRequest, create*Api, authApi, create*Store, @preact/signals-core и вызовов fetch(', () => {
    expect(uiSrcDirs.length).toBeGreaterThan(0);
    const found = uiSrcDirs
      .flatMap((dir) => listFiles(dir, /\.ts$/))
      .flatMap((file) => frontendViolations(file, readFileSync(file, 'utf8')));
    expect(found).toEqual([]);
  });

  it('AC-014-26: проверка границ находит нарушения на образце', () => {
    const sample = [
      "import { createRequest } from '@swag/ui-angular';",
      "import { createUsersApi as users } from '@swag/ui-angular';",
      "import { signal } from '@preact/signals-core';",
      "fetch('/api/me');",
      "export { createRequest } from '@swag/ui-angular';",
      "export * from '@preact/signals-core';",
      "await import('@preact/signals-core');",
      "window.fetch('/x');",
      "globalThis.fetch('/x');",
      "import * as api from '@swag/ui-angular';",
      'api.createSwarmsApi(s);',
    ].join('\n');
    expect(frontendViolations('sample.ts', sample)).toHaveLength(10);
  });

  it('AC-014-26: проверка границ не находит нарушений в коде на мосте', () => {
    const sample = [
      "import { connectStore, toAngularSignal, provideCabinetStore, CABINET_STORE, SESSION_USER } from '@swag/ui-angular';",
      "import * as ui from '@swag/ui-angular';",
      'provideCabinetStore();',
      'connectStore(CABINET_STORE);',
      'toAngularSignal(SESSION_USER);',
      'ui.connectStore(CABINET_STORE);',
    ].join('\n');
    expect(frontendViolations('ok.ts', sample)).toEqual([]);
  });
});
