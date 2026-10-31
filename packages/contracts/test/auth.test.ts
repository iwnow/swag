import { describe, expect, it } from 'vitest';
import { LoginRequest, OrganizationName, Password, RegistrationRequest } from '../src/index.ts';

describe('схемы регистрации и входа', () => {
  it('AC-012-1: email нормализуется, пароль 9 и 129 символов отклоняется, 10 — принимается, название из пробелов — ошибка', () => {
    expect(RegistrationRequest.parse({ email: '  Shop@Example.COM ' })).toEqual({
      email: 'shop@example.com',
    });
    expect(Password.safeParse('a'.repeat(9)).success).toBe(false);
    expect(Password.safeParse('a'.repeat(129)).success).toBe(false);
    expect(Password.safeParse('a'.repeat(10)).success).toBe(true);
    expect(OrganizationName.safeParse('   ').success).toBe(false);
    expect(LoginRequest.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false);
  });
});
