-- Up Migration
create table organizations (
  id uuid primary key,
  name text not null check (length(name) between 1 and 200),
  created_at timestamptz not null
);
create table users (
  id uuid primary key,
  email text not null unique,
  password_hash text not null,
  role text not null check (role in ('user', 'admin', 'supervisor')),
  org_id uuid references organizations (id),
  created_at timestamptz not null,
  check ((role = 'supervisor') = (org_id is null))
);
create table email_confirmations (
  token_hash text primary key,
  email text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null
);
create table sessions (
  id uuid primary key,
  user_id uuid not null references users (id),
  refresh_hash text not null unique,
  previous_hash text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null
);
create index sessions_previous_hash on sessions (previous_hash);

-- Down Migration
drop table sessions;
drop table email_confirmations;
drop table users;
drop table organizations;
