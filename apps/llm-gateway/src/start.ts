import type { FastifyInstance } from 'fastify';
import type { CheckUpstreamResult, LlmGatewayCore, Logger } from '@swag/llm-gateway-core';

// Спека 002, REQ-002-13: повтор сверки каталога с апстримом раз в секунду.
const RETRY_MS = 1000;

// Спека 002, 4.9: секреты адаптера — мастер-ключ и значения всех переменных `*_API_KEY`; пустые не нужны.
export function upstreamSecrets(
  env: Record<string, string | undefined>,
  masterKey: string,
): string[] {
  const apiKeys = Object.entries(env).flatMap(([name, value]) =>
    name.endsWith('_API_KEY') && value ? [value] : [],
  );
  return [masterKey, ...apiKeys];
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Спека 002, REQ-002-13: сверка повторяется до истечения timeoutMs; возвращается последний результат.
export async function waitForUpstream(
  core: Pick<LlmGatewayCore, 'checkUpstream'>,
  options: { timeoutMs: number; retryMs?: number },
): Promise<CheckUpstreamResult> {
  const retryMs = options.retryMs ?? RETRY_MS;
  const deadline = performance.now() + options.timeoutMs;
  for (;;) {
    // Ожидание ответа ограничивает таймаут простоя адаптера, а не срок старта: последняя попытка не обрывается.
    const result = await core.checkUpstream(new AbortController().signal);
    if (result.ok) return result;
    const left = deadline - performance.now();
    if (left <= 0) return result;
    await delay(Math.min(retryMs, left));
  }
}

export interface GatewayStart {
  core: LlmGatewayCore;
  app: FastifyInstance;
  host: string;
  port: number;
  startupTimeoutMs: number;
  log: Logger;
  // Выход процесса внедряется: в тестах не вызываем process.exit.
  exit: (code: number) => void | Promise<void>;
}

// Спека 002, REQ-002-13 и 4.2: порт слушается только после успешной сверки. Иначе — error в лог и выход с кодом 1.
export async function startGateway(options: GatewayStart): Promise<boolean> {
  const result = await waitForUpstream(options.core, { timeoutMs: options.startupTimeoutMs });
  if (!result.ok) {
    if ('missing' in result) {
      options.log.error('upstream_models_mismatch', { missing: result.missing });
    } else {
      options.log.error('upstream_unavailable', { reason: result.failure.kind });
    }
    await options.exit(1);
    return false;
  }
  await options.app.listen({ host: options.host, port: options.port });
  return true;
}
