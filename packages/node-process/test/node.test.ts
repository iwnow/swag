import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadNodePackages } from '@swag/node-packages';
import { toManifest } from '@swag/node-sdk';
import { describe, expect, it } from 'vitest';
import definition from '../src/node.ts';

const manifestFile = fileURLToPath(new URL('../swag-node.json', import.meta.url));

describe('swag/process', () => {
  it('REQ-033-17: swag-node.json совпадает с toManifest определения', () => {
    const manifest = JSON.parse(JSON.stringify(toManifest(definition)));
    expect(manifest).toEqual(JSON.parse(readFileSync(manifestFile, 'utf8')));
  });

  it('REQ-033-17: пакет загружается загрузчиком типов, тип swag/process@1.0.0 с видом program', async () => {
    const packages = await loadNodePackages(['@swag/node-process'], {
      resolve: () => manifestFile,
    });
    expect(packages.registry.list().map((item) => item.type)).toEqual(['swag/process']);
    expect(packages.packageOf('swag/process@1.0.0')).toBe('@swag/node-process');
    expect(packages.registry.get('swag/process@1.0.0')).toMatchObject({
      type: 'swag/process',
      version: '1.0.0',
      kind: 'program',
    });
  });

  it('REQ-033-17: processId — UUID; без него и с лишним полем настройки не проходят', () => {
    const processId = '0190b2c4-7f3a-7d1e-8a5b-2c9f4e6d1a20';
    expect(definition.settings.safeParse({ processId }).success).toBe(true);
    expect(definition.settings.safeParse({}).success).toBe(false);
    expect(definition.settings.safeParse({ processId: 'не-uuid' }).success).toBe(false);
    expect(definition.settings.safeParse({ processId, extra: 1 }).success).toBe(false);
  });
});
