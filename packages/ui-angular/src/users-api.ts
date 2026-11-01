import type {
  InvitationRequest,
  ManagedUser,
  OrganizationList,
  UserList,
  UserUpdate,
} from '@swag/contracts';
import type { OrganizationsApi, UsersApi } from '@swag/ui-core';
import { createRequest, type RequestSession } from './http.ts';

// Спека 014, 4.3: порты админки и супервизора; эндпоинты — спека 024, 4.7.
export function createUsersApi(session: RequestSession): UsersApi {
  const request = createRequest(session, '/auth');
  return {
    list: (orgId) =>
      request<UserList>(
        'GET',
        orgId === null ? '/users' : `/users?orgId=${encodeURIComponent(orgId)}`,
      ),
    invite: (body: InvitationRequest) => request<void>('POST', '/invitations', body),
    update: (id, body: UserUpdate) =>
      request<ManagedUser>('PATCH', `/users/${encodeURIComponent(id)}`, body),
  };
}

export function createOrganizationsApi(session: RequestSession): OrganizationsApi {
  const request = createRequest(session, '/auth');
  return {
    list: () => request<OrganizationList>('GET', '/organizations'),
  };
}
