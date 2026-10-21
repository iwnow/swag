import { createOrchestratorCore } from '@swag/orchestrator-core';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

describe('GET /health', () => {
  it('AC-000-5: 200 и тело по контракту 4.4', async () => {
    const app = buildApp(createOrchestratorCore({ version: '1.2.3' }));
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'orchestrator', version: '1.2.3' });
    await app.close();
  });
});
