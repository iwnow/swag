import { z } from 'zod';
import type { NodeRegistry, NodeSchemaTarget, SettingsIssue } from '@swag/api-integration';
import {
  HostFrame,
  SandboxFrame,
  type EgressGrant,
  type NodeCall,
  type NodeInvocation,
  type NodeInvocationErrorCode,
  type NodeInvocationResult,
  type NodeKind,
  type NodeManifest,
} from '@swag/contracts';
import type {
  Clock,
  IdGenerator,
  Logger,
  NodeSandboxes,
  NodeSandboxSession,
  NodeStateStore,
  SecretReader,
  TimerId,
  Timers,
} from './index.ts';

// Спека 026, 4.10 (шаги 1–10) и 4.8 (лимиты кадров). Песочница и протокол — через порты; код узла здесь не исполняется.
const MAX_LOG_FRAMES = 200;
const MAX_LOG_MSG = 1000;
const MAX_LOG_DATA_BYTES = 8192;
const MAX_ERROR_MESSAGE = 1000;
const MAX_STATE_KEY = 200;
const MAX_STATE_VALUE = 65536;
const MAX_POLL_CURSOR = 4096;
const MIN_SECRET_LENGTH = 4;
const REDACTED = '[secret]';

// Виды вызова по виду узла (REQ-026-1).
const CALL_KINDS: Record<NodeKind, readonly NodeCall['kind'][]> = {
  trigger: ['poll'],
  channel: ['poll', 'send'],
  connector: ['operation'],
  program: ['execute'],
  'llm-agent': [],
  human: [],
};

const PollOutput = z.strictObject({
  events: z.array(z.unknown()),
  cursor: z.string().max(MAX_POLL_CURSOR).nullable(),
});

export interface NodeInvokeDeps {
  nodes: { registry: NodeRegistry; packageOf(ref: string): string | null };
  nodeSandboxes: NodeSandboxes;
  secrets: SecretReader;
  nodeState: NodeStateStore;
  egressGrants: { issue(grant: EgressGrant): string };
  node: {
    template: string;
    egressProxyUrl: string;
    timeoutMs: number;
    abortGraceMs: number;
    frameMaxBytes: number;
  };
  clock: Clock;
  ids: IdGenerator;
  timers: Timers;
  log: Logger;
}

type Failure = { code: NodeInvocationErrorCode; message: string };
type Stage<T> = { ok: true; value: T } | { ok: false; error: Failure };
type ResultFrame = Extract<SandboxFrame, { t: 'result' }>;
type Exchange =
  { kind: 'result'; frame: ResultFrame } | { kind: 'timeout' } | { kind: 'protocol_error' };
interface Prepared {
  manifest: NodeManifest;
  pkg: string;
  settings: Record<string, unknown>;
}

const fail = (code: NodeInvocationErrorCode, message: string) =>
  ({ ok: false, error: { code, message } }) as const;

function issuesText(issues: readonly SettingsIssue[]): string {
  const text = issues
    .map((issue) => (issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`))
    .join('; ');
  return text === '' ? 'значение не прошло проверку' : text;
}

// Текст ошибки реестра: список проблем схемы или код, если схемы нет.
function problem(error: { code: string; issues?: readonly SettingsIssue[] }): string {
  return error.issues ? issuesText(error.issues) : `схема не объявлена (${error.code})`;
}

function inputOf(call: NodeCall): { target: NodeSchemaTarget; value: unknown } | null {
  switch (call.kind) {
    case 'execute':
      return { target: { place: 'inputs' }, value: call.input };
    case 'operation':
      return {
        target: { place: 'operation', name: call.operation, io: 'input' },
        value: call.input,
      };
    case 'send':
      return { target: { place: 'inputs' }, value: call.message };
    case 'poll':
      return null;
  }
}

// Длина строки в байтах UTF-8 без Buffer и TextEncoder: тип TextEncoder не объявлен в lib ядра (D-167).
function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

const truncate = (text: string, max: number): string =>
  text.length > max ? text.slice(0, max) : text;

// Вымарывание (4.10, шаг 9): значения секретов, от длинного к короткому.
function redactText(text: string, values: readonly string[]): string {
  return values.reduce((acc, value) => acc.split(value).join(REDACTED), text);
}

function redactData(value: unknown, values: readonly string[]): unknown {
  if (typeof value === 'string') return redactText(value, values);
  if (Array.isArray(value)) return value.map((item) => redactData(item, values));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactText(key, values),
        redactData(item, values),
      ]),
    );
  }
  return value;
}

function parseLine(line: string, frameMaxBytes: number): SandboxFrame | null {
  if (utf8Length(line) > frameMaxBytes) return null;
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = SandboxFrame.safeParse(json);
  return parsed.success ? parsed.data : null;
}

// Сверка выхода по схемам манифеста (4.10, шаг 7).
function checkOutput(
  nodes: NodeInvokeDeps['nodes'],
  invocation: NodeInvocation,
  output: unknown,
): Stage<unknown> {
  const { type, call } = invocation;
  const validated = (target: NodeSchemaTarget, value: unknown): Stage<unknown> => {
    const checked = nodes.registry.validate(type, target, value);
    return checked.ok
      ? { ok: true, value: checked.value }
      : fail('invalid_output', problem(checked.error));
  };
  switch (call.kind) {
    case 'execute':
      return validated({ place: 'outputs' }, output);
    case 'operation':
      return validated({ place: 'operation', name: call.operation, io: 'output' }, output);
    case 'poll': {
      const shape = PollOutput.safeParse(output);
      if (!shape.success) {
        return fail('invalid_output', 'Выход poll не имеет формы { events, cursor }');
      }
      const events: unknown[] = [];
      for (const event of shape.data.events) {
        const checked = validated({ place: 'outputs' }, event);
        if (!checked.ok) return checked;
        events.push(checked.value);
      }
      return { ok: true, value: { events, cursor: shape.data.cursor } };
    }
    case 'send':
      return output === null
        ? { ok: true, value: null }
        : fail('invalid_output', 'Выход send должен быть null');
  }
}

export function createInvokeNode(
  deps: NodeInvokeDeps,
): (invocation: NodeInvocation) => Promise<NodeInvocationResult> {
  const { nodes, nodeSandboxes, nodeState, clock, ids, timers, log, node } = deps;

  // Шаг 1: проверки по реестру до песочницы (REQ-026-2).
  function prepare(invocation: NodeInvocation): Stage<Prepared> {
    const { type, call } = invocation;
    const manifest = nodes.registry.get(type);
    const pkg = nodes.packageOf(type);
    if (!manifest || pkg === null) return fail('node_type_not_found', `Тип узла ${type} не найден`);
    if (manifest.kind === 'llm-agent' || manifest.kind === 'human') {
      return fail('not_executable', `Узел вида ${manifest.kind} не исполняется песочницей`);
    }
    if (!CALL_KINDS[manifest.kind].includes(call.kind)) {
      return fail('invalid_call', `Вызов ${call.kind} не подходит виду узла ${manifest.kind}`);
    }
    if (
      call.kind === 'operation' &&
      !manifest.operations.some((op) => op.name === call.operation)
    ) {
      return fail('unknown_operation', `Операция ${call.operation} не объявлена в ${type}`);
    }
    const settings = nodes.registry.validateSettings(type, invocation.settings);
    if (!settings.ok) {
      return fail(
        'invalid_settings',
        settings.error.code === 'invalid_settings'
          ? issuesText(settings.error.issues)
          : `Тип узла ${type} не найден`,
      );
    }
    const input = inputOf(call);
    if (input) {
      const checked = nodes.registry.validate(type, input.target, input.value);
      if (!checked.ok) return fail('invalid_input', problem(checked.error));
    }
    const declared = manifest.credentials.map((credential) => credential.name).sort();
    const given = Object.keys(invocation.credentials).sort();
    if (declared.length !== given.length || declared.some((name, i) => name !== given[i])) {
      return fail('invalid_call', 'Набор credentials вызова не совпадает с манифестом');
    }
    return { ok: true, value: { manifest, pkg, settings: settings.settings } };
  }

  const stateKeyError = (key: string): string | null =>
    key.length < 1 || key.length > MAX_STATE_KEY
      ? `ключ состояния длиной 1…${MAX_STATE_KEY}`
      : null;

  async function execute(
    invocation: NodeInvocation,
    invocationId: string,
  ): Promise<Stage<unknown>> {
    const prepared = prepare(invocation);
    if (!prepared.ok) return prepared;
    const { manifest, pkg, settings } = prepared.value;

    // Шаг 1: секреты читаются до песочницы; в кадр уходят только объявленные credentials.
    const names = [...new Set(Object.values(invocation.credentials))];
    let found: Record<string, string> = {};
    try {
      found = names.length === 0 ? {} : await deps.secrets.read(invocation.orgId, names);
    } catch (error) {
      log.error('node secrets read failed', {
        invocationId,
        nodeType: invocation.type,
        orgId: invocation.orgId,
        err: error,
      });
      throw error;
    }
    const missing = names.filter((name) => !Object.hasOwn(found, name));
    if (missing.length > 0) {
      return fail('secret_missing', `Нет секретов организации: ${missing.join(', ')}`);
    }
    const secrets: Record<string, string> = {};
    for (const [credential, secretName] of Object.entries(invocation.credentials)) {
      secrets[credential] = found[secretName] ?? '';
    }
    const redactions = Object.values(secrets)
      .filter((value) => value.length >= MIN_SECRET_LENGTH)
      .sort((a, b) => b.length - a.length);

    // Шаг 9: сообщения ошибок вымарываются до обрезки, включая собранные хостом (invalid_output).
    const outcome = await runSandbox(invocation, invocationId, {
      manifest,
      pkg,
      settings,
      secrets,
      redactions,
    });
    return outcome.ok
      ? outcome
      : fail(outcome.error.code, redactText(outcome.error.message, redactions));
  }

  // Шаги 2–8: дедлайн, песочница, кадры, результат.
  async function runSandbox(
    invocation: NodeInvocation,
    invocationId: string,
    run: {
      manifest: NodeManifest;
      pkg: string;
      settings: Record<string, unknown>;
      secrets: Record<string, string>;
      redactions: readonly string[];
    },
  ): Promise<Stage<unknown>> {
    const { manifest, pkg, settings, secrets, redactions } = run;

    // Шаг 2: дедлайн и грант выхода; грант живёт до конца грейса.
    const timeoutMs = invocation.timeoutMs ?? node.timeoutMs;
    const deadline = Date.parse(clock.now()) + timeoutMs;
    const token = deps.egressGrants.issue({
      invocationId,
      egress: manifest.egress,
      expiresAt: deadline + node.abortGraceMs,
    });

    // Шаг 3: песочница с метками.
    let session: NodeSandboxSession;
    try {
      session = await nodeSandboxes.run({
        template: node.template,
        metadata: {
          'swag.kind': 'node',
          'swag.invocation': invocationId,
          'swag.org': invocation.orgId,
        },
      });
    } catch (error) {
      log.error('node sandbox create failed', { invocationId, err: error });
      return fail('sandbox_failed', 'Не удалось создать песочницу узла');
    }

    const invoke: HostFrame = {
      t: 'invoke',
      invocationId,
      package: pkg,
      definition: { type: manifest.type, version: manifest.version },
      call: invocation.call,
      settings,
      secrets,
      egressProxy: { url: node.egressProxyUrl, token },
      deadline,
    };
    const ctx = {
      invocationId,
      nodeType: invocation.type,
      orgId: invocation.orgId,
      stateKey: invocation.stateKey,
      redactions,
      deadline,
    };
    let exchange: Exchange;
    try {
      exchange = await converse(session, invoke, ctx);
    } finally {
      try {
        await nodeSandboxes.remove(session.sandboxId);
      } catch (error) {
        log.warn('sandbox remove failed', { invocationId, err: error });
      }
    }

    // Шаг 7: результат песочницы.
    if (exchange.kind === 'timeout') return fail('timeout', 'Вызов узла превысил таймаут');
    if (exchange.kind === 'protocol_error') {
      return fail('protocol_error', 'Песочница узла нарушила протокол');
    }
    const { frame } = exchange;
    if (!frame.ok) return fail(frame.code, frame.message);
    return checkOutput(nodes, invocation, frame.output);
  }

  // Шаги 4–6: кадр invoke, чтение кадров; в deadline — abort, затем грейс, затем timeout.
  async function converse(
    session: NodeSandboxSession,
    invoke: HostFrame,
    ctx: {
      invocationId: string;
      nodeType: string;
      orgId: string;
      stateKey: string;
      redactions: readonly string[];
      deadline: number;
    },
  ): Promise<Exchange> {
    const send = (frame: HostFrame): void => session.write(JSON.stringify(frame));
    const context = { invocationId: ctx.invocationId, nodeType: ctx.nodeType, orgId: ctx.orgId };
    let logFrames = 0;
    let logLimitWarned = false;

    async function handle(frame: Exclude<SandboxFrame, { t: 'result' }>): Promise<void> {
      if (frame.t === 'log') {
        if (logFrames >= MAX_LOG_FRAMES) {
          if (!logLimitWarned) {
            logLimitWarned = true;
            log.warn('node log limit', context);
          }
          return;
        }
        logFrames += 1;
        const msg = truncate(redactText(frame.msg, ctx.redactions), MAX_LOG_MSG);
        const data = frame.data === undefined ? undefined : redactData(frame.data, ctx.redactions);
        const dataTooBig =
          data !== undefined && utf8Length(JSON.stringify(data)) > MAX_LOG_DATA_BYTES;
        log[frame.level]('node log', {
          ...context,
          msg,
          ...(data === undefined ? {} : { data: dataTooBig ? { truncated: true } : data }),
        });
        return;
      }
      if (frame.t === 'state.get') {
        const error = stateKeyError(frame.key);
        if (error) {
          log.warn('node state rejected', { ...context, reason: error });
          send({ t: 'state', id: frame.id, error });
          return;
        }
        try {
          const value = await nodeState.get(ctx.orgId, ctx.stateKey, frame.key);
          send({ t: 'state', id: frame.id, value });
        } catch (err) {
          log.error('node state get failed', { ...context, err });
          send({ t: 'state', id: frame.id, error: 'state unavailable' });
        }
        return;
      }
      // state.set: лимиты ключа и значения (4.5); null — удалить ключ.
      const error =
        stateKeyError(frame.key) ??
        (frame.value !== null && frame.value.length > MAX_STATE_VALUE
          ? `значение состояния не длиннее ${MAX_STATE_VALUE} символов`
          : null);
      if (error) {
        log.warn('node state rejected', { ...context, reason: error });
        send({ t: 'state', id: frame.id, error });
        return;
      }
      try {
        await nodeState.set(ctx.orgId, ctx.stateKey, frame.key, frame.value, new Date(clock.now()));
        send({ t: 'state', id: frame.id, value: null });
      } catch (err) {
        log.error('node state set failed', { ...context, err });
        send({ t: 'state', id: frame.id, error: 'state unavailable' });
      }
    }

    return new Promise<Exchange>((resolve) => {
      let settled = false;
      let deadlineTimer: TimerId | null = null;
      let graceTimer: TimerId | null = null;
      const settle = (outcome: Exchange): void => {
        if (settled) return;
        settled = true;
        if (deadlineTimer !== null) timers.clearTimeout(deadlineTimer);
        if (graceTimer !== null) timers.clearTimeout(graceTimer);
        resolve(outcome);
      };

      const pump = async (): Promise<void> => {
        for await (const line of session.lines) {
          if (settled) return;
          const frame = parseLine(line, node.frameMaxBytes);
          if (frame === null) return settle({ kind: 'protocol_error' });
          if (frame.t === 'result') return settle({ kind: 'result', frame });
          await handle(frame);
        }
        settle({ kind: 'protocol_error' });
      };

      try {
        send(invoke);
      } catch {
        settle({ kind: 'protocol_error' });
        return;
      }
      deadlineTimer = timers.setTimeout(
        () => {
          try {
            send({ t: 'abort' });
          } catch (err) {
            log.warn('node abort send failed', { ...context, err });
          }
          graceTimer = timers.setTimeout(() => settle({ kind: 'timeout' }), node.abortGraceMs);
        },
        Math.max(0, ctx.deadline - Date.parse(clock.now())),
      );
      pump().catch(() => settle({ kind: 'protocol_error' }));
    });
  }

  return async function invokeNode(invocation) {
    const invocationId = ids.uuid();
    const startedAt = Date.parse(clock.now());
    const elapsed = (): number => Math.max(0, Date.parse(clock.now()) - startedAt);
    let result: NodeInvocationResult | null = null;
    try {
      const outcome = await execute(invocation, invocationId);
      result = outcome.ok
        ? { ok: true, output: outcome.value, durationMs: elapsed() }
        : {
            ok: false,
            error: {
              code: outcome.error.code,
              message: truncate(outcome.error.message, MAX_ERROR_MESSAGE),
            },
            durationMs: elapsed(),
          };
      return result;
    } finally {
      // Лог пишется и при исключении (сбой секретов, D-168): ok:false, code null.
      log.info('node invoke', {
        invocationId,
        nodeType: invocation.type,
        orgId: invocation.orgId,
        callKind: invocation.call.kind,
        ok: result?.ok ?? false,
        code: result && !result.ok ? result.error.code : null,
        durationMs: result?.durationMs ?? elapsed(),
      });
    }
  };
}
