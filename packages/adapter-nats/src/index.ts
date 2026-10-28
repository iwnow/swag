import {
  connect,
  headers,
  type MsgHdrs,
  type NatsConnection,
  type Subscription,
} from '@nats-io/transport-node';
import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type TextMapGetter,
} from '@opentelemetry/api';

// Спека 001, 4.10: публикация и подписка JSON по subjects из 4.2. Core NATS, без JetStream.
// Адаптер общий: порты шины ядер (api, orchestrator, agent) реализуются поверх него в оболочках.
// Спека 016, 4.6: контекст трассировки — в заголовке сообщения traceparent, спаны producer/consumer.
// Только @opentelemetry/api: без SDK это no-op, тело сообщения не меняется.

export interface NatsBus {
  publishJson(subject: string, value: unknown): Promise<void>;
  // Подписка: кривой JSON пропускается с предупреждением, исключения обработчика не останавливают подписку.
  // Обработчик может вернуть Promise (REQ-022-14): сообщения одной подписки обрабатываются по одному, по порядку.
  subscribeJson(subject: string, handler: (value: unknown) => void | Promise<void>): Subscription;
  close(): Promise<void>;
}

export interface NatsBusOptions {
  url: string; // NATS_URL, например nats://nats:4222
  warn?: (message: string) => void;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const TRACER = '@swag/adapter-nats';

const headerGetter: TextMapGetter<MsgHdrs | undefined> = {
  keys: (carrier) => (carrier ? carrier.keys() : []),
  get: (carrier, key) => carrier?.get(key) || undefined,
};

/**
 * Атрибуты спана по subject 4.2 спеки 001: swarm.<swarmId>.events и swarm.<swarmId>.agent.<agentId>.inbox.
 * Имя спана — шаблон subject без id, чтобы имена не размножались по роям.
 */
export function subjectAttributes(subject: string): { template: string; attributes: Attributes } {
  const tokens = subject.split('.');
  const attributes: Attributes = {
    'messaging.system': 'nats',
    'messaging.destination.name': subject,
  };
  if (tokens[0] !== 'swarm' || tokens[1] === undefined) return { template: subject, attributes };
  attributes['swarm.id'] = tokens[1];
  if (tokens[2] === 'events' && tokens.length === 3) {
    return { template: 'swarm.{swarmId}.events', attributes };
  }
  if (tokens[2] === 'agent' && tokens[3] !== undefined && tokens[4] === 'inbox') {
    attributes['agent.id'] = tokens[3];
    return { template: 'swarm.{swarmId}.agent.{agentId}.inbox', attributes };
  }
  return { template: subject, attributes };
}

export async function connectNatsBus(options: NatsBusOptions): Promise<NatsBus> {
  const connection: NatsConnection = await connect({ servers: options.url, name: 'swag' });
  const warn = options.warn ?? (() => undefined);

  return {
    async publishJson(subject, value) {
      const { template, attributes } = subjectAttributes(subject);
      const tracer = trace.getTracer(TRACER);
      tracer.startActiveSpan(
        `publish ${template}`,
        {
          kind: SpanKind.PRODUCER,
          attributes: { ...attributes, 'messaging.operation.type': 'publish' },
        },
        (span) => {
          try {
            const carrier: Record<string, string> = {};
            propagation.inject(context.active(), carrier);
            const msgHeaders = headers();
            for (const [key, val] of Object.entries(carrier)) msgHeaders.set(key, val);
            connection.publish(subject, encoder.encode(JSON.stringify(value)), {
              headers: msgHeaders,
            });
          } catch (error) {
            span.recordException(error instanceof Error ? error : String(error));
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
          } finally {
            span.end();
          }
        },
      );
    },

    subscribeJson(subject, handler) {
      const subscription = connection.subscribe(subject);
      void (async () => {
        // Цикл ждёт каждое сообщение: обработка одной подписки идёт по одному, в порядке поступления (REQ-022-14).
        for await (const message of subscription) {
          // Родитель — traceparent из заголовков; без заголовка — новый трейс (REQ-016-3).
          const parent: Context = propagation.extract(ROOT_CONTEXT, message.headers, headerGetter);
          const { template, attributes } = subjectAttributes(message.subject);
          const tracer = trace.getTracer(TRACER);
          await tracer.startActiveSpan(
            `process ${template}`,
            {
              kind: SpanKind.CONSUMER,
              attributes: { ...attributes, 'messaging.operation.type': 'process' },
            },
            parent,
            async (span) => {
              try {
                let value: unknown;
                try {
                  value = JSON.parse(decoder.decode(message.data));
                } catch {
                  span.setStatus({ code: SpanStatusCode.ERROR, message: 'invalid json' });
                  warn(`невалидный JSON на ${message.subject}`);
                  return;
                }
                try {
                  await handler(value);
                } catch (error) {
                  span.recordException(error instanceof Error ? error : String(error));
                  span.setStatus({ code: SpanStatusCode.ERROR });
                  warn(`ошибка обработчика ${message.subject}: ${String(error)}`);
                }
              } finally {
                span.end();
              }
            },
          );
        }
      })();
      return subscription;
    },

    async close() {
      await connection.drain();
    },
  };
}
