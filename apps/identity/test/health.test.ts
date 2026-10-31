import { describe, expect, it } from 'vitest';
import { closeHarnessesAfterEach, makeHarness } from './support.ts';

closeHarnessesAfterEach();

describe('GET /health', () => {
  it('GET /health отдаёт status ok и ServiceInfo identity', async () => {
    const h = await makeHarness();
    const response = await h.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'identity', version: 'test' });
  });
});
