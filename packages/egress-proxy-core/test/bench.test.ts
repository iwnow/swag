import { describe, expect, it } from 'vitest';
import { createEgressProxyCore } from '../src/index.ts';
import { AUTH_HEADER, fakeClock, fakeGrants, fakeLogger, fakeResolver } from './fakes.ts';

describe('NFR-026-2', () => {
  it('NFR-026-2: 10 000 вызовов authorize без DNS — меньше 1000 мс', async () => {
    const core = createEgressProxyCore({
      grants: fakeGrants(),
      resolver: fakeResolver({ 'allowed.test': ['93.184.215.14'] }),
      clock: fakeClock(),
      logger: { info() {}, warn() {} },
    });
    const started = performance.now();
    for (let i = 0; i < 10_000; i += 1) {
      await core.authorize('CONNECT', 'allowed.test:443', AUTH_HEADER);
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('NFR-026-2: хост вне egress отказывается без вызова резолвера', async () => {
    const resolver = fakeResolver({});
    const core = createEgressProxyCore({
      grants: fakeGrants(),
      resolver,
      clock: fakeClock(),
      logger: fakeLogger(),
    });
    await core.authorize('CONNECT', 'other.test:443', AUTH_HEADER);
    expect(resolver.calls).toEqual([]);
  });
});
