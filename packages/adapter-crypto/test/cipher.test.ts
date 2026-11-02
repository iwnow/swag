import { describe, expect, it } from 'vitest';
import { createAesGcmCipher } from '../src/index.ts';

// Спека 026, 4.5: шифр секретов организации. Ключи в тестах — явно фейковые.
const KEY = Buffer.alloc(32, 1).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 2).toString('base64');
const VALUE = 'fake-secret-value-0123456789';

describe('createAesGcmCipher', () => {
  it('AC-026-5: расшифровка верной AAD возвращает значение; чужая AAD, другой ключ и подмена байта — исключение', () => {
    const cipher = createAesGcmCipher(KEY);
    const blob = cipher.encrypt(VALUE, 'org1:key');

    expect(cipher.decrypt(blob, 'org1:key')).toBe(VALUE);
    expect(() => cipher.decrypt(blob, 'org2:key')).toThrow();
    expect(() => createAesGcmCipher(OTHER_KEY).decrypt(blob, 'org1:key')).toThrow();

    const tampered = new Uint8Array(blob);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    expect(() => cipher.decrypt(tampered, 'org1:key')).toThrow();
  });

  it('AC-026-5: два шифрования одного значения дают разные blob; раскладка — iv 12 байт, tag 16 байт, затем данные', () => {
    const cipher = createAesGcmCipher(KEY);
    const first = cipher.encrypt(VALUE, 'org1:key');
    const second = cipher.encrypt(VALUE, 'org1:key');

    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false);
    expect(first.length).toBe(12 + 16 + Buffer.byteLength(VALUE));
  });

  it('AC-026-5: ключ не 32 байта или не base64 — createAesGcmCipher бросает', () => {
    expect(() => createAesGcmCipher(Buffer.alloc(16, 1).toString('base64'))).toThrow();
    expect(() => createAesGcmCipher('не base64 !!! мусор')).toThrow();
  });
});
