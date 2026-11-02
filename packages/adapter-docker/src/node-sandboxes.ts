import { PassThrough, type Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import Docker from 'dockerode';
import { context, propagation } from '@opentelemetry/api';
import type { NodeSandboxes, NodeSandboxSpec } from '@swag/orchestrator-core';

// Спека 026, 4.9: песочница одного вызова узла. Код узла в ней без секретов в env, без монтирований и портов.
export interface DockerNodeSandboxOptions {
  network: string; // DOCKER_NODE_NETWORK — сеть без выхода наружу
  maxLineBytes: number; // NODE_FRAME_MAX_BYTES — предел строки stdout и stderr (D-172)
  docker?: Docker; // по умолчанию — локальный сокет / pipe
  log?: { debug(msg: string, ctx?: object): void }; // stderr песочницы — в лог debug (D-166)
}

const NODE_USER = 'node';
const MEMORY_BYTES = 268435456; // 256 МиБ
const NANO_CPUS = 500000000; // 0,5 CPU
const PIDS_LIMIT = 64;
const TMPFS_TMP = 'rw,size=64m';
const STDERR_LINE_MAX = 1000; // как msg лога в 4.8
// Строка-маркер не JSON: ядро на ней даст protocol_error (D-172).
const OVERSIZE_LINE = '<строка длиннее лимита кадра>';

// Строки потока по \n (D-172): только \n, UTF-8 через StringDecoder, неполная последняя строка отдаётся в конце.
// Строка длиннее maxLineBytes отдаётся маркером, её остаток до \n отбрасывается без накопления.
async function* splitLines(
  input: AsyncIterable<Buffer>,
  maxLineBytes: number,
): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let line = '';
  let bytes = 0;
  let overflow = false;
  const take = (piece: string): void => {
    if (overflow || piece === '') return;
    bytes += Buffer.byteLength(piece, 'utf8');
    if (bytes > maxLineBytes) {
      overflow = true;
      line = '';
    } else {
      line += piece;
    }
  };
  const flush = (): string => {
    const out = overflow ? OVERSIZE_LINE : line;
    line = '';
    bytes = 0;
    overflow = false;
    return out;
  };
  for await (const chunk of input) {
    const [head = '', ...tail] = decoder.write(chunk).split('\n');
    take(head);
    for (const piece of tail) {
      yield flush();
      take(piece);
    }
  }
  take(decoder.end());
  if (overflow || line !== '') yield flush();
}

export function createDockerNodeSandboxes(options: DockerNodeSandboxOptions): NodeSandboxes {
  const docker = options.docker ?? new Docker();

  async function drainStderr(stderr: PassThrough): Promise<void> {
    for await (const line of splitLines(stderr, options.maxLineBytes)) {
      options.log?.debug('node sandbox stderr', { line: line.slice(0, STDERR_LINE_MAX) });
    }
  }

  return {
    async run(spec: NodeSandboxSpec) {
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

      let attached: Duplex | undefined;
      try {
        // Подключение до старта: вывод процесса с первой строки не теряется.
        const stream = (await container.attach({
          stream: true,
          stdin: true,
          stdout: true,
          stderr: true,
          hijack: true,
        })) as Duplex;
        attached = stream;
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        docker.modem.demuxStream(stream, stdout, stderr);
        // demuxStream не закрывает выходы сам: конец, закрытие или ошибка attach — конец lines (выход процесса).
        const closeOutputs = (): void => {
          if (!stdout.writableEnded) stdout.end();
          if (!stderr.writableEnded) stderr.end();
        };
        stream.on('end', closeOutputs).on('close', closeOutputs).on('error', closeOutputs);
        void drainStderr(stderr);

        await container.start();

        return {
          sandboxId: container.id,
          write: (line) => {
            stream.write(`${line}\n`);
          },
          lines: splitLines(stdout, options.maxLineBytes),
        };
      } catch (error) {
        attached?.destroy();
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
