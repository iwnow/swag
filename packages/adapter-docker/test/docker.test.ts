import Docker from 'dockerode';
import { describe, expect, it } from 'vitest';
import { createMemoryExporters, startTelemetry } from '@swag/adapter-telemetry';
import { createDockerSandboxProvider } from '../src/index.ts';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

// Настоящий Docker. Без доступного демона тест пропускается с сообщением; в CI он обязателен (AC-001-22).
const docker = new Docker();
const dockerAvailable = await docker.ping().then(
  () => true,
  () => false,
);
if (!dockerAvailable) {
  console.warn('adapter-docker: Docker недоступен, AC-001-22 и AC-016-10 пропущены');
}

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

  it('AC-016-10: в env контейнера TRACEPARENT с trace-id T и OTEL_EXPORTER_OTLP_ENDPOINT; в SandboxSpec их нет; спан sandbox.create', async () => {
    await ensureImage();
    const memory = createMemoryExporters();
    const telemetry = startTelemetry({
      service: 'orchestrator',
      version: 'test',
      otlpEndpoint: null,
      logLevel: 'info',
      flushTimeoutMs: 500,
      stdout: () => undefined,
      exporters: { spans: memory.spans },
    });
    const provider = createDockerSandboxProvider({
      network: 'bridge',
      natsUrl: 'nats://nats:4222',
      otlpEndpoint: 'http://otel-collector:4318',
    });
    const swarm = '0b6f6d2e-6a4c-4c3e-9f5e-016016016016';
    const spec = {
      template: IMAGE,
      env: { SWARM_ID: swarm, AGENT_ID: 'agent-2' },
      metadata: { 'swag.kind': 'agent', 'swag.swarm': swarm, 'swag.agent': 'agent-2' },
    };
    const { sandboxId } = await telemetry.inSpan(
      'launch',
      { parent: `00-${TRACE}-00f067aa0ba902b7-01` },
      () => provider.create(spec),
    );
    try {
      const info = await docker.getContainer(sandboxId).inspect();
      const env = info.Config.Env ?? [];
      const traceparent = env.find((e) => e.startsWith('TRACEPARENT='));
      expect(traceparent).toMatch(new RegExp(`^TRACEPARENT=00-${TRACE}-[0-9a-f]{16}-01$`));
      expect(env).toContain('OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318');
      expect(Object.keys(spec.env)).toEqual(['SWARM_ID', 'AGENT_ID']);
      // В песочницу не попадают адреса Grafana, Tempo и Loki (REQ-016-14).
      expect(env.filter((e) => /GRAFANA|TEMPO|LOKI/.test(e))).toEqual([]);

      const created = memory.finishedSpans.find((s) => s.name === 'sandbox.create');
      expect(created?.spanContext().traceId).toBe(TRACE);
      expect(created?.attributes).toMatchObject({
        'swarm.id': swarm,
        'agent.id': 'agent-2',
        'sandbox.id': sandboxId,
      });
    } finally {
      await provider.remove(sandboxId);
      await telemetry.shutdown();
    }
  }, 120_000);
});
