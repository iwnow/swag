import { describe, expect, it } from 'vitest';
import { createMemorySecretStore, createMemorySwarmStore } from '@swag/adapter-memory';
import { createNodeRegistry } from '@swag/api-integration';
import { ROLE_PERMISSIONS, type Actor, type Role } from '@swag/contracts';
import { createApiCore, type ApiCore, type Logger, type Result } from '../src/index.ts';
import { fakeBilling } from './fake-billing.ts';

// Спека 026, 4.6 и REQ-026-8: операции секретов организации в ядре.
const ORG_A = '5a000000-0000-4000-8000-00000000000a';
const ORG_B = '5b000000-0000-4000-8000-00000000000b';
const USER_A = '10000000-0000-4000-8000-000000000001';
const ADMIN_A = '30000000-0000-4000-8000-000000000001';
const ADMIN_B = '30000000-0000-4000-8000-000000000002';
const SUPERVISOR = '40000000-0000-4000-8000-000000000001';

const FAKE_VALUE = 'fake-avito-token-1234567890';

const actorOf = (role: Role, userId: string, orgId: string | null): Actor => ({
  userId,
  orgId,
  role,
  permissions: ROLE_PERMISSIONS[role],
});
const ADMIN = actorOf('admin', ADMIN_A, ORG_A);
const ADMIN_OTHER = actorOf('admin', ADMIN_B, ORG_B);
const USER = actorOf('user', USER_A, ORG_A);
const SUP = actorOf('supervisor', SUPERVISOR, null);

const silentLog: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function makeCore(): ApiCore {
  const nodeTypes = createNodeRegistry([]);
  if (!nodeTypes.ok) throw new Error(nodeTypes.error.code);
  return createApiCore({
    version: 'test',
    store: createMemorySwarmStore(),
    orchestrator: { launch: async () => undefined, stop: async () => undefined },
    billing: fakeBilling(),
    secrets: createMemorySecretStore(),
    clock: { now: () => '2026-10-22T10:00:00.000Z' },
    ids: { uuid: () => '00000000-0000-4000-8000-000000000001' },
    log: silentLog,
    trace: { currentTraceId: () => null },
    nodeTypes: nodeTypes.registry,
    limits: { maxActiveSwarms: 3, maxBudgetMicroUsd: 5000000, maxTokens: 65536 },
  });
}

const codeOf = (result: Result<unknown>): string => (result.ok ? 'ok' : result.error.code);

describe('секреты организации в api-core', () => {
  it('REQ-026-8: администратор кладёт секрет, видит его в списке без значения и удаляет', async () => {
    const core = makeCore();
    const put = await core.putSecret(ADMIN, 'avito_token', { value: FAKE_VALUE });
    expect(put.ok).toBe(true);
    if (!put.ok) return;
    expect(Object.keys(put.value).sort()).toEqual(['hint', 'name', 'updatedAt']);
    expect(put.value).toMatchObject({ name: 'avito_token', hint: '7890' });
    expect(JSON.stringify(put)).not.toContain(FAKE_VALUE);

    const listed = await core.listSecrets(ADMIN);
    expect(listed.ok && listed.value.items.map((item) => item.name)).toEqual(['avito_token']);
    expect(JSON.stringify(listed)).not.toContain(FAKE_VALUE);

    expect(codeOf(await core.deleteSecret(ADMIN, 'avito_token'))).toBe('ok');
    const after = await core.listSecrets(ADMIN);
    expect(after.ok && after.value.items).toEqual([]);
  });

  it('REQ-026-8: повторное удаление того же секрета — not_found', async () => {
    const core = makeCore();
    await core.putSecret(ADMIN, 'avito_token', { value: FAKE_VALUE });
    await core.deleteSecret(ADMIN, 'avito_token');
    expect(codeOf(await core.deleteSecret(ADMIN, 'avito_token'))).toBe('not_found');
  });

  it('REQ-026-8: пользователь организации получает forbidden во всех трёх операциях', async () => {
    const core = makeCore();
    await core.putSecret(ADMIN, 'avito_token', { value: FAKE_VALUE });
    expect(codeOf(await core.listSecrets(USER))).toBe('forbidden');
    expect(codeOf(await core.putSecret(USER, 'avito_token', { value: FAKE_VALUE }))).toBe(
      'forbidden',
    );
    expect(codeOf(await core.deleteSecret(USER, 'avito_token'))).toBe('forbidden');
  });

  it('REQ-026-8: супервизор без организации и без secret.manage получает forbidden', async () => {
    const core = makeCore();
    expect(codeOf(await core.listSecrets(SUP))).toBe('forbidden');
    expect(codeOf(await core.putSecret(SUP, 'avito_token', { value: FAKE_VALUE }))).toBe(
      'forbidden',
    );
    expect(codeOf(await core.deleteSecret(SUP, 'avito_token'))).toBe('forbidden');
  });

  it('REQ-026-8: администратор другой организации не видит секрет первой и не может его удалить', async () => {
    const core = makeCore();
    await core.putSecret(ADMIN, 'avito_token', { value: FAKE_VALUE });
    const foreign = await core.listSecrets(ADMIN_OTHER);
    expect(foreign.ok && foreign.value.items).toEqual([]);
    expect(codeOf(await core.deleteSecret(ADMIN_OTHER, 'avito_token'))).toBe('not_found');
    const own = await core.listSecrets(ADMIN);
    expect(own.ok && own.value.items.map((item) => item.name)).toEqual(['avito_token']);
  });

  it('REQ-026-8: неверное имя или тело — invalid_request, секрет не записан', async () => {
    const core = makeCore();
    expect(codeOf(await core.putSecret(ADMIN, 'Bad Name', { value: FAKE_VALUE }))).toBe(
      'invalid_request',
    );
    expect(codeOf(await core.putSecret(ADMIN, 'avito_token', { value: '' }))).toBe(
      'invalid_request',
    );
    expect(
      codeOf(await core.putSecret(ADMIN, 'avito_token', { value: FAKE_VALUE, extra: 1 })),
    ).toBe('invalid_request');
    expect(codeOf(await core.putSecret(ADMIN, 'avito_token', FAKE_VALUE))).toBe('invalid_request');
    const listed = await core.listSecrets(ADMIN);
    expect(listed.ok && listed.value.items).toEqual([]);
  });

  it('REQ-026-8: удаление по неверному имени — not_found (трактовка 4.6)', async () => {
    const core = makeCore();
    expect(codeOf(await core.deleteSecret(ADMIN, 'Bad Name'))).toBe('not_found');
  });
});
