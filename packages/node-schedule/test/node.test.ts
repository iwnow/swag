import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadNodePackages } from '@swag/node-packages';
import { toManifest } from '@swag/node-sdk';
import { describe, expect, it } from 'vitest';
import definition from '../src/node.ts';

const manifestFile = fileURLToPath(new URL('../swag-node.json', import.meta.url));

describe('swag/schedule', () => {
  it('REQ-033-9: swag-node.json совпадает с toManifest определения', () => {
    const manifest = JSON.parse(JSON.stringify(toManifest(definition)));
    expect(manifest).toEqual(JSON.parse(readFileSync(manifestFile, 'utf8')));
  });

  it('REQ-033-9: пакет загружается загрузчиком типов, тип swag/schedule@1.0.0 с видом trigger', async () => {
    const packages = await loadNodePackages(['@swag/node-schedule'], {
      resolve: () => manifestFile,
    });
    expect(packages.registry.list().map((item) => item.type)).toEqual(['swag/schedule']);
    expect(packages.packageOf('swag/schedule@1.0.0')).toBe('@swag/node-schedule');
    expect(packages.registry.get('swag/schedule@1.0.0')).toMatchObject({
      type: 'swag/schedule',
      version: '1.0.0',
      kind: 'trigger',
    });
  });

  it('REQ-033-9: умолчания настроек — everySec null, cron null, timezone UTC', () => {
    expect(definition.settings.parse({})).toEqual({
      everySec: null,
      cron: null,
      timezone: 'UTC',
    });
  });
});
