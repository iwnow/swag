import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJoseSigner, createJoseVerifier, publicKeyFromPrivate } from '@swag/adapter-jose';
import { afterEach, describe, expect, it } from 'vitest';
import { createFixture } from './fixture.ts';

// Спека 012, 4.11: npm run identity:keys. Пишет только во временные файлы, настоящий .env не трогает.

const SCRIPT = fileURLToPath(new URL('./identity-keys.ts', import.meta.url));
const PRIVATE_LINE = /^IDENTITY_JWT_PRIVATE_KEY=([A-Za-z0-9+/]+={0,2})$/;

let remove = () => {};
afterEach(() => remove());

function run(args: string[] = []) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const valueOf = (name: string, text: string): string =>
  text.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]?.trim() ?? '';
const privateValue = (text: string): string => valueOf('IDENTITY_JWT_PRIVATE_KEY', text);
const publicValue = (text: string): string => valueOf('IDENTITY_JWT_PUBLIC_KEY', text);
const pemOf = (base64: string): string => Buffer.from(base64, 'base64').toString('utf8');

describe('identity:keys', () => {
  it('4.11: без аргументов печатает пару Ed25519: base64 от PEM (PKCS8 и SPKI)', () => {
    const { code, stdout } = run();
    expect(code).toBe(0);
    const [privateLine, publicLine, extra] = stdout.trimEnd().split('\n');
    expect(extra).toBeUndefined();
    expect(privateLine).toMatch(PRIVATE_LINE);
    expect(publicLine).toMatch(/^IDENTITY_JWT_PUBLIC_KEY=[A-Za-z0-9+/]+={0,2}$/);

    const privatePem = pemOf(privateValue(stdout));
    const publicPem = pemOf(publicValue(stdout));
    expect(privatePem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(publicPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(createPrivateKey(privatePem).asymmetricKeyType).toBe('ed25519');
    expect(createPublicKey(publicPem).asymmetricKeyType).toBe('ed25519');
  });

  it('AC-012-2: ключ из identity:keys подписывает и проверяется adapter-jose', async () => {
    const { stdout } = run();
    const privateKeyPem = pemOf(privateValue(stdout));
    const publicKeyPem = pemOf(publicValue(stdout));
    expect(publicKeyFromPrivate(privateKeyPem)).toBe(publicKeyPem);

    const signer = createJoseSigner({ privateKeyPem, kid: 'test' });
    const verifier = createJoseVerifier({ publicKeyPem, kid: 'test' });
    const now = Math.floor(Date.now() / 1000);
    const token = await signer.sign({
      sub: randomUUID(),
      org: randomUUID(),
      role: 'admin',
      iss: 'swag-identity',
      aud: 'swag',
      iat: now,
      exp: now + 900,
    });
    expect(await verifier.verify(token)).not.toBeNull();
  });

  it('4.11: --write-env во временный файл создаёт строку IDENTITY_JWT_PRIVATE_KEY и не печатает ключ', () => {
    const fixture = createFixture({});
    remove = fixture.remove;
    const path = join(fixture.root, '.env');

    const { code, stdout } = run(['--write-env', path]);
    expect(code).toBe(0);
    expect(stdout).not.toContain(privateValue(readFileSync(path, 'utf8')));
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(PRIVATE_LINE);
  });

  it('4.11: --write-env заменяет пустую строку ключа на месте, остальные переменные сохраняет, повтор не дублирует строку', () => {
    const fixture = createFixture({
      '.env': 'IDENTITY_PORT=3003\r\nIDENTITY_JWT_PRIVATE_KEY=\r\nIDENTITY_JWT_KID=dev-1\r\n',
    });
    remove = fixture.remove;
    const path = join(fixture.root, '.env');

    run(['--write-env', path]);
    const first = readFileSync(path, 'utf8');
    run(['--write-env', path]);
    const second = readFileSync(path, 'utf8');

    expect(first.split('\r\n')).toEqual([
      'IDENTITY_PORT=3003',
      expect.stringMatching(PRIVATE_LINE),
      'IDENTITY_JWT_KID=dev-1',
      '',
    ]);
    expect(second.match(/^IDENTITY_JWT_PRIVATE_KEY=/gm)).toHaveLength(1);
    expect(second).not.toBe(first);
    expect(second).toContain('IDENTITY_JWT_KID=dev-1');
  });

  it('4.11: --write-env дописывает строку в файл без неё', () => {
    const fixture = createFixture({ '.env': 'IDENTITY_PORT=3003' });
    remove = fixture.remove;
    const path = join(fixture.root, '.env');

    run(['--write-env', path]);
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    expect(lines[0]).toBe('IDENTITY_PORT=3003');
    expect(lines[1]).toMatch(PRIVATE_LINE);
  });
});
