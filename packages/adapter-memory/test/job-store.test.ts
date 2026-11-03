import { createMemoryJobStore } from '../src/index.ts';
import { jobStoreCases } from './job-store.cases.ts';

jobStoreCases('memory', () => createMemoryJobStore());
