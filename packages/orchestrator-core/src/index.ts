import {
  BusMessage,
  PlatformEventInput,
  SwarmLaunch,
  type LaunchProgram,
  type LlmSwarmRegistration,
  type AgentId,
  type AgentSpec,
  type NodeId,
  type NodeInvocation,
  type NodeInvocationResult,
  type ServiceInfo,
} from '@swag/contracts';
import { graphPlan, valueText, type GraphPlan } from '@swag/api-integration';
import { createInvokeNode, type NodeInvokeDeps } from './node-invoke.ts';

// Спека 001, 4.6.2 и 4.6.3. Порты объявляет ядро; адаптеры передаёт оболочка.
// Спека 009, 4.6: исполнение графа процесса.

export type TimerId = unknown;

export interface Clock {
  now(): string;
}
export interface IdGenerator {
  uuid(): string;
}
// Спека 016, 4.3. Контекст лога — только id, числа и перечисления (REQ-016-10); err адаптер превращает в LogError.
export type LogContext = {
  swarmId?: string;
  agentId?: string;
  err?: unknown;
  [key: string]: unknown;
};
export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
}

/** Текущий контекст трассировки. Ядро кладёт значение в конверт события, не разбирая его. */
export interface TraceContext {
  currentTraceId(): string | null; // null — вне трейса
}
export interface Timers {
  setTimeout(fn: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId): void;
}

export interface SandboxSpec {
  template: string; // окружение агента в терминах провайдера: тег образа Docker, rootfs microVM, шаблон E2B
  env: Record<string, string>; // 4.7.1 без NATS_URL — его добавляет адаптер
  metadata: Record<string, string>; // ключ-значение для поиска песочниц роя и сирот
}

export interface SandboxProvider {
  create(spec: SandboxSpec): Promise<{ sandboxId: string }>; // создаёт и запускает
  remove(sandboxId: string): Promise<void>; // остановить и удалить; нет такой — не ошибка
  list(match: Record<string, string | true>): Promise<string[]>; // id песочниц; true — ключ есть с любым значением
}

// Спека 004, 4.6: регистрация роя в gateway. register — исключение при отказе; close — после уборки песочниц.
// Спека 013, 4.6: close отдаёт spentMicroUsd из ответа gateway; null — gateway ответил 404 (рой не зарегистрирован).
export interface LlmSwarms {
  register(reg: LlmSwarmRegistration): Promise<void>;
  close(swarmId: string): Promise<number | null>;
}

export interface OrchestratorBus {
  publishEvent(event: PlatformEventInput): Promise<void>;
  publishMessage(message: BusMessage): Promise<void>;
  // подписку на swarm.*.events оболочка делает сама и передаёт события в core.handleEvent
}

// Спека 026, 4.10. Секреты организации для вызова узла: только имена из credentials; значения живут в памяти вызова.
export interface SecretReader {
  read(orgId: string, names: readonly string[]): Promise<Record<string, string>>; // отдаёт только найденные имена
}

// Спека 026, 4.5, 4.10. Состояние узла по (orgId, stateKey, key); value null — удалить ключ.
export interface NodeStateStore {
  get(orgId: string, stateKey: string, key: string): Promise<string | null>;
  set(orgId: string, stateKey: string, key: string, value: string | null, now: Date): Promise<void>;
}

// Спека 026, 4.9. Песочница одного вызова узла: stdin/stdout строками JSON, без env с секретами.
export interface NodeSandboxSpec {
  template: string; // NODE_TEMPLATE
  metadata: Record<string, string>; // swag.kind=node, swag.invocation, swag.org
}
export interface NodeSandboxSession {
  sandboxId: string;
  write(line: string): void; // добавляет "\n"
  lines: AsyncIterable<string>; // stdout построчно; заканчивается с выходом процесса
}
export interface NodeSandboxes {
  run(spec: NodeSandboxSpec): Promise<NodeSandboxSession>; // создаёт, подключает stdio, запускает
  remove(sandboxId: string): Promise<void>; // нет такой — не ошибка
  list(match: Record<string, string | true>): Promise<string[]>;
}

// Спека 026, 4.10: порты вызова узла — NodeInvokeDeps; остальные зависимости ядра — ниже.
export interface OrchestratorCoreDeps extends NodeInvokeDeps {
  version: string; // передаёт оболочка: ядро не читает package.json
  sandboxes: SandboxProvider;
  bus: OrchestratorBus;
  clock: Clock;
  timers: Timers;
  ids: IdGenerator;
  log: Logger;
  trace: TraceContext;
  llmSwarms: LlmSwarms;
  // Значения env 4.8, которые ставит ядро. NATS_URL, OTEL_EXPORTER_OTLP_ENDPOINT, LLM_GATEWAY_URL — дело адаптера.
  agent: {
    template: string;
    maxSteps: number;
    maxTokens: number;
    llmGatewayToken: string;
    flushTimeoutMs: number;
  };
  timeouts: { agentStartMs: number; swarmMs: number };
}

export interface OrchestratorError {
  code: string;
  message: string;
  issues?: { path: string; message: string }[];
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: OrchestratorError };

export interface OrchestratorCore {
  info(): ServiceInfo;
  launch(body: unknown): Promise<Result<void>>;
  stop(swarmId: string): Promise<Result<void>>;
  handleEvent(raw: unknown): Promise<void>; // реагирует на agent.started, agent.result и agent.failed
  cleanupOrphans(): Promise<number>; // число удалённых песочниц
  // Спека 026, 4.10: один вызов узла; всегда результат, не исключение (кроме сбоя хранилища секретов).
  invokeNode(invocation: NodeInvocation): Promise<NodeInvocationResult>;
}

type Phase = 'creating' | 'waiting' | 'running' | 'finished';

interface Run {
  launch: SwarmLaunch;
  plan: GraphPlan;
  programs: Map<NodeId, LaunchProgram>;
  phase: Phase;
  begun: boolean; // swarm.started опубликован (4.6, шаг 2)
  sandboxes: Map<AgentId, string>; // agentId → sandboxId
  stopped: Set<AgentId>; // агенты, по которым уже опубликован agent.stopped
  started: Set<AgentId>;
  running: Set<NodeId>; // шаги, получившие вход и не давшие выход (id шага: программа или агент-вход команды)
  exit: { value: unknown } | null; // выход шага-выхода; null — ещё не получен
  timers: TimerId[];
}

type Outcome =
  | { type: 'swarm.completed'; data: { result: string } }
  | { type: 'swarm.stopped'; data: { reason: 'user' } }
  | {
      type: 'swarm.failed';
      data: {
        reason:
          | 'agent_start_timeout'
          | 'swarm_timeout'
          | 'sandbox_error'
          | 'agent_failed'
          | 'budget_exceeded'
          | 'gateway_unavailable'
          | 'node_failed';
        detail?: string;
      };
    };

const FINISHED_STATUS: Record<Outcome['type'], 'completed' | 'stopped' | 'failed'> = {
  'swarm.completed': 'completed',
  'swarm.stopped': 'stopped',
  'swarm.failed': 'failed',
};

// Имя исключения вместо текста: текст может содержать значения настроек или секретов (AC-009-26).
const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

const ok = (): Result<void> => ({ ok: true, value: undefined });
const fail = (code: string, message: string, issues?: OrchestratorError['issues']): Result<void> =>
  issues === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, issues } };

export function createOrchestratorCore(deps: OrchestratorCoreDeps): OrchestratorCore {
  const { sandboxes, bus, clock, timers, ids, log, trace, llmSwarms } = deps;
  const runs = new Map<string, Run>();
  const invokeNode = createInvokeNode(deps);

  // traceId — из порта: таймеры и обработчики событий выполняются в контексте запуска роя (REQ-016-2).
  const envelope = (swarmId: string, agentId: AgentId | null) => ({
    id: ids.uuid(),
    swarmId,
    ts: clock.now(),
    source: 'orchestrator' as const,
    agentId,
    traceId: trace.currentTraceId(),
  });

  async function publish(event: PlatformEventInput): Promise<void> {
    await bus.publishEvent(event);
  }

  // stop меняет фазу во время await; TS после проверки выше сузил бы run.phase и счёл бы сравнение с 'finished' ошибкой.
  const isFinished = (run: Run): boolean => run.phase === 'finished';

  // Закрытие роя в gateway (4.6): сбой логируется и не мешает завершению роя; возвращает траты или null.
  async function closeInGateway(swarmId: string): Promise<number | null> {
    try {
      return await llmSwarms.close(swarmId);
    } catch (error) {
      log.warn('gateway_close_failed', { swarmId, err: error });
      return null;
    }
  }

  // Уборка агентов (4.6, шаг 6): песочницы, затем agent.stopped. Каждый агент получает agent.stopped один раз.
  async function stopAgents(run: Run, agentIds: readonly AgentId[]): Promise<void> {
    const swarmId = run.launch.swarmId;
    const targets = agentIds.filter((id) => !run.stopped.has(id));
    for (const agentId of targets) run.stopped.add(agentId); // до первого await: параллельный finish их не повторит
    for (const agentId of targets) {
      const sandboxId = run.sandboxes.get(agentId);
      if (sandboxId === undefined) continue;
      run.sandboxes.delete(agentId);
      try {
        await sandboxes.remove(sandboxId);
      } catch (error) {
        log.warn('sandbox remove failed', { swarmId, agentId, err: error });
      }
    }
    for (const agentId of targets) {
      await publish({ ...envelope(swarmId, agentId), type: 'agent.stopped', data: {} });
    }
  }

  // Уборка роя и итоговые события (4.6.2): песочницы → agent.stopped → событие роя.
  async function finish(run: Run, outcome: Outcome): Promise<void> {
    if (run.phase === 'finished') return;
    run.phase = 'finished';
    for (const id of run.timers) timers.clearTimeout(id);
    const swarmId = run.launch.swarmId;

    await stopAgents(
      run,
      run.launch.agents.map((agent) => agent.id),
    );
    const spentMicroUsd = await closeInGateway(swarmId);
    const spent: { spentMicroUsd?: number } = spentMicroUsd === null ? {} : { spentMicroUsd };
    if (outcome.type === 'swarm.completed') {
      await publish({
        ...envelope(swarmId, null),
        type: 'swarm.completed',
        data: { ...outcome.data, ...spent },
      });
    } else if (outcome.type === 'swarm.stopped') {
      await publish({
        ...envelope(swarmId, null),
        type: 'swarm.stopped',
        data: { ...outcome.data, ...spent },
      });
    } else {
      await publish({
        ...envelope(swarmId, null),
        type: 'swarm.failed',
        data: { ...outcome.data, ...spent },
      });
    }
    log.info('swarm finished', { swarmId, status: FINISHED_STATUS[outcome.type] });
  }

  // Сообщение шины агенту-входу команды (4.6, шаг 4). Команда становится запущенным шагом.
  async function deliverTeam(
    run: Run,
    teamId: NodeId,
    from: NodeId | 'user',
    value: unknown,
  ): Promise<void> {
    run.running.add(teamId);
    await bus.publishMessage({
      id: ids.uuid(),
      swarmId: run.launch.swarmId,
      from,
      to: teamId,
      text: valueText(value),
      ts: clock.now(),
    });
  }

  // Шаг-программа (4.6, шаг 3). Исключение публикации или шины завершает рой node_failed (D-185).
  async function runProgram(run: Run, nodeId: NodeId, value: unknown): Promise<void> {
    try {
      await callProgram(run, nodeId, value);
    } catch (error) {
      log.error('program step failed', {
        swarmId: run.launch.swarmId,
        nodeId,
        errorName: errorName(error),
      });
      if (!isFinished(run))
        await finish(run, {
          type: 'swarm.failed',
          data: { reason: 'node_failed', detail: `${nodeId}: node_failed` },
        });
    }
  }

  // Вызов программы (4.6, шаги 3 и 7; 026, 4.10). Ошибка вызова завершает рой node_failed.
  async function callProgram(run: Run, nodeId: NodeId, value: unknown): Promise<void> {
    const program = run.programs.get(nodeId);
    if (!program || isFinished(run)) return;
    const swarmId = run.launch.swarmId;
    run.running.add(nodeId);
    await publish({
      ...envelope(swarmId, null),
      type: 'node.started',
      data: { nodeId, type: program.type },
    });
    if (isFinished(run)) return; // рой остановили во время публикации: вызов не запускаем
    const startedAt = Date.parse(clock.now());
    let result: NodeInvocationResult;
    try {
      result = await invokeNode({
        orgId: run.launch.orgId,
        type: program.type,
        call: { kind: 'execute', input: value },
        settings: program.settings,
        credentials: program.credentials,
        stateKey: program.stateKey ?? `swarm:${swarmId}:${nodeId}`, // 033, REQ-033-18
      });
    } catch (error) {
      // Сбой хранилища секретов (026, 4.10): вызов не вернул результат, рой не должен зависнуть
      log.error('node invoke threw', { swarmId, nodeId, errorName: errorName(error) });
      result = {
        ok: false,
        error: { code: 'node_failed', message: 'Сбой вызова программы' },
        durationMs: Math.max(0, Date.parse(clock.now()) - startedAt),
      };
    }
    if (isFinished(run)) return; // ответ после завершения роя — без событий (4.6, шаг 7)
    if (!result.ok) {
      await publish({
        ...envelope(swarmId, null),
        type: 'node.failed',
        data: {
          nodeId,
          code: result.error.code,
          message: result.error.message,
          durationMs: result.durationMs,
        },
      });
      await finish(run, {
        type: 'swarm.failed',
        data: { reason: 'node_failed', detail: `${nodeId}: ${result.error.code}` },
      });
      return;
    }
    run.running.delete(nodeId);
    await publish({
      ...envelope(swarmId, null),
      type: 'node.completed',
      data: { nodeId, durationMs: result.durationMs },
    });
    await completeStep(run, nodeId, result.output);
  }

  // Программа, запущенная выходом другого шага, идёт в фоне: её ответ не задерживает остальные шаги (4.6, шаг 7; AC-009-21).
  function startProgram(run: Run, nodeId: NodeId, value: unknown): void {
    runProgram(run, nodeId, value).catch((error: unknown) => {
      log.error('program step failed', { swarmId: run.launch.swarmId, nodeId, err: error });
    });
  }

  // Выход шага (4.6, шаги 5 и 7): выход шага-выхода запоминается, выход передаётся по каждому исходящему потоку.
  async function completeStep(run: Run, stepId: NodeId, output: unknown): Promise<void> {
    if (isFinished(run)) return;
    if (stepId === run.plan.exit) run.exit = { value: output };
    await Promise.all(
      run.plan.next(stepId).map(async (target) => {
        const step = run.plan.stepOf(target);
        if (step.kind === 'program') startProgram(run, step.id, output);
        else await deliverTeam(run, step.id, stepId, output);
      }),
    );
    await settle(run);
  }

  // Выход команды (4.6, шаг 6): agent.result агента-входа; песочницы команды убираются, выход передаётся дальше.
  async function completeTeam(run: Run, entryId: AgentId, text: string): Promise<void> {
    run.running.delete(entryId);
    const step = run.plan.stepOf(entryId);
    if (step.kind === 'team') await stopAgents(run, step.team.members);
    await completeStep(run, entryId, { text });
  }

  // Рой завершён, когда шаг-выход дал выход и не осталось начатых незавершённых шагов (4.6, шаг 7).
  async function settle(run: Run): Promise<void> {
    if (isFinished(run) || !run.begun || run.exit === null || run.running.size > 0) return;
    await finish(run, { type: 'swarm.completed', data: { result: valueText(run.exit.value) } });
  }

  // Когда все агенты стартовали — задача шагу-входу, затем swarm.started (4.6, шаги 2 и 4).
  // Спека 033, REQ-033-15: при запуске триггера шаг-вход получает событие триггера от его id.
  async function checkReady(run: Run): Promise<void> {
    if (run.phase !== 'waiting' || run.started.size < run.launch.agents.length) return;
    run.phase = 'running'; // до первого await, чтобы параллельные agent.started не запустили задачу дважды
    const swarmId = run.launch.swarmId;
    const { trigger } = run.launch;
    const from = trigger === null ? 'user' : trigger.nodeId;
    const value = trigger === null ? { text: run.launch.task } : trigger.event;
    const entry = run.plan.stepOf(run.plan.entry);
    if (entry.kind === 'program') await runProgram(run, entry.id, value);
    else await deliverTeam(run, entry.id, from, value);
    if (isFinished(run)) return;
    run.begun = true;
    await publish({ ...envelope(swarmId, null), type: 'swarm.started', data: {} });
    await settle(run);
  }

  // env 4.8 без адаптерных ключей. TRACEPARENT здесь нет: порт TraceContext отдаёт только traceId (см. README).
  // Спека 009, 4.6 (шаг 1): AGENT_PEERS — соседи по link, AGENT_ENTRY — агент-вход команды;
  // агенту-входу ещё AGENT_TASK_FROM и AGENT_RESULT_TO (4.8).
  function agentSpec(run: Run, agent: AgentSpec): SandboxSpec {
    const { launch, plan } = run;
    const linked = new Set(plan.peers(agent.id));
    const peers = launch.agents
      .filter((other) => linked.has(other.id))
      .map((other) => ({ id: other.id, name: other.name, role: other.role }));
    const step = plan.stepOf(agent.id);
    const entry = step.kind === 'team' ? step.team.entry : agent.id;
    const env: Record<string, string> = {
      SWARM_ID: launch.swarmId,
      AGENT_ID: agent.id,
      AGENT_NAME: agent.name,
      AGENT_ROLE: agent.role,
      AGENT_MODEL: agent.model,
      AGENT_PEERS: JSON.stringify(peers),
      AGENT_ENTRY: entry,
      AGENT_MAX_STEPS: String(deps.agent.maxSteps),
      AGENT_MAX_TOKENS: String(agent.maxTokens ?? launch.maxTokens ?? deps.agent.maxTokens), // 031, 4.4
      LLM_GATEWAY_TOKEN: deps.agent.llmGatewayToken,
      TELEMETRY_FLUSH_TIMEOUT_MS: String(deps.agent.flushTimeoutMs),
    };
    if (entry === agent.id) {
      const incoming = launch.edges.find((edge) => edge.kind === 'flow' && edge.to === entry);
      env['AGENT_TASK_FROM'] =
        launch.trigger !== null
          ? launch.trigger.nodeId
          : incoming
            ? plan.stepOf(incoming.from).id
            : 'user';
      env['AGENT_RESULT_TO'] = plan.exit === entry ? 'user' : 'process';
    }
    return {
      template: deps.agent.template,
      env,
      metadata: {
        'swag.kind': 'agent',
        'swag.swarm': run.launch.swarmId,
        'swag.agent': agent.id,
      },
    };
  }

  return {
    info: () => ({ service: 'orchestrator', version: deps.version }),

    async launch(body) {
      const parsed = SwarmLaunch.safeParse(body);
      if (!parsed.success) {
        return fail(
          'validation_error',
          'Запуск роя не прошёл проверку',
          parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        );
      }
      const launch = parsed.data;
      if (runs.has(launch.swarmId))
        return fail('swarm_exists', `Рой ${launch.swarmId} уже запущен`);

      const run: Run = {
        launch,
        plan: graphPlan(launch),
        programs: new Map(launch.programs.map((program) => [program.id, program])),
        phase: 'creating',
        begun: false,
        sandboxes: new Map(),
        stopped: new Set(),
        started: new Set(),
        running: new Set(),
        exit: null,
        timers: [],
      };
      runs.set(launch.swarmId, run);
      log.info('swarm launch', { swarmId: launch.swarmId, agents: launch.agents.length });
      try {
        await llmSwarms.register({
          swarmId: launch.swarmId,
          budgetMicroUsd: launch.budgetMicroUsd,
          expiresAt:
            deps.timeouts.swarmMs === 0
              ? null
              : new Date(Date.parse(clock.now()) + deps.timeouts.swarmMs + 60000).toISOString(),
          agents: launch.agents.map((agent) => ({
            agentId: agent.id,
            model: agent.model,
            budgetMicroUsd: agent.budgetMicroUsd,
          })),
        });
      } catch (error) {
        await finish(run, {
          type: 'swarm.failed',
          data: {
            reason: 'gateway_unavailable',
            detail: error instanceof Error ? error.message : String(error),
          },
        });
        return ok();
      }
      if (run.phase === 'finished') {
        // stop пришёл во время регистрации: finish уже закрыл рой, а регистрация могла пройти после закрытия
        await closeInGateway(launch.swarmId);
        return ok();
      }
      run.timers.push(
        timers.setTimeout(() => {
          if (run.phase === 'finished') return;
          log.error('swarm timeout', { swarmId: launch.swarmId });
          void finish(run, { type: 'swarm.failed', data: { reason: 'swarm_timeout' } });
        }, deps.timeouts.swarmMs),
      );
      run.timers.push(
        timers.setTimeout(() => {
          if (run.phase === 'creating' || run.phase === 'waiting') {
            const missing = launch.agents.map((a) => a.id).filter((id) => !run.started.has(id));
            log.error('agent start timeout', { swarmId: launch.swarmId, missing });
            void finish(run, { type: 'swarm.failed', data: { reason: 'agent_start_timeout' } });
          }
        }, deps.timeouts.agentStartMs),
      );

      for (const agent of launch.agents) {
        try {
          const { sandboxId } = await sandboxes.create(agentSpec(run, agent));
          if (isFinished(run)) {
            // рой остановили во время создания — эту песочницу удаляем сразу
            await sandboxes.remove(sandboxId);
            break;
          }
          run.sandboxes.set(agent.id, sandboxId);
          await publish({
            ...envelope(launch.swarmId, agent.id),
            type: 'agent.launched',
            data: { sandboxId },
          });
        } catch (error) {
          log.error('sandbox create failed', {
            swarmId: launch.swarmId,
            agentId: agent.id,
            err: error,
          });
          await finish(run, {
            type: 'swarm.failed',
            data: {
              reason: 'sandbox_error',
              detail: error instanceof Error ? error.message : String(error),
            },
          });
          return ok();
        }
      }
      if (run.phase === 'creating') run.phase = 'waiting';
      await checkReady(run);
      return ok();
    },

    async stop(swarmId) {
      const run = runs.get(swarmId);
      if (!run) return fail('not_found', `Рой ${swarmId} не найден`);
      await finish(run, { type: 'swarm.stopped', data: { reason: 'user' } });
      return ok();
    },

    async handleEvent(raw) {
      const parsed = PlatformEventInput.safeParse(raw);
      if (!parsed.success) {
        log.warn('event dropped', { reason: 'invalid_schema', issues: parsed.error.issues.length });
        return;
      }
      const event = parsed.data;
      const run = runs.get(event.swarmId);
      if (!run || run.phase === 'finished' || event.agentId === null) return;

      if (event.type === 'agent.started') {
        run.started.add(event.agentId);
        await checkReady(run);
      } else if (event.type === 'agent.result') {
        // 4.6, шаг 6: выход команды даёт только её агент-вход; ответы остальных агентов игнорируются
        if (run.phase === 'running' && run.running.has(event.agentId)) {
          await completeTeam(run, event.agentId, event.data.text);
        }
      } else if (event.type === 'agent.failed' && run.phase === 'running') {
        // 4.6: отказ по бюджету из gateway приходит как model_error:<код> (022, 4.3)
        const reason = event.data.reason;
        if (
          reason === 'model_error:swarm_budget_exceeded' ||
          reason === 'model_error:agent_budget_exceeded'
        ) {
          await finish(run, {
            type: 'swarm.failed',
            data: {
              reason: 'budget_exceeded',
              detail: `${event.agentId}: ${reason.slice('model_error:'.length)}`,
            },
          });
        } else {
          await finish(run, {
            type: 'swarm.failed',
            data: { reason: 'agent_failed', detail: `${event.agentId}: ${reason}` },
          });
        }
      }
    },

    async cleanupOrphans() {
      // Сначала песочницы узлов: агентская выборка по 'swag.kind' их уже не вернёт (без двойного счёта).
      const nodeIds = await deps.nodeSandboxes.list({ 'swag.kind': 'node' });
      for (const id of nodeIds) await deps.nodeSandboxes.remove(id);
      const agentIds = await sandboxes.list({ 'swag.kind': true });
      for (const id of agentIds) await sandboxes.remove(id);
      return nodeIds.length + agentIds.length;
    },

    invokeNode,
  };
}
