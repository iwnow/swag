-- Up Migration
create table org_balances (
  org_id uuid primary key,
  balance_micro_usd bigint not null default 0 check (balance_micro_usd >= 0),
  held_micro_usd bigint not null default 0 check (held_micro_usd >= 0),
  check (held_micro_usd <= balance_micro_usd)
);
create table balance_entries (
  id bigserial primary key,
  org_id uuid not null,
  ts timestamptz not null,
  kind text not null check (kind in ('topup', 'swarm')),
  amount_micro_usd bigint not null,
  swarm_id uuid unique,
  actor_id uuid,
  comment text,
  check ((kind = 'topup' and amount_micro_usd > 0 and swarm_id is null)
      or (kind = 'swarm' and amount_micro_usd <= 0 and swarm_id is not null and actor_id is null)),
  check (kind <> 'topup' or actor_id is not null)
);
create index balance_entries_org_idx on balance_entries (org_id, id desc);
create table balance_holds (
  swarm_id uuid primary key,
  org_id uuid not null,
  amount_micro_usd bigint not null check (amount_micro_usd > 0),
  created_at timestamptz not null
);
-- Down Migration
drop table balance_holds;
drop table balance_entries;
drop table org_balances;
