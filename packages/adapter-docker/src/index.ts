import Docker from 'dockerode';
import type { SandboxProvider, SandboxSpec } from '@swag/orchestrator-core';

// Спека 001, 4.6.3: SandboxProvider на Docker. template → образ, metadata → метки, env + NATS_URL.
// Без монтирований, публикации портов и привилегий. Ограничения ресурсов — спека 005.
export interface DockerSandboxOptions {
  network: string; // DOCKER_AGENT_NETWORK — сеть compose
  natsUrl: string; // DOCKER_AGENT_NATS_URL — адрес NATS изнутри контейнера агента
  docker?: Docker; // по умолчанию — локальный сокет / pipe
}

interface DockerError {
  statusCode?: number;
}

export function createDockerSandboxProvider(options: DockerSandboxOptions): SandboxProvider {
  const docker = options.docker ?? new Docker();

  return {
    async create(spec: SandboxSpec) {
      const env = [
        ...Object.entries(spec.env).map(([key, value]) => `${key}=${value}`),
        `NATS_URL=${options.natsUrl}`,
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
      await container.start();
      return { sandboxId: container.id };
    },

    async remove(sandboxId: string) {
      try {
        await docker.getContainer(sandboxId).remove({ force: true });
      } catch (error) {
        if ((error as DockerError).statusCode === 404) return; // нет такой — не ошибка
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
