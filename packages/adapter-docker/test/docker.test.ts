import Docker from 'dockerode';
import { describe, expect, it } from 'vitest';
import { createDockerSandboxProvider } from '../src/index.ts';

// Настоящий Docker. Без доступного демона тест пропускается с сообщением; в CI он обязателен (AC-001-22).
const docker = new Docker();
const dockerAvailable = await docker.ping().then(
  () => true,
  () => false,
);
if (!dockerAvailable) console.warn('adapter-docker: Docker недоступен, AC-001-22 пропущен');

const IMAGE = 'alpine:3.22';
const SWARM = '0b6f6d2e-6a4c-4c3e-9f5e-111111111111';

async function ensureImage(): Promise<void> {
  const images = await docker.listImages({ filters: { reference: [IMAGE] } });
  if (images.length > 0) return;
  await new Promise<void>((resolve, reject) => {
    docker.pull(IMAGE, (error: Error | null, stream: NodeJS.ReadableStream) => {
      if (error) return reject(error);
      docker.modem.followProgress(stream, (finishError: Error | null) =>
        finishError ? reject(finishError) : resolve(),
      );
    });
  });
}

describe.skipIf(!dockerAvailable)('adapter-docker', () => {
  it('AC-001-22: контейнер с метками, NATS_URL в env, без монтирований, портов и привилегий; list и remove', async () => {
    await ensureImage();
    const provider = createDockerSandboxProvider({
      network: 'bridge',
      natsUrl: 'nats://nats:4222',
    });
    const metadata = { 'swag.kind': 'agent', 'swag.swarm': SWARM, 'swag.agent': 'agent-1' };
    const { sandboxId } = await provider.create({
      template: IMAGE,
      env: { SWARM_ID: SWARM, AGENT_ID: 'agent-1' },
      metadata,
    });
    try {
      expect(await provider.list({ 'swag.swarm': SWARM })).toEqual([sandboxId]);
      expect(await provider.list({ 'swag.kind': true })).toContain(sandboxId);

      const info = await docker.getContainer(sandboxId).inspect();
      expect(info.Config.Labels).toMatchObject(metadata);
      expect(info.Config.Env).toEqual(
        expect.arrayContaining(['NATS_URL=nats://nats:4222', 'AGENT_ID=agent-1']),
      );
      expect(info.HostConfig.Binds ?? []).toEqual([]);
      expect(Object.keys(info.HostConfig.PortBindings ?? {})).toEqual([]);
      expect(info.HostConfig.Privileged).toBe(false);
      expect(info.HostConfig.NetworkMode).toBe('bridge');
    } finally {
      await provider.remove(sandboxId);
    }
    expect(await provider.list({ 'swag.swarm': SWARM })).toEqual([]);
    await provider.remove(sandboxId); // повторное удаление — не ошибка
  }, 120_000);
});
