import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createNodeRegistry } from '@swag/api-integration';
import { AgentDraft } from '@swag/contracts';
import { toManifest } from '@swag/node-sdk';
import { describe, expect, it } from 'vitest';
import definition from '../src/node.ts';

const manifestFile = fileURLToPath(new URL('../swag-node.json', import.meta.url));
const REF = 'swag/llm-agent@1.0.0';

// Спека 021, 4.4: набор проверки REQ-021-10.
const ACCEPTED: unknown[] = [
  { name: 'a', role: 'b' },
  { name: 'a', role: 'b', model: 'chat-large', budgetMicroUsd: 1000, maxTokens: 2048 },
];
const REJECTED: unknown[] = [
  { name: '', role: 'b' },
  { name: 'a', role: 'b', x: 1 },
  { name: 'a', role: 'b', model: 'gpt' },
  { name: 'a', role: 'b', maxTokens: 0 },
  { role: 'b' },
];

describe('swag/llm-agent', () => {
  it('AC-021-15: swag-node.json совпадает с toManifest определения', () => {
    const manifest = JSON.parse(JSON.stringify(toManifest(definition)));
    expect(manifest).toEqual(JSON.parse(readFileSync(manifestFile, 'utf8')));
  });

  it('AC-021-9: AgentDraft.safeParse и validateSettings дают одинаковый итог на наборе 4.4', () => {
    const built = createNodeRegistry([toManifest(definition)]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const cases = [
      ...ACCEPTED.map((value) => ({ value, accepted: true })),
      ...REJECTED.map((value) => ({ value, accepted: false })),
    ];
    for (const { value, accepted } of cases) {
      const draft = AgentDraft.safeParse(value).success;
      const registry = built.registry.validateSettings(REF, value).ok;
      expect(draft, JSON.stringify(value)).toBe(accepted);
      expect(registry, JSON.stringify(value)).toBe(accepted);
    }
  });
});
