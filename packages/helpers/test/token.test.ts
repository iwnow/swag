import { describe, expect, it } from 'vitest';
import { bearerMatches, tokenMatches } from '../src/server/index.ts';

const TOKEN = 'fake-orchestrator-token-for-tests-000000';

describe('tokenMatches и bearerMatches', () => {
  it('AC-024-22: верный Bearer — true; без заголовка, без схемы Bearer, с другим токеном и другой длиной — false', () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(undefined, TOKEN)).toBe(false);
    expect(bearerMatches(`Token ${TOKEN}`, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN.slice(1)}`, TOKEN)).toBe(false);
    expect(bearerMatches('Bearer ', TOKEN)).toBe(false);
  });

  it('AC-024-22: tokenMatches сравнивает байты; разная длина отказывает без сравнения', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches('', TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN.toUpperCase(), TOKEN)).toBe(false);
  });
});
