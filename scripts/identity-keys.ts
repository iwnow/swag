// Спека 012, 4.11: выпуск ключа подписи токенов identity (npm run identity:keys).
// Без аргументов печатает пару ключей: base64 от PEM (PKCS8 для закрытого, SPKI для открытого), D-117.
// С --write-env [путь] пишет IDENTITY_JWT_PRIVATE_KEY и IDENTITY_JWT_PUBLIC_KEY в файл (по умолчанию .env в корне)
// и в консоль ключи не выводит (спека 024, 4.14).
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRIVATE_KEY = 'IDENTITY_JWT_PRIVATE_KEY';
const PUBLIC_KEY = 'IDENTITY_JWT_PUBLIC_KEY';
const DEFAULT_ENV = fileURLToPath(new URL('../.env', import.meta.url));

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privateB64 = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString(
  'base64',
);
const publicB64 = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString('base64');

function writeEnvVar(path: string, name: string, value: string): void {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(eol);
  const entry = `${name}=${value}`;
  const index = lines.findIndex((line) => line.startsWith(`${name}=`));
  if (index === -1) lines.push(entry);
  else lines[index] = entry;
  writeFileSync(path, `${lines.join(eol)}${eol}`);
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
  writeEnvVar(path, PUBLIC_KEY, publicB64);
  console.log(`${PRIVATE_KEY} и ${PUBLIC_KEY} записаны в ${path}`);
}
