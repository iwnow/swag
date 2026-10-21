// Проверка границ ядер: спека 000, раздел 4.5.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

export const CORE_ALLOWED_PACKAGES = ['zod', '@swag/contracts'];

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function isAllowedSpecifier(specifier: string): boolean {
  if (specifier.startsWith('./') || specifier.startsWith('../')) return true;
  return CORE_ALLOWED_PACKAGES.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );
}

function listTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

interface ImportRef {
  specifier: string;
  line: number;
}

function collectImports(file: string): ImportRef[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const refs: ImportRef[] = [];
  const add = (node: ts.Node, specifier: string) =>
    refs.push({ specifier, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
  // Спецификатор, который нельзя вычислить статически, тоже нарушение: ядро не грузит модули по имени из данных.
  const addExpression = (node: ts.Node, expression: ts.Expression | undefined) =>
    add(node, expression && ts.isStringLiteralLike(expression) ? expression.text : '<не литерал>');

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) addExpression(node, node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addExpression(node, node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      addExpression(node, node.arguments[0]);
    } else if (ts.isImportTypeNode(node)) {
      const literal = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
      addExpression(node, literal && ts.isStringLiteral(literal) ? literal : undefined);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return refs;
}

export function archCheck(root: string): string[] {
  const packagesDir = join(root, 'packages');
  if (!existsSync(packagesDir)) return [];
  const violations: string[] = [];

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    const dir = join(packagesDir, entry.name);
    if (!entry.isDirectory() || !entry.name.endsWith('-core')) continue;
    if (!existsSync(join(dir, 'package.json'))) continue;

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
    const name = pkg.name ?? entry.name;
    const deps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ];
    for (const dep of deps) {
      if (!CORE_ALLOWED_PACKAGES.includes(dep))
        violations.push(`${name}: запрещённая зависимость ${dep}`);
    }

    for (const file of listTsFiles(join(dir, 'src'))) {
      const path = relative(root, file).split('\\').join('/');
      for (const { specifier, line } of collectImports(file)) {
        if (!isAllowedSpecifier(specifier)) {
          violations.push(`${name}: ${path}:${line} — запрещённый импорт ${specifier}`);
        }
      }
    }
  }
  return violations;
}

if (import.meta.main) {
  const violations = archCheck(resolve(process.argv[2] ?? '.'));
  if (violations.length > 0) {
    console.error(violations.join('\n'));
    process.exit(1);
  }
  console.log('arch:check: нарушений нет');
}
