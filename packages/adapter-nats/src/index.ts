import { connect, type NatsConnection, type Subscription } from '@nats-io/transport-node';

// Спека 001, 4.10: публикация и подписка JSON по subjects из 4.2. Core NATS, без JetStream.
// Адаптер общий: порты шины ядер (api, orchestrator, agent) реализуются поверх него в оболочках.

export interface NatsBus {
  publishJson(subject: string, value: unknown): Promise<void>;
  // Подписка: кривой JSON пропускается с предупреждением, исключения обработчика не останавливают подписку.
  subscribeJson(subject: string, handler: (value: unknown) => void): Subscription;
  close(): Promise<void>;
}

export interface NatsBusOptions {
  url: string; // NATS_URL, например nats://nats:4222
  warn?: (message: string) => void;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export async function connectNatsBus(options: NatsBusOptions): Promise<NatsBus> {
  const connection: NatsConnection = await connect({ servers: options.url, name: 'swag' });
  const warn = options.warn ?? (() => undefined);

  return {
    async publishJson(subject, value) {
      connection.publish(subject, encoder.encode(JSON.stringify(value)));
    },

    subscribeJson(subject, handler) {
      const subscription = connection.subscribe(subject);
      void (async () => {
        for await (const message of subscription) {
          let value: unknown;
          try {
            value = JSON.parse(decoder.decode(message.data));
          } catch {
            warn(`невалидный JSON на ${message.subject}`);
            continue;
          }
          try {
            handler(value);
          } catch (error) {
            warn(`ошибка обработчика ${message.subject}: ${String(error)}`);
          }
        }
      })();
      return subscription;
    },

    async close() {
      await connection.drain();
    },
  };
}
