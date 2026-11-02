-- Up Migration
create table org_secrets (
  org_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  ciphertext bytea not null,         -- iv (12 байт) || tag (16 байт) || шифротекст
  hint text null,
  updated_at timestamptz not null,
  updated_by uuid not null references users(id),
  primary key (org_id, name)
);

create table node_state (
  org_id uuid not null references organizations(id) on delete cascade,
  state_key text not null,
  key text not null,
  value text not null,
  updated_at timestamptz not null,
  primary key (org_id, state_key, key)
);
-- Down Migration
drop table node_state;
drop table org_secrets;
