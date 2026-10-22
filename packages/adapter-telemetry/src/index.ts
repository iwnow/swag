import { createServer, type RequestListener, type Server } from 'node:http';
import {
  context,
  defaultTextMapGetter,
  defaultTextMapSetter,
  isSpanContextValid,
  propagation,
  ROOT_CONTEXT,
  SeverityNumber,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Attributes,
  type AttributeValue,
  type Context,
  type Logger as OtelLogger,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  ExportResultCode,
  setGlobalErrorHandler,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  SimpleLogRecordProcessor,
  type LogRecordExporter,
  type LogRecordProcessor,
  type ReadableLogRecord,
} from '@opentelemetry/sdk-logs';
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TracerProvider,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace';
import type { LogError, LogLevel, ServiceName } from '@swag/contracts';
import pino, { type Logger as PinoLogger } from 'pino';

// Спека 016, 4.4. Пакет оболочек: ядра его не импортируют, они видят только порты Logger и TraceContext.

/** Контекст записи лога (016, 4.3): swarmId, agentId, err и прочие поля — только id, числа, перечисления. */
export type LogContext = {
  swarmId?: string;
  agentId?: string;
  err?: unknown;
  [key: string]: unknown;
};

/** Структурно совпадает с портом `Logger` ядер (016, 4.3). */
export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
}

/** Структурно совпадает с портом `TraceContext` ядер (016, 4.3). */
export interface TraceContext {
  currentTraceId(): string | null;
}

export type SpanKindName = 'server' | 'client' | 'producer' | 'consumer' | 'internal';

export interface SpanOptions {
  parent?: string | null; // traceparent; null — новый трейс; не задан — активный контекст
  kind?: SpanKindName;
  attributes?: Record<string, string | number>;
}

export interface TelemetryOptions {
  service: ServiceName;
  version: string;
  otlpEndpoint: string | null; // OTEL_EXPORTER_OTLP_ENDPOINT; null — без экспорта (REQ-016-6)
  logLevel: LogLevel; // LOG_LEVEL
  flushTimeoutMs: number; // TELEMETRY_FLUSH_TIMEOUT_MS
  stdout?: (line: string) => void; // для тестов; по умолчанию process.stdout
  /** Для тестов: экспорт в память вместо OTLP, без пакетирования. */
  exporters?: { spans?: SpanExporter; logs?: LogRecordExporter };
}

export interface Telemetry {
  logger: Logger & { pino: PinoLogger }; // pino — для Fastify (loggerInstance)
  trace: TraceContext;
  /** Выполнить fn в спане; parent — из traceparent (заголовок, env) или из активного контекста. */
  inSpan<T>(name: string, opts: SpanOptions, fn: () => T): T;
  currentTraceparent(): string | null; // для передачи дальше: заголовок, env
  shutdown(): Promise<void>; // сброс и остановка, не дольше flushTimeoutMs
}

const KINDS: Record<SpanKindName, SpanKind> = {
  server: SpanKind.SERVER,
  client: SpanKind.CLIENT,
  producer: SpanKind.PRODUCER,
  consumer: SpanKind.CONSUMER,
  internal: SpanKind.INTERNAL,
};

// Уровни pino, которых нет в LogLevel (trace, fatal у Fastify), сводятся к ближайшему.
const LEVELS: Record<string, LogLevel> = {
  trace: 'debug',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'error',
};
const SEVERITY: Record<LogLevel, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

/** Ошибка → LogError (4.2): класс, сообщение, стек, сообщение причины. */
export function toLogError(value: unknown): LogError {
  if (value instanceof Error) {
    const result: LogError = {
      type: value.constructor?.name || value.name || 'Error',
      message: value.message,
    };
    if (value.stack !== undefined) result.stack = value.stack;
    const cause = (value as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== null) {
      result.cause = cause instanceof Error ? cause.message : String(cause);
    }
    return result;
  }
  return { type: typeof value, message: String(value) };
}

const EXPORT_WARN_INTERVAL_MS = 10_000; // AC-016-19: не чаще одной записи в 10 с

function pinoOptions(options: TelemetryOptions): pino.LoggerOptions {
  return {
    level: options.logLevel,
    base: { service: options.service }, // без pid и hostname (4.2)
    messageKey: 'msg',
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: { level: (label) => ({ level: LEVELS[label] ?? 'info' }) },
    mixin: () => {
      const span = trace.getSpanContext(context.active());
      return span && isSpanContextValid(span) ? { traceId: span.traceId, spanId: span.spanId } : {};
    },
    serializers: {
      err: toLogError,
      // Без заголовков и тела: в логах только id, числа и перечисления (REQ-016-10).
      req: (req: { method?: string; url?: string }) => ({
        method: req.method,
        url: req.url?.split('?')[0],
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    },
  };
}

function toAttributes(record: Record<string, unknown>): Attributes {
  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(record)) {
    if (['time', 'level', 'msg', 'traceId', 'spanId'].includes(key)) continue;
    if (key === 'err' && value && typeof value === 'object') {
      const err = value as LogError;
      attributes['exception.type'] = err.type;
      attributes['exception.message'] = err.message;
      if (err.stack !== undefined) attributes['exception.stacktrace'] = err.stack;
      if (err.cause !== undefined) attributes['exception.cause'] = err.cause;
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      attributes[key] = value as AttributeValue;
    } else if (value !== undefined && value !== null) {
      attributes[key] = JSON.stringify(value);
    }
  }
  return attributes;
}

function logContextOf(record: Record<string, unknown>): Context {
  const { traceId, spanId } = record;
  if (typeof traceId !== 'string' || typeof spanId !== 'string') return ROOT_CONTEXT;
  return trace.setSpanContext(ROOT_CONTEXT, { traceId, spanId, traceFlags: TraceFlags.SAMPLED });
}

export function startTelemetry(options: TelemetryOptions): Telemetry {
  const stdout = options.stdout ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const endpoint = options.otlpEndpoint?.replace(/\/+$/, '') ?? null;
  const resource = resourceFromAttributes({
    'service.name': options.service,
    'service.version': options.version,
  });

  // Трейсы: провайдер есть всегда, чтобы traceId жил и без экспорта (AC-016-2).
  const spanProcessors: SpanProcessor[] = [];
  if (options.exporters?.spans) {
    spanProcessors.push(new SimpleSpanProcessor({ exporter: options.exporters.spans }));
  } else if (endpoint) {
    spanProcessors.push(
      new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }) }),
    );
  }
  const tracerProvider = new TracerProvider({
    resource,
    sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }), // parentbased_always_on (Q-3)
    spanProcessors,
  });
  const tracer = tracerProvider.getTracer('@swag/adapter-telemetry', options.version);

  // Логи в OTLP — только если есть куда.
  const logProcessors: LogRecordProcessor[] = [];
  if (options.exporters?.logs) {
    logProcessors.push(new SimpleLogRecordProcessor({ exporter: options.exporters.logs }));
  } else if (endpoint) {
    logProcessors.push(
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: `${endpoint}/v1/logs` }),
      }),
    );
  }
  const loggerProvider =
    logProcessors.length > 0 ? new LoggerProvider({ resource, processors: logProcessors }) : null;
  const otelLogger: OtelLogger | null =
    loggerProvider?.getLogger('@swag/adapter-telemetry', options.version) ?? null;

  // Один экземпляр на процесс: глобальные контекст, пропагатор и провайдер переустанавливаются.
  trace.disable();
  propagation.disable();
  context.disable();
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const propagator = new W3CTraceContextPropagator();
  propagation.setGlobalPropagator(propagator);
  trace.setGlobalTracerProvider(tracerProvider);

  // Запись: строка LogRecord в stdout и та же запись в OTLP Logs.
  const destination = {
    write(chunk: string) {
      const line = chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk;
      stdout(line);
      if (!otelLogger) return;
      const record = JSON.parse(line) as Record<string, unknown>;
      const level = (record['level'] as LogLevel) ?? 'info';
      otelLogger.emit({
        timestamp: new Date(String(record['time'])),
        severityNumber: SEVERITY[level],
        severityText: level,
        body: String(record['msg'] ?? ''),
        attributes: toAttributes(record),
        context: logContextOf(record),
      });
    },
  };
  const root = pino(pinoOptions(options), destination);

  // Ошибки экспорта — только в stdout и не чаще раза в 10 с (REQ-016-7, AC-016-19).
  const local = pino(pinoOptions(options), {
    write: (chunk: string) => stdout(chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk),
  });
  let lastExportWarn = Number.NEGATIVE_INFINITY;
  setGlobalErrorHandler((error) => {
    const now = Date.now();
    if (now - lastExportWarn < EXPORT_WARN_INTERVAL_MS) return;
    lastExportWarn = now;
    context.with(ROOT_CONTEXT, () => local.warn({ err: error }, 'telemetry export failed'));
  });

  const write = (level: LogLevel) => (msg: string, ctx?: LogContext) => {
    if (ctx === undefined) root[level](msg);
    else root[level](ctx, msg);
  };

  function parentContext(parent: string | null | undefined): Context {
    if (parent === undefined) return context.active();
    if (parent === null) return ROOT_CONTEXT;
    // Невалидный traceparent пропагатор игнорирует — получаем корень нового трейса (REQ-016-3).
    return propagator.extract(ROOT_CONTEXT, { traceparent: parent }, defaultTextMapGetter);
  }

  let stopped: Promise<void> | null = null;

  return {
    logger: {
      pino: root,
      debug: write('debug'),
      info: write('info'),
      warn: write('warn'),
      error: write('error'),
    },

    trace: {
      currentTraceId() {
        const span = trace.getSpanContext(context.active());
        return span && isSpanContextValid(span) ? span.traceId : null;
      },
    },

    inSpan(name, opts, fn) {
      const parent = parentContext(opts.parent);
      const attributes = opts.attributes ?? {};
      return tracer.startActiveSpan(
        name,
        { kind: KINDS[opts.kind ?? 'internal'], attributes },
        parent,
        (span) => {
          const fail = (error: unknown) => {
            span.recordException(error instanceof Error ? error : String(error));
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.end();
          };
          try {
            const result = fn();
            if (result instanceof Promise) {
              return result.then(
                (value: unknown) => {
                  span.end();
                  return value;
                },
                (error: unknown) => {
                  fail(error);
                  throw error;
                },
              ) as typeof result;
            }
            span.end();
            return result;
          } catch (error) {
            fail(error);
            throw error;
          }
        },
      );
    },

    currentTraceparent() {
      const carrier: Record<string, string> = {};
      propagator.inject(context.active(), carrier, defaultTextMapSetter);
      return carrier['traceparent'] ?? null;
    },

    shutdown() {
      stopped ??= (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, options.flushTimeoutMs);
          timer.unref?.();
        });
        const flush = Promise.allSettled([tracerProvider.shutdown(), loggerProvider?.shutdown()]);
        await Promise.race([flush, timeout]);
        clearTimeout(timer);
        trace.disable();
        propagation.disable();
        context.disable();
      })();
      return stopped;
    },
  };
}

/** Экспорт в память для тестов: записи копятся и после shutdown (в отличие от InMemory*Exporter SDK). */
export interface MemoryExporters {
  spans: SpanExporter;
  logs: LogRecordExporter;
  finishedSpans: ReadableSpan[];
  logRecords: ReadableLogRecord[];
}

export function createMemoryExporters(): MemoryExporters {
  const finishedSpans: ReadableSpan[] = [];
  const logRecords: ReadableLogRecord[] = [];
  return {
    finishedSpans,
    logRecords,
    spans: {
      export(spans, done) {
        finishedSpans.push(...spans);
        done({ code: ExportResultCode.SUCCESS });
      },
      shutdown: async () => undefined,
    },
    logs: {
      export(records, done) {
        logRecords.push(...records);
        done({ code: ExportResultCode.SUCCESS });
      },
      forceFlush: async () => undefined,
      shutdown: async () => undefined,
    },
  };
}

/**
 * Фабрика HTTP-сервера для Fastify (`serverFactory`): каждый запрос, кроме ignorePaths, идёт в серверном
 * спане, родитель — заголовок traceparent (016, 4.5). Спан закрывается, когда ответ отправлен.
 */
export function tracedHttpServer(
  telemetry: Telemetry,
  options: { ignorePaths?: string[] } = {},
): (handler: RequestListener) => Server {
  const ignore = new Set(options.ignorePaths ?? []);
  return (handler) =>
    createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      if (ignore.has(path)) {
        handler(req, res);
        return;
      }
      const header = req.headers['traceparent'];
      const method = req.method ?? 'GET';
      void telemetry
        .inSpan(
          method,
          {
            parent: typeof header === 'string' ? header : null,
            kind: 'server',
            attributes: { 'http.request.method': method, 'url.path': path },
          },
          () =>
            new Promise<void>((resolve) => {
              const span = trace.getActiveSpan();
              res.once('close', () => {
                span?.setAttribute('http.response.status_code', res.statusCode);
                if (res.statusCode >= 500) span?.setStatus({ code: SpanStatusCode.ERROR });
                resolve();
              });
              handler(req, res);
            }),
        )
        .catch(() => undefined);
    });
}
