import { createApiCore } from '@swag/api-core';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

describe('GET /health', () => {
  it('AC-000-4: 200 и тело по контракту 4.4', async () => {
    const app = buildApp(createApiCore({ version: '1.2.3' }));
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'api', version: '1.2.3' });
    await app.close();
  });
});
