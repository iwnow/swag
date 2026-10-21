import { describe, expect, it } from 'vitest';
import { ServiceInfo } from '../src/index.ts';

describe('ServiceInfo', () => {
  it('принимает валидный объект и отклоняет неизвестный сервис', () => {
    expect(ServiceInfo.parse({ service: 'api', version: '1.0.0' })).toEqual({
      service: 'api',
      version: '1.0.0',
    });
    expect(ServiceInfo.safeParse({ service: 'ui', version: '1.0.0' }).success).toBe(false);
    expect(ServiceInfo.safeParse({ service: 'api', version: '' }).success).toBe(false);
  });
});
