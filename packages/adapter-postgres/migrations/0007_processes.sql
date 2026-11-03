-- Up Migration
create table processes (
  id uuid primary key,
  org_id uuid not null references organizations (id),
  created_by uuid not null references users (id),
  definition jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index processes_org_idx on processes (org_id, updated_at desc);

create table scheduler_jobs (
  process_id uuid primary key, -- без внешнего ключа: processes принадлежит api
  spec jsonb not null,
  enabled boolean not null,
  disabled_reason text null,
  cursor text null,
  next_run_at timestamptz null,
  lease_until timestamptz null,
  last_poll_at timestamptz null,
  last_error jsonb null,
  consecutive_failures integer not null,
  updated_at timestamptz not null
);
create index scheduler_jobs_due_idx on scheduler_jobs (next_run_at) where enabled;

create table process_runs (
  id uuid primary key,
  process_id uuid not null references scheduler_jobs (process_id) on delete cascade,
  org_id uuid not null,
  status text not null,
  reason text null,
  source text not null,
  event jsonb null,
  created_at timestamptz not null,
  launched_at timestamptz null,
  finished_at timestamptz null
);
create index process_runs_queue_idx on process_runs (created_at) where status = 'queued';
create index process_runs_process_idx on process_runs (process_id, created_at desc);

-- Down Migration
drop table process_runs;
drop table scheduler_jobs;
drop table processes;
