-- SQLite schema for the conflict resolution engine.
-- Mirrors schema.postgres.sql in table/column shape; only type names differ.

-- append-only raw event log (source of truth for replay)
create table if not exists events (
  id                text primary key,             -- uuid, generated in app code
  dedupe_key        text unique not null,          -- hash(agent_id, document_id, timestamp, event_type, facts)
  agent_id          text not null,
  document_id       text not null,
  event_type        text not null check (event_type in ('summary','metadata','extraction')),
  event_timestamp   text not null,                 -- ISO 8601; ordering key
  received_at       text not null,                 -- when we got it (audit only, never used for ordering logic)
  confidence_score  real not null check (confidence_score >= 0 and confidence_score <= 1),
  facts             text not null,                 -- JSON array [{key, value}]
  created_at        text not null
);
create index if not exists idx_events_doc_ts on events (document_id, event_timestamp);

create table if not exists agents (
  agent_id     text primary key,
  trust_score  real not null check (trust_score >= 0 and trust_score <= 1),
  display_name text,
  updated_at   text not null
);

-- immutable, versioned, one row per (document_id, version)
create table if not exists document_states (
  document_id                 text not null,
  version                     integer not null,
  facts                       text not null,       -- JSON: {key: {value, source_agent_id, confidence, weight}}
  resolved_at                 text not null,
  conflict_resolution_notes   text not null,
  triggering_event_id         text references events(id),
  primary key (document_id, version)
);

-- append-only decision/audit trail (one row per decision, not just per event)
create table if not exists audit_log (
  id            text primary key,
  document_id   text not null,
  event_id      text references events(id),
  decision      text not null,      -- plain English, no enums
  created_at    text not null
);
create index if not exists idx_audit_doc on audit_log (document_id, created_at);

-- Defense in depth: events and audit_log are append-only at the application
-- layer already (no UPDATE/DELETE routes exposed); these triggers enforce it
-- at the database layer too, in case a future migration adds one by mistake.
create trigger if not exists trg_events_no_update
before update on events
begin
  select raise(abort, 'events is append-only: UPDATE is not permitted');
end;

create trigger if not exists trg_events_no_delete
before delete on events
begin
  select raise(abort, 'events is append-only: DELETE is not permitted');
end;

create trigger if not exists trg_audit_log_no_update
before update on audit_log
begin
  select raise(abort, 'audit_log is append-only: UPDATE is not permitted');
end;

create trigger if not exists trg_audit_log_no_delete
before delete on audit_log
begin
  select raise(abort, 'audit_log is append-only: DELETE is not permitted');
end;

create trigger if not exists trg_document_states_no_update
before update on document_states
begin
  select raise(abort, 'document_states is append-only: UPDATE is not permitted');
end;

create trigger if not exists trg_document_states_no_delete
before delete on document_states
begin
  select raise(abort, 'document_states is append-only: DELETE is not permitted');
end;
