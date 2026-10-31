import { describe, expect, it } from 'vitest';
import { closeHarnessesAfterEach, makeHarness } from './support.ts';

closeHarnessesAfterEach();

describe('ошибки формата запроса', () => {
  it('AC-012-26: тело больше лимита — 413, не-JSON и JSON без полей — 400 validation_error', async () => {
    const h = await makeHarness({ bodyLimit: 1024 });
    const big = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@example.com', password: 'x'.repeat(2000) }),
    });
    expect(big.statusCode).toBe(413);
    expect(big.json<{ error: { code: string } }>().error.code).toBe('validation_error');

    const notJson = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: 'не JSON',
    });
    expect(notJson.statusCode).toBe(400);
    expect(notJson.json<{ error: { code: string } }>().error.code).toBe('validation_error');

    const noFields = await h.app.inject({ method: 'POST', url: '/auth/login', payload: {} });
    expect(noFields.statusCode).toBe(400);
    expect(noFields.json<{ error: { code: string } }>().error.code).toBe('validation_error');
  });
});
