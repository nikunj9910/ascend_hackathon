-- Postgres schema for the conflict resolution engine (optional alternate path,
-- see docker-compose.yml). Table/column shape is identical to schema.sqlite.sql;
-- only type names differ (text -> timestamptz/jsonb where it matters).

create table if not exists events (
  id                text primary key,
  dedupe_key        text unique not null,
  agent_id          text not null,
  document_id       text not null,
  event_type        text not null check (event_type in ('summary','metadata','extraction')),
  event_timestamp   timestamptz not null,
  received_at       timestamptz not null,
  confidence_score  real not null check (confidence_score >= 0 and confidence_score <= 1),
  facts             jsonb not null,
  created_at        timestamptz not null
);
create index if not exists idx_events_doc_ts on events (document_id, event_timestamp);

create table if not exists agents (
  agent_id     text primary key,
  trust_score  real not null check (trust_score >= 0 and trust_score <= 1),
  display_name text,
  updated_at   timestamptz not null
);

create table if not exists document_states (
  document_id                 text not null,
  version                     integer not null,
  facts                       jsonb not null,
  resolved_at                 timestamptz not null,
  conflict_resolution_notes   text not null,
  triggering_event_id         text references events(id),
  primary key (document_id, version)
);

create table if not exists audit_log (
  id            text primary key,
  document_id   text not null,
  event_id      text references events(id),
  decision      text not null,
  created_at    timestamptz not null
);
create index if not exists idx_audit_doc on audit_log (document_id, created_at);

-- Defense in depth: reject UPDATE/DELETE on append-only tables at the DB layer.
create or replace function reject_mutation() returns trigger as $$
begin
  raise exception '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP;
end;
$$ language plpgsql;

drop trigger if exists trg_events_no_update on events;
create trigger trg_events_no_update before update on events
  for each row execute function reject_mutation();
drop trigger if exists trg_events_no_delete on events;
create trigger trg_events_no_delete before delete on events
  for each row execute function reject_mutation();

drop trigger if exists trg_audit_log_no_update on audit_log;
create trigger trg_audit_log_no_update before update on audit_log
  for each row execute function reject_mutation();
drop trigger if exists trg_audit_log_no_delete on audit_log;
create trigger trg_audit_log_no_delete before delete on audit_log
  for each row execute function reject_mutation();

drop trigger if exists trg_document_states_no_update on document_states;
create trigger trg_document_states_no_update before update on document_states
  for each row execute function reject_mutation();
drop trigger if exists trg_document_states_no_delete on document_states;
create trigger trg_document_states_no_delete before delete on document_states
  for each row execute function reject_mutation();
