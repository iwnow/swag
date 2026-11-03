import type {
  JobError,
  JobDisabledReason,
  JobSpec,
  JobState,
  NodeInvocation,
  NodeInvocationResult,
  ProcessRunView,
  RunLaunchRequest,
  RunLaunchResult,
  RunRejectReason,
  RunSource,
  RunStatus,
  SwarmStatus,
} from '@swag/contracts';

// Спека 033, 4.5 и 4.7. Порты объявляет ядро; адаптеры передаёт оболочка `apps/scheduler`.

export interface Clock {
  now(): string;
}
export interface IdGenerator {
  uuid(): string;
}
// Спека 016, 4.3. Контекст лога — только id, числа и перечисления (REQ-016-10).
export type LogContext = {
  processId?: string;
  err?: unknown;
  [key: string]: unknown;
};
export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
}

// Порт расписания: объявляют api-core (проверка при сохранении) и scheduler-core (время срабатывания).
export interface CronSchedule {
  check(cron: string, timezone: string): 'ok' | 'invalid_cron' | 'invalid_timezone';
  next(cron: string, timezone: string, after: Date): Date | null; // первое срабатывание строго после after
}

export interface JobRecord {
  processId: string;
  spec: JobSpec;
  enabled: boolean;
  disabledReason: JobDisabledReason | null;
  cursor: string | null;
  nextRunAt: string | null;
  lastPollAt: string | null;
  lastError: JobError | null;
  consecutiveFailures: number;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  processId: string;
  orgId: string;
  status: RunStatus;
  reason: RunRejectReason | null;
  source: RunSource;
  event: unknown; // null вне queued и launching
  createdAt: string;
  launchedAt: string | null;
  finishedAt: string | null;
}

// Результат такта по заданию: одной транзакцией, снимает аренду.
export interface TickRecord {
  cursor: string | null;
  nextRunAt: string | null;
  lastPollAt: string | null;
  lastError: JobError | null;
  consecutiveFailures: number;
  enabled: boolean;
  disabledReason: JobDisabledReason | null;
  enqueue: RunRecord[];
}

export interface JobStore {
  put(record: JobRecord): Promise<void>; // создать или заменить целиком
  get(processId: string): Promise<JobRecord | null>;
  getMany(processIds: readonly string[]): Promise<JobRecord[]>;
  delete(processId: string): Promise<boolean>; // запуски — каскадом
  claimDue(now: string, leaseUntil: string, limit: number): Promise<JobRecord[]>; // enabled, nextRunAt <= now, аренды нет или истекла; по nextRunAt
  recordTick(processId: string, tick: TickRecord): Promise<void>;
  enqueue(run: RunRecord): Promise<void>;
  counts(processIds: readonly string[]): Promise<Map<string, { queued: number; running: number }>>; // queued = queued + launching
  takeQueued(limit: number): Promise<RunRecord[]>; // queued → launching атомарно, по createdAt
  setRun(
    id: string,
    patch: {
      status: RunStatus;
      reason?: RunRejectReason | null;
      launchedAt?: string;
      finishedAt?: string;
    },
  ): Promise<void>; // статус вне queued и launching — event = null
  cancelQueued(processId: string): Promise<number>;
  byStatus(status: 'launching' | 'running', limit: number): Promise<RunRecord[]>;
  runs(processId: string, limit: number): Promise<RunRecord[]>; // createdAt по убыванию
}

// Внутренние маршруты api (4.10). Сеть и не-2xx — исключение.
export interface ApiClient {
  launchRun(request: RunLaunchRequest): Promise<RunLaunchResult>;
  runStatuses(runIds: readonly string[]): Promise<Map<string, SwarmStatus | null>>;
}

export interface NodeInvoker {
  invokeNode(invocation: NodeInvocation): Promise<NodeInvocationResult>; // POST /node-invocations оркестратора
}

export interface RootSpans {
  run<T>(
    name: 'process.poll' | 'process.run',
    attributes: { 'swag.process': string },
    fn: () => Promise<T>,
  ): Promise<T>;
}

export interface SchedulerCoreDeps {
  jobs: JobStore;
  api: ApiClient;
  nodes: NodeInvoker;
  cron: CronSchedule;
  spans: RootSpans;
  clock: Clock;
  ids: IdGenerator;
  log: Logger;
  limits: { queueMax: number; pollMaxFailures: number; leaseMs: number; pollTimeoutMs: number };
}

export const PROCESS_TICK_BATCH = 20;

export interface SchedulerCore {
  putJob(processId: string, spec: JobSpec): Promise<JobState>;
  enable(processId: string): Promise<JobState | 'not_found' | 'process_no_trigger'>;
  disable(processId: string, reason: 'user' | 'author_blocked'): Promise<JobState | 'not_found'>;
  deleteJob(processId: string): Promise<boolean>;
  states(processIds: readonly string[]): Promise<JobState[]>;
  createRun(
    processId: string,
    event: unknown,
  ): Promise<ProcessRunView | 'not_found' | 'queue_full'>;
  runs(processId: string): Promise<ProcessRunView[] | 'not_found'>;
  tick(): Promise<{ polled: number; enqueued: number; launched: number; synced: number }>;
  recover(): Promise<number>;
}

// Каркас (T-9): операции появляются в T-14…T-16.
const notImplemented = (): never => {
  throw new Error('not implemented');
};

export function createSchedulerCore(_deps: SchedulerCoreDeps): SchedulerCore {
  return {
    putJob: notImplemented,
    enable: notImplemented,
    disable: notImplemented,
    deleteJob: notImplemented,
    states: notImplemented,
    createRun: notImplemented,
    runs: notImplemented,
    tick: notImplemented,
    recover: notImplemented,
  };
}
