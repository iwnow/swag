import { createAgentCore } from '@swag/agent-core';

export function runAgent(version: string, print: (line: string) => void): void {
  const info = createAgentCore({ version }).info();
  print(`node ${process.version}`);
  print(`${info.service} ${info.version}`);
  print(`${info.service} ok`);
}
