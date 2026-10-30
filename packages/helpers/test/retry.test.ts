import { describe, expect, it } from 'vitest';
import { retry, type RetryOptions } from '../src/index.ts';
import { HttpError, httpRetryable } from '../src/server/index.ts';

function setup(overrides: Partial<RetryOptions> = {}) {
  const pauses: number[] = [];
  const options: RetryOptions = {
    baseMs: 100,
    maxMs: 1000,
    random: () => 0.5,
    sleep: async (ms) => {
      pauses.push(ms);
    },
    retryable: httpRetryable,
    ...overrides,
  };
  return { pauses, options };
}

describe('retry', () => {
  it('AC-004-31: сетевая ошибка трижды, четвёртая попытка успешна — паузы 50, 100, 200', async () => {
    const { pauses, options } = setup();
    const result = await retry(async (attempt) => {
      if (attempt < 4) throw new TypeError('fetch failed');
      return `ok-${attempt}`;
    }, options);
    expect(result).toBe('ok-4');
    expect(pauses).toEqual([50, 100, 200]);
  });

  it('AC-004-31: HttpError 400 — одна попытка, ошибка 400', async () => {
    const { pauses, options } = setup();
    let calls = 0;
    const error = new HttpError(400, null, 'bad request');
    await expect(
      retry(async () => {
        calls += 1;
        throw error;
      }, options),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
    expect(pauses).toEqual([]);
  });

  it('AC-004-31: HttpError 429 с Retry-After 800 — пауза ровно 800', async () => {
    const { pauses, options } = setup();
    const result = await retry(async (attempt) => {
      if (attempt === 1) throw new HttpError(429, 800, 'too many');
      return attempt;
    }, options);
    expect(result).toBe(2);
    expect(pauses).toEqual([800]);
  });

  it('AC-004-31: все 4 попытки неудачны — брошена ошибка 4-й попытки', async () => {
    const { pauses, options } = setup();
    await expect(
      retry(async (attempt) => {
        throw new HttpError(503, null, `attempt ${attempt}`);
      }, options),
    ).rejects.toThrow('attempt 4');
    expect(pauses).toEqual([50, 100, 200]);
  });

  it('AC-004-31: signal прерван во время паузы — брошен signal.reason', async () => {
    const controller = new AbortController();
    const reason = new Error('остановка');
    const { options } = setup({
      sleep: async () => {
        controller.abort(reason);
      },
      signal: controller.signal,
    });
    let calls = 0;
    await expect(
      retry(async () => {
        calls += 1;
        throw new TypeError('fetch failed');
      }, options),
    ).rejects.toBe(reason);
    expect(calls).toBe(1);
  });

  it('AC-004-31: задержка ограничена maxMs и не меньше Retry-After', async () => {
    const { pauses, options } = setup({ maxMs: 300 });
    await expect(
      retry(
        async () => {
          throw new HttpError(429, 5000, 'too many');
        },
        { ...options, attempts: 2 },
      ),
    ).rejects.toThrow('too many');
    expect(pauses).toEqual([300]);
  });

  it('AC-004-31: дефолтный sleep прерывается signal — брошена его причина быстро', async () => {
    const controller = new AbortController();
    const reason = new Error('stop');
    setTimeout(() => controller.abort(reason), 10);
    const started = Date.now();
    await expect(
      retry(
        async () => {
          throw new TypeError('fetch failed');
        },
        {
          baseMs: 1000,
          maxMs: 1000,
          random: () => 1,
          retryable: httpRetryable,
          signal: controller.signal,
        },
      ),
    ).rejects.toBe(reason);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
