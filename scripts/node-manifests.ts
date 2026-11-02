// Выгрузка swag-node.json пакетов узлов: спека 021, 4.5. Запуск: `npm run nodes:manifest`.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { NodeDefinition } from '@swag/node-sdk';
import { toManifest } from '@swag/node-sdk';

const packagesDir = fileURLToPath(new URL('../packages/', import.meta.url));

const nodeDirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() &&
      entry.name.startsWith('node-') &&
      existsSync(join(packagesDir, entry.name, 'src', 'node.ts')),
  )
  .map((entry) => entry.name)
  .sort();

for (const dir of nodeDirs) {
  const packageDir = join(packagesDir, dir);
  const module = (await import(pathToFileURL(join(packageDir, 'src', 'node.ts')).href)) as {
    default: NodeDefinition;
  };
  writeFileSync(
    join(packageDir, 'swag-node.json'),
    JSON.stringify(toManifest(module.default), null, 2) + '\n',
  );
  console.log(`${dir}: swag-node.json`);
}
