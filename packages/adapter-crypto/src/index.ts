import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { OpaqueTokens, PasswordHasher } from '@swag/identity-core';

// Спека 012, 4.7: адаптеры хэша пароля и непрозрачных токенов.

// Минимум OWASP Password Storage Cheat Sheet для argon2id; параметры не понижать (NFR-012-1).
// algorithm: 2 — Algorithm.Argon2id; const enum из пакета не доступен при verbatimModuleSyntax.
const ARGON2_OPTIONS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

export function createArgon2Hasher(): PasswordHasher {
  return {
    hash: (password) => hash(password, ARGON2_OPTIONS),
    verify: async (hashed, password) => {
      try {
        return await verify(hashed, password);
      } catch {
        return false;
      }
    },
  };
}

export function createNodeOpaqueTokens(): OpaqueTokens {
  return {
    create() {
      const token = randomBytes(32).toString('base64url');
      return { token, hash: sha256Hex(token) };
    },
    hash: sha256Hex,
  };
}
