import { afterEach, beforeEach } from 'vitest';
import type { ChatRequest } from '@swag/llm-gateway-core';
import { startFakeProvider } from '../../../infra/llm/fake-provider/server.ts';
import { createLiteLlmUpstream, type LiteLlmOptions } from '../src/index.ts';

// Значения из 4.9 спеки: мастер-ключ LiteLLM и ключ фейка (`*_API_KEY`).
export const MASTER_KEY = 'sk-swag-local-not-secret';
export const FAKE_KEY = 'fake-provider-key-not-secret';

export const STUB_URL = 'http://stub.invalid';

export const signal = (): AbortSignal => new AbortController().signal;

export const chatRequest = (content: string): ChatRequest => ({
  model: 'fake-small',
  messages: [{ role: 'user', content }],
});

export const upstreamFor = (baseUrl: string, overrides: Partial<LiteLlmOptions> = {}) =>
  createLiteLlmUpstream({
    baseUrl,
    masterKey: MASTER_KEY,
    idleTimeoutMs: 120_000,
    secrets: [MASTER_KEY, FAKE_KEY],
    ...overrides,
  });

// Подставной fetch для ответов, которые фейк не даёт.
export const stubFetch = (res: Response): typeof fetch => (async () => res) as typeof fetch;

// Фейк поднимается перед каждым тестом блока и закрывается после; тест берёт его из `.current`.
export function useFake(models?: string[]) {
  const ref = {} as { current: Awaited<ReturnType<typeof startFakeProvider>> };
  beforeEach(async () => {
    ref.current = await startFakeProvider(models ? { port: 0, models } : { port: 0 });
  });
  afterEach(async () => {
    await ref.current.close();
  });
  return ref;
}
