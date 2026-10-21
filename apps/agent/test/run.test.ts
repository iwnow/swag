import { describe, expect, it } from 'vitest';
import { runAgent } from '../src/run.ts';

describe('runAgent', () => {
  it('печатает версию Node и agent ok', () => {
    const lines: string[] = [];
    runAgent('1.2.3', (line) => lines.push(line));
    expect(lines).toEqual([`node ${process.version}`, 'agent 1.2.3', 'agent ok']);
  });
});
