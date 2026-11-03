import { defineNode } from '@swag/node-sdk';
import { z } from 'zod';

// Спека 033, 4.4: процесс как шаг графа; платформа разворачивает его в узлы до исполнения.
export default defineNode({
  type: 'swag/process',
  version: '1.0.0',
  kind: 'program',
  title: 'Процесс',
  description:
    'Сохранённый процесс организации как шаг графа. Разворачивается платформой в узлы процесса, не исполняется в песочнице.',
  settings: z.strictObject({ processId: z.uuid() }),
  inputs: z.unknown(),
  outputs: z.unknown(),
  execute: async () => {
    throw new Error('swag/process is expanded by the platform');
  },
});
