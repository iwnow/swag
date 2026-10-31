import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { OrchestratorClient } from '@swag/api-core';
import type { OrgDirectory } from '@swag/billing-core';
import { buildApp } from '../src/app.ts';
import {
  bearer,
  body,
  makeApi,
  makeBilling,
  makeStartedAuth,
  ORG_A,
  ORG_B,
  T,
  WHO,
} from './support.ts';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const MISSING_ORG = '00000000-0000-4000-8000-0000000000c0';
const MILLION = 1000000;

// Приложение с балансом. По умолчанию баланс пустой: тест пополняет его сам. launches считает вызовы оркестратора.
async function setup(options: { fund?: boolean; orgs?: OrgDirectory } = {}) {
  const launches = { count: 0 };
  const orchestrator: OrchestratorClient = {
    launch: async () => {
      launches.count += 1;
    },
    stop: async () => undefined,
  };
  const billing = await makeBilling({ fund: options.fund ?? false, orgs: options.orgs });
  const { core } = await makeApi({ billing, orchestrator });
  const app = await buildApp(core, billing, {}, (await makeStartedAuth({ core })).app);
  apps.push(app);
  return { app, launches };
}

const topup = (app: FastifyInstance, token: string, orgId: string, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: `/organizations/${orgId}/balance/topups`,
    headers: bearer(token),
    payload: payload as Record<string, unknown>,
  });

const balanceOf = async (app: FastifyInstance, token: string, orgId: string) =>
  (
    await app.inject({
      method: 'GET',
      url: `/organizations/${orgId}/balance`,
      headers: bearer(token),
    })
  ).json<{ balanceMicroUsd: number; heldMicroUsd: number; availableMicroUsd: number }>();

describe('баланс организации по HTTP', () => {
  it('AC-013-2: администратор пополняет свою организацию — 201 с actorId, баланс 1 000 000', async () => {
    const { app } = await setup();
    const response = await topup(app, T.adminA, ORG_A, {
      amountMicroUsd: 1000000,
      comment: null,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      orgId: ORG_A,
      kind: 'topup',
      amountMicroUsd: 1000000,
      actorId: WHO.adminA.sub,
    });
    expect(await balanceOf(app, T.adminA, ORG_A)).toMatchObject({ balanceMicroUsd: 1000000 });
  });

  it('AC-013-3: user не пополняет — 403 forbidden; администратор чужой организации — 404 not_found', async () => {
    const { app } = await setup();
    const forbidden = await topup(app, T.u1, ORG_A, { amountMicroUsd: MILLION, comment: null });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({ error: { code: 'forbidden' } });

    const notFound = await topup(app, T.adminA, ORG_B, { amountMicroUsd: MILLION, comment: null });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('AC-013-4: супервизор — без комментария 400; с комментарием для существующей организации 201; для неизвестной 404', async () => {
    const { app } = await setup();
    const noComment = await topup(app, T.sup, ORG_B, { amountMicroUsd: MILLION, comment: null });
    expect(noComment.statusCode).toBe(400);
    expect(noComment.json()).toMatchObject({ error: { code: 'validation_error' } });

    const created = await topup(app, T.sup, ORG_B, {
      amountMicroUsd: MILLION,
      comment: 'поддержка',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ orgId: ORG_B, actorId: WHO.sup.sub });

    const missing = await topup(app, T.sup, MISSING_ORG, {
      amountMicroUsd: MILLION,
      comment: 'поддержка',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('AC-013-4: супервизор — identity недоступна, 503 org_directory_unavailable', async () => {
    const { app } = await setup({
      orgs: {
        exists: async () => {
          throw new Error('identity unreachable');
        },
      },
    });
    const response = await topup(app, T.sup, ORG_B, { amountMicroUsd: MILLION, comment: 'тест' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'org_directory_unavailable' } });
  });

  it('AC-013-5: сумма 0, дробная или больше предела — 400 validation_error, баланс не меняется', async () => {
    const { app } = await setup();
    for (const amountMicroUsd of [0, 1.5, 100000001]) {
      const response = await topup(app, T.adminA, ORG_A, { amountMicroUsd, comment: null });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'validation_error' } });
    }
    expect(await balanceOf(app, T.adminA, ORG_A)).toMatchObject({ balanceMicroUsd: 0 });
  });

  it('AC-013-6: user, admin своей организации и супервизор читают баланс и историю — 200; чужой user и не-UUID — 404', async () => {
    const { app } = await setup({ fund: true });
    for (const token of [T.u1, T.adminA, T.sup]) {
      const balance = await app.inject({
        method: 'GET',
        url: `/organizations/${ORG_A}/balance`,
        headers: bearer(token),
      });
      expect(balance.statusCode).toBe(200);
      const entries = await app.inject({
        method: 'GET',
        url: `/organizations/${ORG_A}/balance/entries`,
        headers: bearer(token),
      });
      expect(entries.statusCode).toBe(200);
    }

    const foreign = await app.inject({
      method: 'GET',
      url: `/organizations/${ORG_A}/balance`,
      headers: bearer(T.b),
    });
    expect(foreign.statusCode).toBe(404);
    const foreignEntries = await app.inject({
      method: 'GET',
      url: `/organizations/${ORG_A}/balance/entries`,
      headers: bearer(T.b),
    });
    expect(foreignEntries.statusCode).toBe(404);

    const notUuid = await app.inject({
      method: 'GET',
      url: '/organizations/abc/balance',
      headers: bearer(T.adminA),
    });
    expect(notUuid.statusCode).toBe(404);
  });

  it('AC-013-7: 120 записей — страницы 50, 50, 20 без пропусков и повторов; неверные limit и before — 400', async () => {
    const { app } = await setup();
    const toppedUp: number[] = [];
    for (let i = 0; i < 120; i += 1) {
      const response = await topup(app, T.adminA, ORG_A, { amountMicroUsd: 1, comment: null });
      expect(response.statusCode).toBe(201);
      toppedUp.push(response.json<{ id: number }>().id);
    }

    const pages: number[][] = [];
    const sizes: number[] = [];
    let before: number | undefined;
    let nextBefore: number | null = null;
    for (let page = 0; page < 3; page += 1) {
      const suffix = before === undefined ? '' : `&before=${before}`;
      const response = await app.inject({
        method: 'GET',
        url: `/organizations/${ORG_A}/balance/entries?limit=50${suffix}`,
        headers: bearer(T.adminA),
      });
      expect(response.statusCode).toBe(200);
      const list = response.json<{ entries: { id: number }[]; nextBefore: number | null }>();
      pages.push(list.entries.map((entry) => entry.id));
      sizes.push(list.entries.length);
      nextBefore = list.nextBefore;
      before = nextBefore ?? undefined;
    }

    expect(sizes).toEqual([50, 50, 20]);
    expect(nextBefore).toBeNull();
    const seen = pages.flat();
    expect(seen).toEqual([...toppedUp].sort((a, b) => b - a));

    for (const query of ['limit=0', 'limit=101', 'before=abc', 'before=9007199254740992']) {
      const response = await app.inject({
        method: 'GET',
        url: `/organizations/${ORG_A}/balance/entries?${query}`,
        headers: bearer(T.adminA),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'validation_error' } });
    }
  });

  it('AC-013-8: бюджет больше доступного — 402 insufficient_balance; событий нет, оркестратор не вызван, место под MAX_ACTIVE_SWARMS свободно', async () => {
    const { app, launches } = await setup();
    await topup(app, T.adminA, ORG_A, { amountMicroUsd: MILLION, comment: null });

    const refused = await app.inject({
      method: 'POST',
      url: '/swarms',
      headers: bearer(T.adminA),
      payload: { ...body(1), budgetMicroUsd: MILLION + 1 },
    });
    expect(refused.statusCode).toBe(402);
    expect(refused.json()).toMatchObject({ error: { code: 'insufficient_balance' } });

    const list = await app.inject({ method: 'GET', url: '/swarms', headers: bearer(T.adminA) });
    expect(list.json()).toEqual([]);
    expect(launches.count).toBe(0);

    for (let i = 0; i < 3; i += 1) {
      const created = await app.inject({
        method: 'POST',
        url: '/swarms',
        headers: bearer(T.adminA),
        payload: { ...body(1), budgetMicroUsd: 1000 },
      });
      expect(created.statusCode).toBe(201);
    }
  });

  it('AC-013-9: бюджет 400 000 при доступном 1 000 000 — 201, в резерве 400 000, доступно 600 000', async () => {
    const { app } = await setup();
    await topup(app, T.adminA, ORG_A, { amountMicroUsd: MILLION, comment: null });

    const created = await app.inject({
      method: 'POST',
      url: '/swarms',
      headers: bearer(T.adminA),
      payload: { ...body(1), budgetMicroUsd: 400000 },
    });
    expect(created.statusCode).toBe(201);
    expect(await balanceOf(app, T.adminA, ORG_A)).toEqual({
      orgId: ORG_A,
      balanceMicroUsd: MILLION,
      heldMicroUsd: 400000,
      availableMicroUsd: 600000,
    });
  });
});
