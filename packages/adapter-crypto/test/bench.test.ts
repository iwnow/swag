import { describe, expect, it } from 'vitest';
import { createArgon2Hasher } from '../src/index.ts';

// Спека 012, NFR-012-1: замер verify argon2id с параметрами 4.7. Запуск: IDENTITY_BENCH=1.
// Быстрее 20 мс — параметры не понижаются (NFR); медленнее 500 мс — вопрос D-n, параметры не меняются.

const RUNS = 50;

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;

describe.skipIf(process.env['IDENTITY_BENCH'] !== '1')(
  'adapter-crypto бенч argon2id verify',
  () => {
    it('NFR-012-1: 50 вызовов verify — p95 не больше 500 мс', async () => {
      const hasher = createArgon2Hasher();
      const hashed = await hasher.hash('bench-password-1');
      const times: number[] = [];
      for (let i = 0; i < RUNS; i += 1) {
        const started = performance.now();
        await hasher.verify(hashed, 'bench-password-1');
        times.push(performance.now() - started);
      }
      times.sort((a, b) => a - b);
      const p50 = percentile(times, 50);
      const p95 = percentile(times, 95);
      console.log(
        `NFR-012-1 argon2id verify, ${RUNS} вызовов: p50=${p50.toFixed(1)} мс, p95=${p95.toFixed(1)} мс`,
      );
      expect(p50).toBeLessThanOrEqual(500);
      expect(p95).toBeLessThanOrEqual(500);
    }, 60_000);
  },
);
