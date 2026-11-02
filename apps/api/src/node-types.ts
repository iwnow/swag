import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createNodeRegistry, type NodeRegistry } from '@swag/api-integration';
import { NodeManifest } from '@swag/contracts';

// Спека 021, 4.7: ошибка загрузки; packageName — null, если ошибка реестра, а не пакета.
export class NodeTypesLoadError extends Error {
  readonly packageName: string | null;

  constructor(packageName: string | null, message: string) {
    super(message);
    this.packageName = packageName;
    this.name = 'NodeTypesLoadError';
  }
}

export interface LoadNodeTypesOptions {
  resolve?: (specifier: string) => string;
}

const requireFromHere = createRequire(import.meta.url);
const defaultResolve = (specifier: string): string => requireFromHere.resolve(specifier);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Спека 021, 4.7 (REQ-021-13): читается только swag-node.json, код пакета не импортируется.
export async function loadNodeRegistry(
  packages: readonly string[],
  options: LoadNodeTypesOptions = {},
): Promise<NodeRegistry> {
  const resolve = options.resolve ?? defaultResolve;
  const manifests: NodeManifest[] = [];
  for (const packageName of packages) {
    let manifest: NodeManifest;
    try {
      const text = await readFile(resolve(`${packageName}/swag-node.json`), 'utf8');
      manifest = NodeManifest.parse(JSON.parse(text));
    } catch (error) {
      throw new NodeTypesLoadError(packageName, messageOf(error));
    }
    if (!packageName.startsWith('@swag/') && manifest.type.startsWith('swag/')) {
      throw new NodeTypesLoadError(packageName, 'reserved namespace swag');
    }
    manifests.push(manifest);
  }
  const result = createNodeRegistry(manifests);
  if (!result.ok) throw new NodeTypesLoadError(null, `${result.error.code} ${result.error.ref}`);
  return result.registry;
}

// Спека 021, 4.7: для main.ts. Ошибка — лог node_manifest_invalid и fail(), который завершает процесс.
export async function bootNodeRegistry(
  packages: readonly string[],
  deps: {
    log: { error(msg: string, data?: object): void };
    fail: () => Promise<never>;
    resolve?: (specifier: string) => string;
  },
): Promise<NodeRegistry> {
  try {
    return await loadNodeRegistry(
      packages,
      deps.resolve === undefined ? {} : { resolve: deps.resolve },
    );
  } catch (error) {
    const packageName = error instanceof NodeTypesLoadError ? error.packageName : null;
    deps.log.error('node_manifest_invalid', { package: packageName, err: error });
    return deps.fail();
  }
}
