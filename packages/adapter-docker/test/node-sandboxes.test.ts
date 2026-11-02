import Docker from 'dockerode';
import { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createDockerNodeSandboxes } from '../src/index.ts';

// Фейковый dockerode: контейнер пишет вызовы в журнал, stdout/stderr — кадры Docker (8-байтный заголовок).
const realModem = new Docker().modem;

function frame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

interface Fake {
  docker: Docker;
  calls: string[];
  createOptions: Record<string, unknown>[];
  attachOptions: Record<string, unknown>[];
  removeOptions: Record<string, unknown>[];
  written: string[];
  output: Duplex;
}

function fakeDocker(): Fake {
  const calls: string[] = [];
  const createOptions: Record<string, unknown>[] = [];
  const attachOptions: Record<string, unknown>[] = [];
  const removeOptions: Record<string, unknown>[] = [];
  const written: string[] = [];
  const output = new Duplex({
    read() {
      /* данные кладёт тест через push */
    },
    write(chunk: Buffer, _encoding, callback) {
      written.push(chunk.toString('utf8'));
      callback();
    },
  });
  const container = {
    id: 'nc-1',
    attach: async (options: Record<string, unknown>) => {
      calls.push('attach');
      attachOptions.push(options);
      return output;
    },
    start: async () => {
      calls.push('start');
    },
    remove: async (options: Record<string, unknown>) => {
      calls.push('remove');
      removeOptions.push(options);
    },
  };
  const docker = {
    modem: realModem,
    createContainer: async (options: Record<string, unknown>) => {
      calls.push('create');
      createOptions.push(options);
      return container;
    },
    getContainer: (id: string) => ({
      remove: async (options: Record<string, unknown>) => {
        if (id !== 'nc-1') throw Object.assign(new Error('no such container'), { statusCode: 404 });
        calls.push('remove');
        removeOptions.push(options);
      },
    }),
    listContainers: async () => [{ Id: 'nc-1' }],
  } as unknown as Docker;
  return { docker, calls, createOptions, attachOptions, removeOptions, written, output };
}

const SPEC = {
  template: 'swag-node-host:dev',
  metadata: { 'swag.kind': 'node', 'swag.invocation': 'inv-1', 'swag.org': 'org-1' },
};

describe('createDockerNodeSandboxes', () => {
  it('AC-026-19: createContainer получает поля 4.9, без Binds, PortBindings и секретов в env; attach раньше start', async () => {
    const fake = fakeDocker();
    const sandboxes = createDockerNodeSandboxes({ network: 'swag-nodes', docker: fake.docker });
    const session = await sandboxes.run(SPEC);
    fake.output.push(null);
    expect(session.sandboxId).toBe('nc-1');

    expect(fake.calls).toEqual(['create', 'attach', 'start']);
    const options = fake.createOptions[0]!;
    expect(options).toMatchObject({
      Image: 'swag-node-host:dev',
      Labels: SPEC.metadata,
      User: 'node',
      OpenStdin: true,
      StdinOnce: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      HostConfig: {
        NetworkMode: 'swag-nodes',
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,size=64m' },
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Memory: 268435456,
        NanoCpus: 500000000,
        PidsLimit: 64,
      },
    });
    const env = options['Env'] as string[];
    expect(env.every((entry) => entry.startsWith('TRACEPARENT='))).toBe(true);
    expect(
      env.filter((entry) => /NATS_URL|LLM_GATEWAY_URL|OTEL_|SECRET|KEY|TOKEN/.test(entry)),
    ).toEqual([]);
    const hostConfig = options['HostConfig'] as Record<string, unknown>;
    expect(hostConfig).not.toHaveProperty('Binds');
    expect(hostConfig).not.toHaveProperty('PortBindings');
    expect(fake.attachOptions[0]).toMatchObject({
      stream: true,
      stdin: true,
      stdout: true,
      stderr: true,
      hijack: true,
    });
  });

  it('AC-026-19: stdout разбит по строкам, stderr не попадает в lines, write добавляет перевод строки', async () => {
    const fake = fakeDocker();
    const debug: string[] = [];
    const sandboxes = createDockerNodeSandboxes({
      network: 'swag-nodes',
      docker: fake.docker,
      log: { debug: (msg) => debug.push(msg) },
    });
    const session = await sandboxes.run(SPEC);
    fake.output.push(frame(1, 'hel'));
    fake.output.push(frame(2, 'warn line\n'));
    fake.output.push(frame(1, 'lo\n'));
    fake.output.push(frame(1, 'тест\n'));
    fake.output.push(null);

    const lines: string[] = [];
    for await (const line of session.lines) lines.push(line);
    expect(lines).toEqual(['hello', 'тест']);
    expect(debug).toEqual(['node sandbox stderr']);

    session.write('{"t":"abort"}');
    expect(fake.written).toEqual(['{"t":"abort"}\n']);
  });

  it('AC-026-19: неполная последняя строка stdout отдаётся при конце потока', async () => {
    const fake = fakeDocker();
    const sandboxes = createDockerNodeSandboxes({ network: 'swag-nodes', docker: fake.docker });
    const session = await sandboxes.run(SPEC);
    fake.output.push(frame(1, 'last'));
    fake.output.push(null);
    const lines: string[] = [];
    for await (const line of session.lines) lines.push(line);
    expect(lines).toEqual(['last']);
  });

  it('AC-026-19: remove удаляет с force; повторное удаление — не ошибка', async () => {
    const fake = fakeDocker();
    const sandboxes = createDockerNodeSandboxes({ network: 'swag-nodes', docker: fake.docker });
    await sandboxes.remove('nc-1');
    expect(fake.removeOptions).toEqual([{ force: true }]);
    await expect(sandboxes.remove('nc-missing')).resolves.toBeUndefined();
  });

  it('AC-026-19: list ищет по меткам; true — только наличие ключа', async () => {
    const fake = fakeDocker();
    const sandboxes = createDockerNodeSandboxes({ network: 'swag-nodes', docker: fake.docker });
    expect(await sandboxes.list({ 'swag.kind': 'node', 'swag.org': true })).toEqual(['nc-1']);
  });
});
