import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import Docker from 'dockerode';
import { context, propagation } from '@opentelemetry/api';
import type { NodeSandboxes, NodeSandboxSession, NodeSandboxSpec } from '@swag/orchestrator-core';

// Спека 026, 4.9: песочница одного вызова узла. Код узла в ней без секретов в env, без монтирований и портов.
export interface DockerNodeSandboxOptions {
  network: string; // DOCKER_NODE_NETWORK — сеть без выхода наружу
  docker?: Docker; // по умолчанию — локальный сокет / pipe
  log?: { debug(msg: string, ctx?: object): void }; // stderr песочницы — в лог debug (D-166)
}

const NODE_USER = 'node';
const MEMORY_BYTES = 268435456; // 256 МиБ
const NANO_CPUS = 500000000; // 0,5 CPU
const PIDS_LIMIT = 64;
const TMPFS_TMP = 'rw,size=64m';

export function createDockerNodeSandboxes(options: DockerNodeSandboxOptions): NodeSandboxes {
  const docker = options.docker ?? new Docker();

  return {
    async run(spec: NodeSandboxSpec): Promise<NodeSandboxSession> {
      // TRACEPARENT — как у песочниц агентов: контекст трассировки на момент создания. Других env нет.
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      const container = await docker.createContainer({
        Image: spec.template,
        Env: [`TRACEPARENT=${carrier['traceparent'] ?? ''}`],
        Labels: spec.metadata,
        User: NODE_USER,
        OpenStdin: true,
        StdinOnce: false,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        HostConfig: {
          NetworkMode: options.network,
          ReadonlyRootfs: true,
          Tmpfs: { '/tmp': TMPFS_TMP },
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          Memory: MEMORY_BYTES,
          NanoCpus: NANO_CPUS,
          PidsLimit: PIDS_LIMIT,
        },
      });

      try {
        // Подключение до старта: вывод процесса с первой строки не теряется.
        const stream = await container.attach({
          stream: true,
          stdin: true,
          stdout: true,
          stderr: true,
          hijack: true,
        });
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        stdout.setEncoding('utf8');
        stderr.setEncoding('utf8');
        docker.modem.demuxStream(stream, stdout, stderr);
        // demuxStream не закрывает выходы сам: конец потока attach — конец lines (выход процесса).
        stream.on('end', () => {
          stdout.end();
          stderr.end();
        });
        stderr.on('data', (chunk: string) => options.log?.debug('node sandbox stderr', { chunk }));
        // Ошибка записи в stdin проявится концом потока lines (protocol_error у ядра), не падением процесса.
        stream.on('error', () => undefined);

        await container.start();

        return {
          sandboxId: container.id,
          write: (line) => {
            stream.write(`${line}\n`);
          },
          lines: createInterface({ input: stdout, crlfDelay: Infinity }),
        };
      } catch (error) {
        await container.remove({ force: true }).catch(() => undefined);
        throw error;
      }
    },

    async remove(sandboxId: string) {
      try {
        await docker.getContainer(sandboxId).remove({ force: true });
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 404) return; // нет такой — не ошибка
        throw error;
      }
    },

    async list(match: Record<string, string | true>) {
      const labels = Object.entries(match).map(([key, value]) =>
        value === true ? key : `${key}=${value}`,
      );
      const containers = await docker.listContainers({ all: true, filters: { label: labels } });
      return containers.map((container) => container.Id);
    },
  };
}
