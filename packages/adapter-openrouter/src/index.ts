import { retry, type RetryOptions } from '@swag/helpers';
import { HttpError, httpRetryable, parseRetryAfter } from '@swag/helpers/server';

// Спека 004, 4.9 и 4.10: адаптер источника цен OpenRouter. Ответ отдаётся как есть, разбор — в ядре (applyOpenRouterPrices).

export interface OpenRouterPricesOptions {
  url: string; // OPENROUTER_MODELS_URL
  timeoutMs: number; // таймаут одной попытки
  retry?: Pick<RetryOptions, 'attempts' | 'baseMs' | 'maxMs' | 'sleep' | 'random'>; // по умолчанию — 4.10; тесты задают короче
  fetch?: typeof fetch; // для тестов; по умолчанию глобальный
}

export interface OpenRouterPrices {
  fetchModels(signal: AbortSignal): Promise<unknown>;
}

export function createOpenRouterPrices(options: OpenRouterPricesOptions): OpenRouterPrices {
  const send = options.fetch ?? fetch;

  async function attempt(signal: AbortSignal): Promise<unknown> {
    const response = await send(options.url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]),
    });
    if (!response.ok) {
      throw new HttpError(
        response.status,
        parseRetryAfter(response.headers.get('retry-after'), new Date()),
        `OpenRouter HTTP ${response.status}`,
      );
    }
    return response.json();
  }

  return {
    fetchModels: (signal) =>
      retry(() => attempt(signal), { ...options.retry, retryable: httpRetryable, signal }),
  };
}
