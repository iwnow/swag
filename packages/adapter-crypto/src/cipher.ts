import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Спека 026, 4.5: шифр секретов организации. Раскладка blob: iv (12) || tag (16) || шифротекст.
export interface SecretCipher {
  encrypt(plaintext: string, aad: string): Uint8Array; // AES-256-GCM, случайный iv 12 байт
  decrypt(blob: Uint8Array, aad: string): string; // неверный ключ, aad или подмена — исключение
}

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function parseKeyBase64(keyBase64: string, name: string): Buffer {
  const key = BASE64.test(keyBase64) ? Buffer.from(keyBase64, 'base64') : Buffer.alloc(0);
  if (key.length !== KEY_BYTES) throw new Error(`${name}: ключ должен быть 32 байта в base64`);
  return key;
}

export function createAesGcmCipher(keyBase64: string): SecretCipher {
  const key = parseKeyBase64(keyBase64, 'SECRETS_KEY');
  return {
    encrypt(plaintext, aad) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      cipher.setAAD(Buffer.from(aad, 'utf8'));
      const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), data]));
    },
    decrypt(blob, aad) {
      if (blob.length < IV_BYTES + TAG_BYTES) throw new Error('secret blob: короткий blob');
      const buffer = Buffer.from(blob);
      const decipher = createDecipheriv(ALGORITHM, key, buffer.subarray(0, IV_BYTES));
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(buffer.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([
        decipher.update(buffer.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
