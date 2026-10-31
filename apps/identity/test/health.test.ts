import { describe, expect, it } from 'vitest';
import { closeHarnessesAfterEach, makeHarness } from './support.ts';

closeHarnessesAfterEach();

describe('GET /health', () => {
  it('AC-000-4: 200 и тело по контракту 4.4', async () => {
    const h = await makeHarness();
    const response = await h.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'identity', version: 'test' });
  });
});
