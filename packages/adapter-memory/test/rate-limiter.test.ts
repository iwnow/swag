import { describe, expect, it } from 'vitest';
import { createMemoryRateLimiter } from '../src/index.ts';

describe('createMemoryRateLimiter', () => {
  it('AC-012-14: 20 000 ключей с окном 1 с, после сдвига часов на 2 с один hit — size не больше 1', async () => {
    let now = 0;
    const limiter = createMemoryRateLimiter({ now: () => now });

    for (let i = 0; i < 20_000; i++) {
      await limiter.hit(`key-${i}`, 5, 1000);
    }
    now = 2000;
    await limiter.hit('fresh', 5, 1000);

    expect(limiter.size).toBeLessThanOrEqual(1);
  }, 20_000);

  it('REQ-012-17: лимит в окне — сверх лимита отказ без учёта, после окна сброс', async () => {
    let now = 0;
    const limiter = createMemoryRateLimiter({ now: () => now });

    expect(await limiter.hit('ip', 2, 1000)).toBe(true);
    expect(await limiter.hit('ip', 2, 1000)).toBe(true);
    expect(await limiter.hit('ip', 2, 1000)).toBe(false);
    now = 999;
    expect(await limiter.hit('ip', 2, 1000)).toBe(false);
    now = 1000;
    expect(await limiter.hit('ip', 2, 1000)).toBe(true);
    expect(limiter.size).toBe(1);
  });

  it('REQ-012-17: ключи независимы', async () => {
    const limiter = createMemoryRateLimiter({ now: () => 0 });

    expect(await limiter.hit('a', 1, 1000)).toBe(true);
    expect(await limiter.hit('a', 1, 1000)).toBe(false);
    expect(await limiter.hit('b', 1, 1000)).toBe(true);
  });
});
