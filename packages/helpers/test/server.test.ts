import { describe, expect, it } from 'vitest';
import { HttpError, httpRetryable, parseRetryAfter } from '../src/server/index.ts';

describe('httpRetryable', () => {
  it('AC-004-31: 408, 429 и 5xx повторяемы, остальное — нет', () => {
    expect(httpRetryable(new HttpError(408, null, ''))).toEqual({});
    expect(httpRetryable(new HttpError(429, 800, ''))).toEqual({ afterMs: 800 });
    expect(httpRetryable(new HttpError(500, null, ''))).toEqual({});
    expect(httpRetryable(new HttpError(404, null, ''))).toBe(false);
  });

  it('AC-004-31: сетевая ошибка повторяема, таймаут тоже', () => {
    expect(httpRetryable(new TypeError('fetch failed'))).toEqual({});
    expect(httpRetryable(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))).toEqual(
      {},
    );
    expect(httpRetryable(new Error('прочее'))).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  const now = new Date('2026-10-30T12:00:00Z');

  it('AC-004-31: секунды переводятся в миллисекунды', () => {
    expect(parseRetryAfter('3', now)).toBe(3000);
  });

  it('AC-004-31: HTTP-дата — миллисекунды от now', () => {
    expect(parseRetryAfter(new Date(now.getTime() + 2000).toUTCString(), now)).toBe(2000);
  });

  it('AC-004-31: прошедшая дата — 0, мусор и null — null', () => {
    expect(parseRetryAfter(new Date(now.getTime() - 5000).toUTCString(), now)).toBe(0);
    expect(parseRetryAfter('abc', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });

  it('AC-004-31: отрицательные числа, дробные и пустая строка — null', () => {
    expect(parseRetryAfter('-5', now)).toBeNull();
    expect(parseRetryAfter('1.5', now)).toBeNull();
    expect(parseRetryAfter('', now)).toBeNull();
  });
});
