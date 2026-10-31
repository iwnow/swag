import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GATEWAY_TOKEN, SWARM_ID, closeAll, openGateway, type OpenGateway } from './support.ts';

// Спека 004, 4.2 и REQ-004-7: внутренний API регистрации роёв. Ядро — фейк хранилища из packages/llm-gateway-core/test.

afterEach(closeAll);

const bearer = { authorization: `Bearer ${GATEWAY_TOKEN}` };
const json = { 'content-type': 'application/json' };

const registration = (swarmId: string, overrides: Record<string, unknown> = {}) => ({
  swarmId,
  budgetMicroUsd: 1_000_000,
  expiresAt: null,
  agents: [{ agentId: 'agent-1', model: 'chat-small', budgetMicroUsd: null }],
  ...overrides,
});

const register = (gateway: OpenGateway, payload: unknown, headers: Record<string, string> = json) =>
  gateway.app.inject({
    method: 'POST',
    url: '/internal/swarms',
    headers,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });

const close = (gateway: OpenGateway, swarmId: string, headers: Record<string, string> = bearer) =>
  gateway.app.inject({ method: 'POST', url: `/internal/swarms/${swarmId}/close`, headers });

describe('внутренний API llm-gateway (спека 004, 4.2)', () => {
  it('AC-004-5: без Authorization и с неверным токеном — 401 unauthorized на обоих маршрутах, ядро не вызвано', async () => {
    const gateway = await openGateway();
    const register$ = vi.spyOn(gateway.budgets, 'register');
    const close$ = vi.spyOn(gateway.budgets, 'close');
    const wrong = 'x'.repeat(GATEWAY_TOKEN.length);
    const cases = [{}, { authorization: `Bearer ${wrong}` }, { authorization: 'Bearer short' }];

    for (const headers of cases) {
      const registered = await register(gateway, registration(randomUUID()), {
        ...json,
        ...headers,
      });
      const closed = await close(gateway, SWARM_ID, headers);
      expect(registered.statusCode).toBe(401);
      expect(registered.json()).toEqual({
        error: { message: 'Invalid gateway token', code: 'unauthorized' },
      });
      expect(closed.statusCode).toBe(401);
      expect(closed.json()).toEqual({
        error: { message: 'Invalid gateway token', code: 'unauthorized' },
      });
    }
    expect(register$).not.toHaveBeenCalled();
    expect(close$).not.toHaveBeenCalled();
  });

  it('AC-004-5: с верным токеном регистрация — 204 без тела, рой есть в хранилище', async () => {
    const gateway = await openGateway();
    const swarmId = randomUUID();

    const response = await register(gateway, registration(swarmId), { ...json, ...bearer });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(gateway.budgets.swarm(swarmId)).toEqual({ spentMicroUsd: 0, heldMicroUsd: 0 });
  });

  it('REQ-004-6 через оболочку: повтор регистрации — 409 swarm_registered; модель вне каталога — 400 model_not_found; бюджет агента больше роя — 400 invalid_request; тело не по схеме — 400', async () => {
    const gateway = await openGateway();
    const swarmId = randomUUID();
    const headers = { ...json, ...bearer };
    await register(gateway, registration(swarmId), headers);
    const register$ = vi.spyOn(gateway.budgets, 'register');

    const cases = [
      {
        payload: registration(swarmId),
        status: 409,
        error: { message: 'Swarm is already registered', code: 'swarm_registered' },
      },
      {
        payload: registration(randomUUID(), {
          agents: [{ agentId: 'agent-1', model: 'gpt-unknown', budgetMicroUsd: null }],
        }),
        status: 400,
        error: { message: 'Unknown model', code: 'model_not_found' },
      },
      {
        payload: registration(randomUUID(), {
          agents: [{ agentId: 'agent-1', model: 'chat-small', budgetMicroUsd: 2_000_000 }],
        }),
        status: 400,
        error: { message: 'agent budget exceeds swarm budget', code: 'invalid_request' },
      },
      {
        payload: { swarmId: 'not-a-uuid' },
        status: 400,
        error: { code: 'invalid_request' },
      },
    ];

    for (const { payload, status, error } of cases) {
      const response = await register(gateway, payload, headers);
      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({ error: { message: expect.any(String), ...error } });
    }
    const malformed = await register(gateway, '{"swarmId":', headers);
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({
      error: { message: expect.any(String), code: 'invalid_request' },
    });
    expect(register$).toHaveBeenCalledTimes(1);
  });

  it('AC-004-5: закрытие — 200 с spentMicroUsd, повтор — тот же ответ; неизвестный или не UUID рой — 404 not_found', async () => {
    const gateway = await openGateway();
    const swarmId = randomUUID();
    await register(gateway, registration(swarmId), { ...json, ...bearer });

    const first = await close(gateway, swarmId);
    const again = await close(gateway, swarmId);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ spentMicroUsd: 0, heldMicroUsd: 0 });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ spentMicroUsd: 0, heldMicroUsd: 0 });

    for (const unknown of [randomUUID(), 'not-a-uuid']) {
      const response = await close(gateway, unknown);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: { message: 'Swarm not found', code: 'not_found' },
      });
    }
  });
});
