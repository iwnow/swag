import { Cron } from 'croner';

// Спека 033, 4.5. Порт `CronSchedule` объявляют ядра api-core и scheduler-core; адаптер
// реализует его структурно. Пять полей без секунд: croner принимает и шесть, поэтому число полей проверяем сами.
export type CronCheck = 'ok' | 'invalid_cron' | 'invalid_timezone';

export interface CronSchedule {
  check(cron: string, timezone: string): CronCheck;
  next(cron: string, timezone: string, after: Date): Date | null; // первое срабатывание строго после after
}

const isValidTimezone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};

const build = (cron: string, timezone: string): Cron => {
  const pattern = cron.trim();
  if (pattern.split(/\s+/).length !== 5) throw new Error('cron must have 5 fields');
  return new Cron(pattern, { timezone });
};

export function createCronerSchedule(): CronSchedule {
  return {
    check(cron, timezone) {
      if (!isValidTimezone(timezone)) return 'invalid_timezone';
      try {
        build(cron, timezone);
        return 'ok';
      } catch {
        return 'invalid_cron';
      }
    },
    next(cron, timezone, after) {
      return build(cron, timezone).nextRun(after);
    },
  };
}
