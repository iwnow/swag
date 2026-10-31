import { describe, expect, it, vi } from 'vitest';
import type { IdentityCore } from '@swag/identity-core';
import { buildApp } from '../src/app.ts';
import {
  INTERNAL_TOKEN,
  REFRESH_TTL_S,
  closeHarnessesAfterEach,
  logRecords,
  makeHarness,
} from './support.ts';

closeHarnessesAfterEach();

const settings = {
  cookieSecure: false,
  refreshTtlS: REFRESH_TTL_S,
  bodyLimit: 16384,
  internalToken: INTERNAL_TOKEN,
};

describe('уборка identity при старте (спека 024, T-10)', () => {
  it('purgeExpired вызван при старте; при сбое — warn identity_purge_failed без текста ошибки (N-23)', async () => {
    const h = await makeHarness();
    const purgeExpired = vi.fn(async () => {});
    const app = await buildApp({ ...h.core, purgeExpired } as IdentityCore, settings, {
      loggerInstance: h.telemetry.logger.pino,
    });
    await app.ready();
    expect(purgeExpired).toHaveBeenCalledTimes(1);
    await app.close();

    const secret = 'leak@example.com';
    const failing = vi.fn(async () => {
      throw new Error(secret);
    });
    const broken = await buildApp({ ...h.core, purgeExpired: failing } as IdentityCore, settings, {
      loggerInstance: h.telemetry.logger.pino,
    });
    await broken.ready();
    await broken.close();
    expect(logRecords(h).some((r) => r['msg'] === 'identity_purge_failed')).toBe(true);
    expect(h.lines.join('\n')).not.toContain(secret);
  });

  it('AC-024-14: уборка раз в час по таймеру; после app.close() таймер снят — вызовов больше нет', async () => {
    const h = await makeHarness();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const purgeExpired = vi.fn(async () => {});
      const app = await buildApp({ ...h.core, purgeExpired } as IdentityCore, settings, {
        loggerInstance: h.telemetry.logger.pino,
      });
      await app.ready();
      expect(purgeExpired).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(purgeExpired).toHaveBeenCalledTimes(2);

      await app.close();
      vi.advanceTimersByTime(60 * 60 * 1000);
      expect(purgeExpired).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
