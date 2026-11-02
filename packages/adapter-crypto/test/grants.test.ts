import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createEgressGrants } from '../src/index.ts';

// Спека 026, 4.7: подписанный грант выхода. Ключи в тестах — явно фейковые.
const KEY = Buffer.alloc(32, 1).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 2).toString('base64');

const grant = () => ({
  invocationId: randomUUID(),
  egress: ['api.example.com', '*.example.org:8443'],
  expiresAt: 1_900_000_000_000,
});

describe('createEgressGrants', () => {
  it('AC-026-10: токен проверяется тем же ключом и возвращает грант; другим ключом — null', () => {
    const grants = createEgressGrants(KEY);
    const value = grant();
    const token = grants.issue(value);

    expect(grants.verify(token)).toEqual(value);
    expect(createEgressGrants(OTHER_KEY).verify(token)).toBeNull();
  });

  it('AC-026-10: изменён символ полезной части — null', () => {
    const grants = createEgressGrants(KEY);
    const token = grants.issue(grant());
    const flipped = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);

    expect(grants.verify(flipped)).toBeNull();
  });

  it('AC-026-10: полезная часть подписана верно, но не проходит EgressGrant (нет invocationId) — null', () => {
    const grants = createEgressGrants(KEY);
    const payload = Buffer.from(JSON.stringify({ egress: [], expiresAt: 1 }), 'utf8').toString(
      'base64url',
    );
    const signature = createHmac('sha256', Buffer.alloc(32, 1)).update(payload).digest('base64url');

    expect(grants.verify(`${payload}.${signature}`)).toBeNull();
    expect(grants.verify('нет-точки')).toBeNull();
    expect(grants.verify('a.b.c')).toBeNull();
  });

  it('AC-026-10: ключ не 32 байта — createEgressGrants бросает', () => {
    expect(() => createEgressGrants(Buffer.alloc(16, 1).toString('base64'))).toThrow();
  });
});
