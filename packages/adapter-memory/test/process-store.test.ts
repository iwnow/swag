import { createMemoryProcessStore } from '../src/index.ts';
import { processStoreCases } from './process-store.cases.ts';

processStoreCases('memory', () => createMemoryProcessStore());
