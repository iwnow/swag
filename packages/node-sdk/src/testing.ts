import { egressMatches, type EgressHost } from '@swag/contracts';
import { z } from 'zod';
import {
  NodeError,
  type ChannelDefinition,
  type ConnectorDefinition,
  type NodeContext,
  type NodeDefinition,
  type PollResult,
  type ProgramDefinition,
  type SettingsOf,
  type TriggerDefinition,
} from './index.ts';
import { invokeNode, parseSettings } from './runtime.ts';

// Спека 021, 4.3, REQ-021-9. Обвязка разработчика узла: принуждение на платформе — спека 026.
type Settings = z.ZodObject;

export interface TestContextOptions {
  settings: unknown; // проверяется схемой definition.settings → NodeError('invalid_settings')
  secrets?: Record<string, string>;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>; // по умолчанию — 501 без сети
  state?: Record<string, string>;
}

export interface TestContext<S> extends NodeContext<S> {
  logs: { level: 'debug' | 'info' | 'warn' | 'error'; msg: string; data?: object }[];
  stateSnapshot(): Record<string, string>;
}

export function createTestContext<D extends NodeDefinition>(
  definition: D,
  options: TestContextOptions,
): TestContext<SettingsOf<D>> {
  const settings = parseSettings(definition, options.settings) as SettingsOf<D>;
  const declared = new Set<string>((definition.credentials ?? []).map((c) => c.name));
  const secrets = options.secrets ?? {};
  const egress: readonly EgressHost[] = definition.egress ?? [];
  const state = new Map(Object.entries(options.state ?? {}));
  const logs: TestContext<SettingsOf<D>>['logs'] = [];

  const write =
    (level: TestContext<SettingsOf<D>>['logs'][number]['level']) =>
    (msg: string, data?: object) => {
      logs.push(data === undefined ? { level, msg } : { level, msg, data });
    };

  return {
    settings,
    secrets: {
      async get(name) {
        const value = Object.hasOwn(secrets, name) ? secrets[name] : undefined;
        if (!declared.has(name) || value === undefined) {
          throw new NodeError('secret_not_declared', `секрет ${name} не объявлен или не передан`);
        }
        return value;
      },
    },
    http: {
      async fetch(url, init) {
        let target: URL;
        try {
          target = new URL(url);
        } catch {
          throw new NodeError('egress_denied', `адрес не разбирается: ${url}`);
        }
        // Спека 021, 4.3 и 026, 4.1: только https к хостам egress; пустой порт — 443.
        const port = target.port === '' ? 443 : Number(target.port);
        if (target.protocol !== 'https:' || !egressMatches(egress, target.hostname, port)) {
          throw new NodeError('egress_denied', `адрес вне egress: ${url}`);
        }
        return options.fetch ? options.fetch(url, init) : new Response(null, { status: 501 });
      },
    },
    log: {
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
    },
    state: {
      async get(key) {
        return state.get(key) ?? null;
      },
      async set(key, value) {
        if (value === null) state.delete(key);
        else state.set(key, value);
      },
    },
    signal: new AbortController().signal,
    logs,
    stateSnapshot: () => Object.fromEntries(state),
  };
}

export async function runNode<S extends Settings, I, O>(
  definition: ProgramDefinition<S, I, O>,
  ctx: TestContext<z.output<S>>,
  input: unknown,
): Promise<O> {
  return (await invokeNode(definition, { kind: 'execute', input }, ctx)) as O;
}

export async function runOperation<S extends Settings>(
  definition: ConnectorDefinition<S>,
  name: string,
  ctx: TestContext<z.output<S>>,
  input: unknown,
): Promise<unknown> {
  return invokeNode(definition, { kind: 'operation', operation: name, input }, ctx);
}

export async function runPoll<S extends Settings, E>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- исходящий тип канала не нужен для poll, 021 4.3
  definition: TriggerDefinition<S, E> | ChannelDefinition<S, E, any>,
  ctx: TestContext<z.output<S>>,
  cursor: string | null,
): Promise<PollResult<E>> {
  return (await invokeNode(definition, { kind: 'poll', cursor }, ctx)) as PollResult<E>;
}

export async function runSend<S extends Settings, In, Out>(
  definition: ChannelDefinition<S, In, Out>,
  ctx: TestContext<z.output<S>>,
  message: unknown,
): Promise<void> {
  await invokeNode(definition, { kind: 'send', message }, ctx);
}
