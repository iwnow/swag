import type { EgressHost } from '@swag/contracts';
import { z } from 'zod';
import {
  NodeError,
  type ChannelDefinition,
  type ConnectorDefinition,
  type NodeContext,
  type NodeDefinition,
  type NodeErrorCode,
  type PollResult,
  type ProgramDefinition,
  type SettingsOf,
  type TriggerDefinition,
} from './index.ts';

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

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<корень>'}: ${issue.message}`)
    .join('; ');
}

function check<T>(code: NodeErrorCode, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new NodeError(code, describeIssues(parsed.error));
  return parsed.data;
}

// Правило 4.3: протокол https, хост и порт сверяются с записями egress.
function egressAllows(url: URL, rules: readonly EgressHost[]): boolean {
  if (url.protocol !== 'https:') return false;
  return rules.some((rule) => {
    const colon = rule.indexOf(':');
    const host = colon < 0 ? rule : rule.slice(0, colon);
    const port = colon < 0 ? '' : rule.slice(colon + 1);
    if (url.port !== port) return false;
    if (host.startsWith('*.')) return url.hostname.endsWith(host.slice(1));
    return url.hostname === host;
  });
}

export function createTestContext<D extends NodeDefinition>(
  definition: D,
  options: TestContextOptions,
): TestContext<SettingsOf<D>> {
  const settings = check<SettingsOf<D>>('invalid_settings', definition.settings, options.settings);
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
        if (!egressAllows(target, egress)) {
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
  const parsed = check('invalid_input', definition.inputs, input);
  const output = await definition.execute(parsed, ctx);
  return check('invalid_output', definition.outputs, output);
}

export async function runOperation<S extends Settings>(
  definition: ConnectorDefinition<S>,
  name: string,
  ctx: TestContext<z.output<S>>,
  input: unknown,
): Promise<unknown> {
  const operation = Object.hasOwn(definition.operations, name)
    ? definition.operations[name]
    : undefined;
  if (!operation) throw new NodeError('unknown_operation', `операция ${name} не объявлена`);
  const parsed = check('invalid_input', operation.input, input);
  const output = await operation.execute(parsed, ctx);
  return check('invalid_output', operation.output, output);
}

export async function runPoll<S extends Settings, E>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- исходящий тип канала не нужен для poll, 021 4.3
  definition: TriggerDefinition<S, E> | ChannelDefinition<S, E, any>,
  ctx: TestContext<z.output<S>>,
  cursor: string | null,
): Promise<PollResult<E>> {
  const result = await definition.poll(cursor, ctx);
  const events = result.events.map((event) => check('invalid_output', definition.outputs, event));
  return { events, cursor: result.cursor };
}

export async function runSend<S extends Settings, In, Out>(
  definition: ChannelDefinition<S, In, Out>,
  ctx: TestContext<z.output<S>>,
  message: unknown,
): Promise<void> {
  const parsed = check('invalid_input', definition.inputs, message);
  await definition.send(parsed, ctx);
}
