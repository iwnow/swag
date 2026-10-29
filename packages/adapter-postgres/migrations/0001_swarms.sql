-- Up Migration
create table swarms (
  id uuid primary key,
  status text not null,
  created_at timestamptz not null,
  last_seq integer not null,
  view jsonb not null
);
create index swarms_created_at_idx on swarms (created_at desc);
create table swarm_events (
  swarm_id uuid not null references swarms (id) on delete cascade,
  seq integer not null,
  event jsonb not null,
  primary key (swarm_id, seq)
);
-- Down Migration
drop table swarm_events;
drop table swarms;
