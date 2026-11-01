import { describe, expect, it } from 'vitest';
import { formatDateTime } from '../src/index.ts';

describe('formatDateTime', () => {
  it('показывает московское время в коротком формате ru-RU', () => {
    expect(formatDateTime('2026-10-30T09:30:00.000Z')).toBe('30.10.2026, 12:30');
  });
});
