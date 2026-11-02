import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { bootNodeRegistry, loadNodeRegistry, NodeTypesLoadError } from '../src/node-types.ts';

// Спека 021, 4.7: фикстуры вместо node_modules; @swag/node-example берётся из репозитория.
const fixtures = fileURLToPath(new URL('./fixtures/packages/', import.meta.url));
const repoPackages = fileURLToPath(new URL('../../../packages/', import.meta.url));
const fixtureNames = ['acme-nodes', 'throwing-node', 'broken-node', 'echo-copy'];

function resolve(specifier: string): string {
  const name = specifier.replace(/\/swag-node\.json$/, '');
  if (fixtureNames.includes(name)) return join(fixtures, name, 'swag-node.json');
  if (name === '@swag/node-example') return join(repoPackages, 'node-example', 'swag-node.json');
  throw Object.assign(new Error(`Cannot find module '${specifier}'`), { code: 'MODULE_NOT_FOUND' });
}

describe('loadNodeRegistry', () => {
  it('AC-021-4: пакет вне @swag/ с типом в пространстве swag — NodeTypesLoadError с сообщением reserved namespace swag', async () => {
    const error = await loadNodeRegistry(['acme-nodes'], { resolve }).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(NodeTypesLoadError);
    expect(error).toMatchObject({ packageName: 'acme-nodes', message: 'reserved namespace swag' });
  });

  it('AC-021-17: пакет с main, который нельзя импортировать, — реестр создан, код пакета не выполнен', async () => {
    const registry = await loadNodeRegistry(['throwing-node'], { resolve });
    expect(registry.list().map((item) => item.type)).toEqual(['acme/throwing']);
  });

  it('REQ-021-3: пакет из @swag/ с типом swag/* — загружается', async () => {
    const registry = await loadNodeRegistry(['@swag/node-example'], { resolve });
    expect(registry.list().map((item) => item.type)).toEqual(['example/echo']);
  });

  it('AC-021-18: повтор type@version между пакетами — NodeTypesLoadError с packageName null', async () => {
    const error = await loadNodeRegistry(['@swag/node-example', 'echo-copy'], { resolve }).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(NodeTypesLoadError);
    expect(error).toMatchObject({
      packageName: null,
      message: 'node_type_duplicate example/echo@1.0.0',
    });
  });

  it('AC-021-18: манифест не по схеме — NodeTypesLoadError с именем пакета', async () => {
    await expect(loadNodeRegistry(['broken-node'], { resolve })).rejects.toMatchObject({
      name: 'NodeTypesLoadError',
      packageName: 'broken-node',
    });
  });
});

describe('bootNodeRegistry', () => {
  // Спека 021, 4.7: fail завершает процесс; в тесте он бросает маркер, чтобы не выходить из теста.
  const exit = new Error('fail called');
  function fakes() {
    const log = { error: vi.fn() };
    const fail = vi.fn(() => Promise.reject(exit));
    return { log, fail };
  }

  it('AC-021-18: сломанный манифест — log.error node_manifest_invalid с package broken-node, затем fail', async () => {
    const { log, fail } = fakes();
    await expect(bootNodeRegistry(['broken-node'], { log, fail, resolve })).rejects.toBe(exit);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      'node_manifest_invalid',
      expect.objectContaining({ package: 'broken-node', err: expect.any(NodeTypesLoadError) }),
    );
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it('AC-021-18: неизвестный пакет — log.error с package missing-node, затем fail', async () => {
    const { log, fail } = fakes();
    await expect(bootNodeRegistry(['missing-node'], { log, fail, resolve })).rejects.toBe(exit);
    expect(log.error).toHaveBeenCalledWith(
      'node_manifest_invalid',
      expect.objectContaining({ package: 'missing-node', err: expect.any(NodeTypesLoadError) }),
    );
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it('AC-021-18: повтор type@version — log.error с package null, затем fail', async () => {
    const { log, fail } = fakes();
    await expect(
      bootNodeRegistry(['@swag/node-example', 'echo-copy'], { log, fail, resolve }),
    ).rejects.toBe(exit);
    expect(log.error).toHaveBeenCalledWith(
      'node_manifest_invalid',
      expect.objectContaining({ package: null, err: expect.any(NodeTypesLoadError) }),
    );
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it('AC-021-18: верный набор — реестр без лога и без fail', async () => {
    const { log, fail } = fakes();
    const registry = await bootNodeRegistry(['@swag/node-example'], { log, fail, resolve });
    expect(registry.list()).toHaveLength(1);
    expect(log.error).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });
});
