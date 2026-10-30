-- Up Migration
create table swarm_budgets (
  swarm_id uuid primary key,
  budget_micro_usd bigint not null check (budget_micro_usd > 0),
  spent_micro_usd bigint not null default 0 check (spent_micro_usd >= 0),
  held_micro_usd bigint not null default 0 check (held_micro_usd >= 0),
  created_at timestamptz not null,
  expires_at timestamptz,
  closed_at timestamptz
);
create table swarm_agents (
  swarm_id uuid not null references swarm_budgets (swarm_id) on delete cascade,
  agent_id text not null,
  model text not null,
  budget_micro_usd bigint check (budget_micro_usd > 0),
  spent_micro_usd bigint not null default 0 check (spent_micro_usd >= 0),
  held_micro_usd bigint not null default 0 check (held_micro_usd >= 0),
  primary key (swarm_id, agent_id)
);
create table budget_holds (
  call_id uuid primary key,
  swarm_id uuid not null references swarm_budgets (swarm_id) on delete cascade,
  agent_id text not null,
  amount_micro_usd bigint not null check (amount_micro_usd >= 0),
  created_at timestamptz not null
);
create table ledger_entries (
  call_id uuid primary key,
  ts timestamptz not null,
  kind text not null check (kind in ('llm')),
  swarm_id uuid not null,
  agent_id text not null,
  model text not null,
  amount_micro_usd bigint not null check (amount_micro_usd >= 0),
  basis text not null check (basis in ('usage', 'estimate', 'none')),
  provider_cost_micro_usd bigint check (provider_cost_micro_usd >= 0)
);
create index ledger_entries_swarm_idx on ledger_entries (swarm_id);
create index ledger_entries_ts_idx on ledger_entries (ts);
create table model_prices (
  open_router_model text primary key,
  input_per_mtok_usd numeric(9, 4) not null check (input_per_mtok_usd >= 0),
  cached_input_per_mtok_usd numeric(9, 4) not null check (cached_input_per_mtok_usd >= 0),
  output_per_mtok_usd numeric(9, 4) not null check (output_per_mtok_usd >= 0),
  updated_at timestamptz not null
);
-- Down Migration
drop table model_prices;
drop table ledger_entries;
drop table budget_holds;
drop table swarm_agents;
drop table swarm_budgets;
