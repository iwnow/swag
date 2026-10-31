import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { makeAuth, makeCore } from './support.ts';

describe('GET /health', () => {
  it('AC-000-4: 200 и тело по контракту 4.4', async () => {
    const app = await buildApp(makeCore(), {}, makeAuth().app);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'api', version: 'test' });
    await app.close();
  });
});
