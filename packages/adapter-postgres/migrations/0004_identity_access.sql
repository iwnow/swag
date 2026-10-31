-- Up Migration
alter table users add column blocked_at timestamptz;
alter table users add column tokens_valid_after timestamptz;
create index users_tokens_valid_after on users (tokens_valid_after) where tokens_valid_after is not null;
create table invitations (
  token_hash text primary key,
  email text not null,
  org_id uuid not null references organizations (id),
  role text not null check (role in ('user', 'admin')),
  invited_by uuid not null references users (id),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null
);

-- Down Migration
drop table invitations;
drop index users_tokens_valid_after;
alter table users drop column tokens_valid_after;
alter table users drop column blocked_at;
