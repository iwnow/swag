import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PASSWORD,
  addMember,
  bearerOf,
  closeHarnessesAfterEach,
  loginAs,
  makeHarness,
  registerAndConfirm,
  type Harness,
} from './support.ts';

closeHarnessesAfterEach();

const SUPERVISOR = { email: 'supervisor@example.com', password: PASSWORD };
const ORG_A = 'Орг А';
const ORG_B = 'Орг Б';

interface Session {
  accessToken: string;
  user: { id: string; orgId: string | null };
  organization: { id: string } | null;
}

async function session(h: Harness, email: string, organizationName: string): Promise<Session> {
  const confirmed = await registerAndConfirm(h, email, organizationName, PASSWORD);
  return confirmed.json<Session>();
}

// Общая настройка: две организации (A — администратор и пользователь, B — администратор) и супервизор.
async function twoOrganizations(h: Harness) {
  const adminA = await session(h, 'a@example.com', ORG_A);
  const memberA = (await addMember(h, adminA.accessToken, 'user-a@example.com')).json<Session>();
  const adminB = await session(h, 'b@example.com', ORG_B);
  const supervisor = (await loginAs(h, SUPERVISOR.email)).json<Session>();
  return { adminA, memberA, adminB, supervisor };
}

const listUsers = (h: Harness, accessToken: string | undefined, query = '') =>
  h.app.inject({
    method: 'GET',
    url: `/auth/users${query}`,
    headers: accessToken === undefined ? {} : bearerOf(accessToken),
  });

const patchUser = (h: Harness, accessToken: string | undefined, id: string, payload: unknown) =>
  h.app.inject({
    method: 'PATCH',
    url: `/auth/users/${id}`,
    headers: accessToken === undefined ? {} : bearerOf(accessToken),
    payload: payload as object,
  });

describe('GET /auth/users', () => {
  it('AC-024-8: admin видит только свою организацию при любом orgId; user — 403; supervisor — все или одну по orgId', async () => {
    const h = await makeHarness({ supervisor: SUPERVISOR });
    const { adminA, memberA, adminB, supervisor } = await twoOrganizations(h);
    const emailsOf = (body: { users: { email: string }[] }) => body.users.map((u) => u.email);
    const orgA = adminA.organization?.id ?? '';
    const orgB = adminB.organization?.id ?? '';

    const admin = await listUsers(h, adminA.accessToken, `?orgId=${orgB}`);
    expect(admin.statusCode).toBe(200);
    expect(emailsOf(admin.json())).toEqual(['a@example.com', 'user-a@example.com']);

    const member = await listUsers(h, memberA.accessToken);
    expect(member.statusCode).toBe(403);
    expect(member.json()).toMatchObject({ error: { code: 'forbidden' } });

    const all = await listUsers(h, supervisor.accessToken);
    expect(all.statusCode).toBe(200);
    expect(emailsOf(all.json())).toEqual([
      'a@example.com',
      'b@example.com',
      'supervisor@example.com',
      'user-a@example.com',
    ]);

    const one = await listUsers(h, supervisor.accessToken, `?orgId=${orgA}`);
    expect(emailsOf(one.json())).toEqual(['a@example.com', 'user-a@example.com']);

    expect((await listUsers(h, undefined)).statusCode).toBe(401);
  });
});

describe('PATCH /auth/users/:id', () => {
  it('AC-024-11: admin меняет пользователя своей организации — 200 ManagedUser; чужой и несуществующий — 404; себе и супервизору — 403; пустое тело — 400; user — 403; supervisor любой организации — 200', async () => {
    const h = await makeHarness({ supervisor: SUPERVISOR });
    const { adminA, memberA, adminB, supervisor } = await twoOrganizations(h);
    const memberB = (await addMember(h, adminB.accessToken, 'user-b@example.com')).json<Session>();
    const memberBId = memberB.user.id;
    const memberAId = memberA.user.id;

    const own = await patchUser(h, adminA.accessToken, memberAId, { blocked: false });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ id: memberAId, role: 'user', blocked: false });

    expect((await patchUser(h, adminA.accessToken, memberBId, { blocked: true })).statusCode).toBe(
      404,
    );
    expect(
      (await patchUser(h, adminA.accessToken, randomUUID(), { blocked: true })).statusCode,
    ).toBe(404);
    expect(
      (await patchUser(h, adminA.accessToken, adminA.user.id, { role: 'user' })).statusCode,
    ).toBe(403);
    expect(
      (await patchUser(h, adminA.accessToken, supervisor.user.id, { blocked: true })).statusCode,
    ).toBe(403);
    expect((await patchUser(h, adminA.accessToken, memberAId, {})).statusCode).toBe(400);
    expect((await patchUser(h, memberA.accessToken, memberAId, { blocked: true })).statusCode).toBe(
      403,
    );
    expect((await patchUser(h, undefined, memberAId, { blocked: true })).statusCode).toBe(401);

    const bySupervisor = await patchUser(h, supervisor.accessToken, memberBId, { role: 'admin' });
    expect(bySupervisor.statusCode).toBe(200);
    expect(bySupervisor.json()).toMatchObject({ id: memberBId, role: 'admin' });
  });
});

describe('GET /auth/organizations', () => {
  it('AC-024-12: supervisor — 200 со всеми организациями и верным userCount; admin и user — 403', async () => {
    const h = await makeHarness({ supervisor: SUPERVISOR });
    const { adminA, memberA, supervisor } = await twoOrganizations(h);
    const list = (accessToken: string | undefined) =>
      h.app.inject({
        method: 'GET',
        url: '/auth/organizations',
        headers: accessToken === undefined ? {} : bearerOf(accessToken),
      });

    const response = await list(supervisor.accessToken);
    expect(response.statusCode).toBe(200);
    const organizations = response.json<{ organizations: { name: string; userCount: number }[] }>()
      .organizations;
    expect(organizations.map((o) => [o.name, o.userCount])).toEqual([
      [ORG_A, 2],
      [ORG_B, 1],
    ]);

    expect((await list(adminA.accessToken)).statusCode).toBe(403);
    expect((await list(memberA.accessToken)).statusCode).toBe(403);
    expect((await list(undefined)).statusCode).toBe(401);
  });
});
