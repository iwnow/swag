import { describe, expect, it } from 'vitest';
import { createCronerSchedule } from '../src/index.ts';

// Спека 033, 4.5, AC-033-10.

const schedule = createCronerSchedule();

describe('createCronerSchedule', () => {
  it('AC-033-10: next даёт ближайшее срабатывание по часовому поясу', () => {
    const next = schedule.next('0 9 * * *', 'Europe/Moscow', new Date('2026-11-03T10:00:00Z'));
    expect(next?.toISOString()).toBe('2026-11-04T06:00:00.000Z');
  });

  it('AC-033-10: check отвергает невалидный cron', () => {
    expect(schedule.check('bad', 'UTC')).toBe('invalid_cron');
  });

  it('AC-033-10: check отвергает невалидный часовой пояс', () => {
    expect(schedule.check('* * * * *', 'Mars/Base')).toBe('invalid_timezone');
  });

  it('AC-033-10: шесть полей (с секундами) — invalid_cron', () => {
    expect(schedule.check('0 9 * * * 0', 'UTC')).toBe('invalid_cron');
  });

  it('AC-033-10: next строго после after — срабатывание на after даёт следующее', () => {
    const fired = new Date('2026-11-04T06:00:00.000Z');
    const next = schedule.next('0 9 * * *', 'Europe/Moscow', fired);
    expect(next?.toISOString()).toBe('2026-11-05T06:00:00.000Z');
  });
});
