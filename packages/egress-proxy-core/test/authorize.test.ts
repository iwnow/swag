import { describe, expect, it } from 'vitest';
import { createEgressProxyCore } from '../src/index.ts';
import {
  AUTH_HEADER,
  INVOCATION_ID,
  NOW,
  fakeClock,
  fakeGrants,
  fakeLogger,
  fakeResolver,
  grant,
  TOKEN,
} from './fakes.ts';

const setup = (
  options: {
    grantValue?: ReturnType<typeof grant> | null;
    dns?: Parameters<typeof fakeResolver>[0];
  } = {},
) => {
  const grants = fakeGrants(options.grantValue === undefined ? grant() : options.grantValue);
  const resolver = fakeResolver(options.dns ?? { 'allowed.test': ['93.184.215.14'] });
  const logger = fakeLogger();
  const core = createEgressProxyCore({ grants, resolver, clock: fakeClock(), logger });
  return { core, grants, resolver, logger };
};

describe('authorize', () => {
  it('AC-026-8: не CONNECT → 405 method', async () => {
    const { core } = setup();
    expect(await core.authorize('GET', 'allowed.test:443', AUTH_HEADER)).toEqual({
      ok: false,
      status: 405,
      reason: 'method',
    });
  });

  it('AC-026-8: без заголовка → 407 auth', async () => {
    const { core } = setup();
    expect(await core.authorize('CONNECT', 'allowed.test:443', undefined)).toEqual({
      ok: false,
      status: 407,
      reason: 'auth',
    });
  });

  it('AC-026-8: заголовок с неверным токеном или другим пользователем → 407 auth', async () => {
    const { core } = setup();
    const badToken = `Basic ${Buffer.from('swag:other.sig').toString('base64')}`;
    const badUser = `Basic ${Buffer.from(`bob:${TOKEN}`).toString('base64')}`;
    const notBasic = `Bearer ${TOKEN}`;
    for (const header of [badToken, badUser, notBasic]) {
      expect(await core.authorize('CONNECT', 'allowed.test:443', header)).toEqual({
        ok: false,
        status: 407,
        reason: 'auth',
      });
    }
  });

  it('AC-026-8: грант с прошедшим expiresAt → 407 expired', async () => {
    const { core } = setup({ grantValue: grant({ expiresAt: NOW.getTime() }) });
    expect(await core.authorize('CONNECT', 'allowed.test:443', AUTH_HEADER)).toEqual({
      ok: false,
      status: 407,
      reason: 'expired',
    });
  });

  it('AC-026-8: хост вне egress → 403 host', async () => {
    const { core, resolver } = setup();
    expect(await core.authorize('CONNECT', 'other.test:443', AUTH_HEADER)).toEqual({
      ok: false,
      status: 403,
      reason: 'host',
    });
    expect(resolver.calls).toEqual([]);
  });

  it('AC-026-8: порт вне 1…65535 или не число → 403 host', async () => {
    const { core } = setup();
    for (const target of [
      'allowed.test',
      'allowed.test:0',
      'allowed.test:65536',
      'allowed.test:x',
    ]) {
      expect(await core.authorize('CONNECT', target, AUTH_HEADER)).toEqual({
        ok: false,
        status: 403,
        reason: 'host',
      });
    }
  });

  it('AC-026-8: хост из egress с другим портом → 403 host', async () => {
    const { core } = setup();
    expect(await core.authorize('CONNECT', 'allowed.test:8443', AUTH_HEADER)).toEqual({
      ok: false,
      status: 403,
      reason: 'host',
    });
  });

  it('AC-026-8: хост, разрешённый в 10.0.0.5 → 403 private_address', async () => {
    const { core } = setup({ dns: { 'allowed.test': ['10.0.0.5'] } });
    expect(await core.authorize('CONNECT', 'allowed.test:443', AUTH_HEADER)).toEqual({
      ok: false,
      status: 403,
      reason: 'private_address',
    });
  });

  it('AC-026-8: адреса 93.184.215.14 и 127.0.0.1 → 403 private_address', async () => {
    const { core } = setup({ dns: { 'allowed.test': ['93.184.215.14', '127.0.0.1'] } });
    expect(await core.authorize('CONNECT', 'allowed.test:443', AUTH_HEADER)).toEqual({
      ok: false,
      status: 403,
      reason: 'private_address',
    });
  });

  it('AC-026-8: сбой резолвера → 502 resolve_failed', async () => {
    const { core } = setup({ dns: { 'allowed.test': new Error('SERVFAIL') } });
    expect(await core.authorize('CONNECT', 'allowed.test:443', AUTH_HEADER)).toEqual({
      ok: false,
      status: 502,
      reason: 'resolve_failed',
    });
  });

  it('AC-026-8: пустой ответ резолвера → 502 resolve_failed', async () => {
    const { core } = setup({ dns: { 'allowed.test': [] } });
    expect(await core.authorize('CONNECT', 'allowed.test:443', AUTH_HEADER)).toEqual({
      ok: false,
      status: 502,
      reason: 'resolve_failed',
    });
  });

  it('AC-026-8: верный случай → ok с первым адресом, портом и invocationId', async () => {
    const { core } = setup();
    expect(await core.authorize('CONNECT', 'Allowed.Test:443', AUTH_HEADER)).toEqual({
      ok: true,
      address: '93.184.215.14',
      port: 443,
      invocationId: INVOCATION_ID,
    });
  });

  it('AC-026-8: сверка с egress с подстановочным хостом и портом из записи', async () => {
    const { core } = setup({ dns: { 'x.cdn.test': ['93.184.215.14'] } });
    expect(await core.authorize('CONNECT', 'x.cdn.test:8443', AUTH_HEADER)).toMatchObject({
      ok: true,
      port: 8443,
    });
  });

  it('AC-026-8: логи — info при разрешении, warn с причиной при отказе, без токена и заголовка', async () => {
    const { core, logger } = setup({ dns: { 'allowed.test': ['10.0.0.5'] } });
    await core.authorize('CONNECT', 'allowed.test:443', AUTH_HEADER);
    await core.authorize('CONNECT', 'allowed.test:443', AUTH_HEADER);
    await core.authorize('CONNECT', 'other.test:443', AUTH_HEADER);
    expect(logger.lines[0]).toMatchObject({
      level: 'warn',
      msg: 'egress denied',
      ctx: {
        reason: 'private_address',
        host: 'allowed.test',
        port: 443,
        invocationId: INVOCATION_ID,
      },
    });
    expect(logger.lines[2]).toMatchObject({
      level: 'warn',
      msg: 'egress denied',
      ctx: { reason: 'host', host: 'other.test', port: 443, invocationId: INVOCATION_ID },
    });
    const allowed = setup();
    await allowed.core.authorize('CONNECT', 'allowed.test:443', AUTH_HEADER);
    expect(allowed.logger.lines).toEqual([
      {
        level: 'info',
        msg: 'egress allowed',
        ctx: { invocationId: INVOCATION_ID, host: 'allowed.test', port: 443 },
      },
    ]);
    const serialized = JSON.stringify(logger.lines) + JSON.stringify(allowed.logger.lines);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(AUTH_HEADER);
  });
});
