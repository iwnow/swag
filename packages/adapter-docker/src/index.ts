import Docker from 'dockerode';
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
} from '@opentelemetry/api';
import type { SandboxProvider, SandboxSpec } from '@swag/orchestrator-core';

// Спека 001, 4.6.3: SandboxProvider на Docker. template → образ, metadata → метки, env + NATS_URL.
// Без монтирований, публикации портов и привилегий. Ограничения ресурсов — спека 005.
// Спека 016, 4.7: в env песочницы — TRACEPARENT и OTEL_EXPORTER_OTLP_ENDPOINT, спаны sandbox.create и sandbox.remove.
export interface DockerSandboxOptions {
  network: string; // DOCKER_AGENT_NETWORK — сеть compose
  natsUrl: string; // DOCKER_AGENT_NATS_URL — адрес NATS изнутри контейнера агента
  otlpEndpoint?: string | null; // DOCKER_AGENT_OTLP_ENDPOINT — адрес Collector изнутри песочницы; null — без экспорта
  docker?: Docker; // по умолчанию — локальный сокет / pipe
}

interface DockerError {
  statusCode?: number;
}

const TRACER = '@swag/adapter-docker';
// Грейс остановки: больше TELEMETRY_FLUSH_TIMEOUT_MS агента по умолчанию (2 с), потом Docker шлёт SIGKILL.
const STOP_GRACE_SECONDS = 5;

// Спан операции песочницы: ошибка — статус ERROR, исключение пробрасывается.
async function inSpan<T>(
  name: string,
  attributes: Record<string, string>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return trace
    .getTracer(TRACER)
    .startActiveSpan(name, { kind: SpanKind.CLIENT, attributes }, async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
}

export function createDockerSandboxProvider(options: DockerSandboxOptions): SandboxProvider {
  const docker = options.docker ?? new Docker();
  // swarm.id и agent.id созданных песочниц — для атрибутов sandbox.remove (у сирот их нет).
  const known = new Map<string, Record<string, string>>();

  return {
    async create(spec: SandboxSpec) {
      const attributes: Record<string, string> = {};
      if (spec.metadata['swag.swarm']) attributes['swarm.id'] = spec.metadata['swag.swarm'];
      if (spec.metadata['swag.agent']) attributes['agent.id'] = spec.metadata['swag.agent'];

      return inSpan('sandbox.create', attributes, async (span) => {
        // Контекст на момент create: родитель старта агента — этот спан (REQ-016-14: только он и адрес Collector).
        const carrier: Record<string, string> = {};
        propagation.inject(context.active(), carrier);
        const env = [
          ...Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
          `NATS_URL=${options.natsUrl}`,
          `TRACEPARENT=${carrier['traceparent'] ?? ''}`,
          `OTEL_EXPORTER_OTLP_ENDPOINT=${options.otlpEndpoint ?? ''}`,
        ];
        const container = await docker.createContainer({
          Image: spec.template,
          Env: env,
          Labels: spec.metadata,
          HostConfig: {
            NetworkMode: options.network,
            Privileged: false,
            Binds: [],
            PortBindings: {},
          },
        });
        span.setAttribute('sandbox.id', container.id);
        known.set(container.id, attributes);
        await container.start();
        return { sandboxId: container.id };
      });
    },

    async remove(sandboxId: string) {
      const attributes = { ...known.get(sandboxId), 'sandbox.id': sandboxId };
      await inSpan('sandbox.remove', attributes, async () => {
        const container = docker.getContainer(sandboxId);
        try {
          // Сначала SIGTERM с грейсом: агент закрывает NATS и сбрасывает телеметрию (REQ-001-17, REQ-016-8),
          // иначе force-удаление (SIGKILL) теряет его последние спаны и логи. 304 — уже остановлен.
          await container.stop({ t: STOP_GRACE_SECONDS });
        } catch (error) {
          const status = (error as DockerError).statusCode;
          if (status === 404) return; // нет такой — не ошибка
          if (status !== 304) throw error;
        }
        try {
          await container.remove({ force: true });
        } catch (error) {
          if ((error as DockerError).statusCode === 404) return;
          throw error;
        }
      });
      known.delete(sandboxId);
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
