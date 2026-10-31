// Спека 012, 4.11: выпуск ключа подписи токенов identity (npm run identity:keys).
// Без аргументов печатает пару ключей. С --write-env [путь] пишет IDENTITY_JWT_PRIVATE_KEY в файл
// (по умолчанию .env в корне) и в консоль закрытый ключ не выводит.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRIVATE_KEY = 'IDENTITY_JWT_PRIVATE_KEY';
const PUBLIC_KEY = 'IDENTITY_JWT_PUBLIC_KEY';
const DEFAULT_ENV = fileURLToPath(new URL('../.env', import.meta.url));

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privateB64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const publicB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function writeEnvVar(path: string, name: string, value: string): void {
  const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const line = new RegExp(`^${name}=.*$`, 'm');
  const next = line.test(content)
    ? content.replace(line, `${name}=${value}`)
    : `${content}${content === '' || content.endsWith('\n') ? '' : eol}${name}=${value}${eol}`;
  writeFileSync(path, next);
}

const argv = process.argv.slice(2);
const writeIndex = argv.indexOf('--write-env');

if (writeIndex === -1) {
  console.log(`${PRIVATE_KEY}=${privateB64}`);
  console.log(`${PUBLIC_KEY}=${publicB64}`);
} else {
  const next = argv[writeIndex + 1];
  const path = next && !next.startsWith('--') ? resolve(next) : DEFAULT_ENV;
  writeEnvVar(path, PRIVATE_KEY, privateB64);
  console.log(`${PRIVATE_KEY} записан в ${path}`);
}
