/// <reference types="node" />
import { timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, retryAfterMs: number | null, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function httpRetryable(err: unknown): false | { afterMs?: number } {
  if (err instanceof HttpError) {
    const retryable = err.status === 408 || err.status === 429 || err.status >= 500;
    if (!retryable) return false;
    return err.retryAfterMs === null ? {} : { afterMs: err.retryAfterMs };
  }
  if (err instanceof TypeError) return {};
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return {};
  return false;
}

export function parseRetryAfter(value: string | null, now: Date): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  if (!/[A-Za-z]/.test(text)) return null;
  const date = Date.parse(text);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now.getTime());
}

// Спека 024, 4.13 (как 002, 4.2 и 024, 4.7): сравнение через timingSafeEqual; разная длина — отказ сразу, без сравнения.
export function tokenMatches(presented: string, expected: string): boolean {
  const given = Buffer.from(presented);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

// Заголовок Authorization: Bearer <token>. Нет заголовка или другая схема — false.
export function bearerMatches(authorization: string | undefined, expected: string): boolean {
  const header = authorization ?? '';
  return header.startsWith('Bearer ') && tokenMatches(header.slice('Bearer '.length), expected);
}
