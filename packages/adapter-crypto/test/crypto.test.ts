import { describe, expect, it } from 'vitest';
import { createArgon2Hasher, createNodeOpaqueTokens } from '../src/index.ts';

// Спека 012, 4.7: параметры argon2id и формат непрозрачных токенов.

const PREFIX = '$argon2id$v=19$m=19456,t=2,p=1$';
const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe('createArgon2Hasher', () => {
  const hasher = createArgon2Hasher();

  it('AC-012-23: хэши одного пароля разные, оба с параметрами 4.7; верный пароль — true, неверный и битая строка — false', async () => {
    const password = 'correct horse battery';
    const first = await hasher.hash(password);
    const second = await hasher.hash(password);

    expect(first).not.toBe(second);
    expect(first.startsWith(PREFIX)).toBe(true);
    expect(second.startsWith(PREFIX)).toBe(true);

    expect(await hasher.verify(first, password)).toBe(true);
    expect(await hasher.verify(first, 'wrong horse battery')).toBe(false);
    expect(await hasher.verify('not-a-phc-string', password)).toBe(false);
  });
});

describe('createNodeOpaqueTokens', () => {
  const tokens = createNodeOpaqueTokens();

  it('AC-012-24: 1000 токенов уникальны, длиной 43 из base64url; hash — 64 hex и совпадает с hash(token)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const { token, hash } = tokens.create();
      expect(token).toHaveLength(43);
      expect(token).toMatch(BASE64URL);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).toBe(tokens.hash(token));
      seen.add(token);
    }
    expect(seen.size).toBe(1000);
  });
});
