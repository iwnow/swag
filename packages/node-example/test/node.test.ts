import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeError, toManifest } from '@swag/node-sdk';
import { createTestContext, runNode } from '@swag/node-sdk/testing';
import { describe, expect, it, vi } from 'vitest';
import echo from '../src/node.ts';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
const manifestFile = fileURLToPath(new URL('../swag-node.json', import.meta.url));

describe('example/echo', () => {
  it('AC-021-11: runNode возвращает эхо с префиксом; вход не по схеме — invalid_input без вызова execute; настройки не по схеме — invalid_settings', async () => {
    const ctx = createTestContext(echo, { settings: { prefix: '> ' } });
    await expect(runNode(echo, ctx, { text: 'hi' })).resolves.toEqual({ text: '> hi' });

    const execute = vi.fn(echo.execute);
    const probe = { ...echo, execute };
    const probeCtx = createTestContext(probe, { settings: { prefix: '> ' } });
    await expect(runNode(probe, probeCtx, { text: 1 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(execute).not.toHaveBeenCalled();

    let caught: unknown = null;
    try {
      createTestContext(echo, { settings: { prefix: 1 } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NodeError);
    expect((caught as NodeError).code).toBe('invalid_settings');
  });

  it('AC-021-15: swag-node.json совпадает с toManifest определения', () => {
    const manifest = JSON.parse(JSON.stringify(toManifest(echo)));
    expect(manifest).toEqual(JSON.parse(readFileSync(manifestFile, 'utf8')));
  });

  it('AC-021-16: в src импортируются только zod и @swag/node-sdk', () => {
    const specifiers = readdirSync(srcDir)
      .filter((name) => name.endsWith('.ts'))
      .flatMap((name) => {
        const source = readFileSync(join(srcDir, name), 'utf8');
        return [...source.matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
          (match) => match[1],
        );
      });
    expect([...new Set(specifiers)].sort()).toEqual(['@swag/node-sdk', 'zod']);
  });
});
