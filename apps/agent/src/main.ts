import { createRequire } from 'node:module';
import { runAgent } from './run.ts';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };
runAgent(version, (line) => console.log(line));
