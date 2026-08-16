# CLAUDE.md — Real-Time Agentic RAG Conflict Resolution Engine

This file is the persistent source of truth for Claude (and any contributor) working in this
repository. Read it fully before writing code. When a decision here conflicts with a passing
whim in a prompt, this file wins unless the user explicitly overrides it in writing.

## 1. What we're building

A **deterministic, replayable, auditable conflict-resolution engine** for enterprise document
intelligence. Multiple agents submit interpretations (facts) of the same document over time.
The engine must merge those interpretations into one authoritative, versioned state per
document, using rule-based (not ML/LLM) logic, and must be able to reproduce any past state
exactly by replaying its event log.

Judges will clone the repo, run one setup command **entirely on their own machine**, and
expect to see conflict resolution, replay, and audit trails work correctly and deterministically
with no external services and no internet dependency beyond installing packages. Optimize for
that experience over cleverness.

## 2. Non-negotiable requirements (do not silently drop these)

- **Determinism**: identical input set + identical config ⇒ byte-identical resolved state.
  Never use wall-clock time, random IDs, `Date.now()`, or map/object key iteration order in
  the resolution algorithm. Canonicalize before hashing/comparing.
- **Idempotency**: submitting the same event twice must not change state or create duplicate
  audit rows. Dedupe key = `hash(agent_id, document_id, timestamp, event_type, facts)`.
- **Out-of-order / late arrival**: events are ordered by their **event timestamp**, not by
  arrival/insert time. A late event with an old timestamp must be replayed into its correct
  temporal position and can change the resolved state (with a new state version + note).
- **No universal winner**: never hardcode "prefer agent X". Resolution must be a function of
  `trust_score`, `confidence_score`, recency, and evidence weight — all config-driven.
- **Auditability**: every accepted event and every resolution decision is written to an
  append-only audit log with a human-readable English explanation (no invented enums like
  ALLOWED/DENIED/CONFLICT — plain sentences).
- **Replayability**: `POST /events/replay` must be able to take an arbitrary list of events in
  arbitrary order and reproduce the same final state as if they'd arrived in canonical order.
- **Rule-based only**: no LLM calls, no embeddings, no vector search, no external AI APIs,
  anywhere in the codebase — not just the resolution path. This is intentional — it's what
  makes the system deterministic and auditable.
- **Allowed tech only**: Python, JavaScript, Node.js, Express.js, React, FastAPI, MongoDB,
  SQL. Nothing outside this list — no Vercel, no Supabase, no other managed cloud service.
- **No Kafka, Redis, or distributed systems.**
- **No cloud deployment.** Every component — API, database, frontend — runs on `localhost`.
  The deliverable is a repo a judge runs locally, not a hosted URL.

## 3. Architecture decision (locked in)

Two local processes, no external services:

- **Backend**: **Node.js + Express.js** (TypeScript), running on `localhost:4000`. Plain REST
  JSON API. No serverless/edge framework — a normal long-running Express process, since there
  is no cloud target to shape it around.
- **Frontend**: **React** (Vite), running on `localhost:5173` in dev, calling the Express API
  directly (CORS restricted to `localhost` origins). `npm run build` produces a static bundle
  the Express server can optionally also serve at `/` for a single-process demo mode.
- **Database**: **SQL**, specifically **SQLite** via `better-sqlite3` as the zero-install
  default (a single file, `data/engine.db`, created on first run — nothing for a judge to
  install or configure). A `docker-compose.yml` with local Postgres is provided as an
  **optional** alternate path for anyone who wants to test against "real" Postgres; both are
  driven by the same SQL schema (kept Postgres-compatible so switching is a connection-string
  change, not a rewrite). MongoDB was considered but SQL was chosen for straightforward
  relational integrity on the versioned-state + audit-log tables; do not introduce Mongo
  alongside it — pick one persistence layer.
- **No queues, no cache layer, no message broker.** Ingestion writes directly to the DB inside
  a transaction; resolution runs synchronously in the request handler. Use a lightweight
  per-`document_id` in-process mutex (a simple `Map<string, Promise>` lock queue) to serialize
  writes to the same document and avoid race conditions — this replaces what a message queue
  would otherwise be used for, without introducing distributed infra.

```
/server
  /src
    index.ts                       Express app bootstrap
    /routes
      events.ts                    POST /events
      replay.ts                    POST /events/replay
      documents.ts                 GET /documents/:id/state, /documents/:id/audit
    /resolution
      canonicalize.ts               canonical ordering / hashing helpers
      resolve.ts                    pure resolution engine (no I/O, fully unit-testable)
      types.ts
    /db
      client.ts                     SQLite (or Postgres, via env var) connection
      schema.sql                    DDL, run on startup / via migration script
      queries.ts
    /validation
      schemas.ts                    zod schemas for all API payloads
    /security
      rateLimit.ts                  in-memory token bucket per IP
      auth.ts                       API-key check middleware for write routes
      locks.ts                      per-document_id mutex
  package.json
  tsconfig.json
/client                            React (Vite) app
  /src
    /pages
      DocumentView.tsx              state + audit viewer
      Submit.tsx                    manual event submission form
      Replay.tsx                    replay console
  package.json
/fixtures
  01-duplicate-events.json
  02-late-out-of-order.json
  03-conflicting-facts.json
  04-low-trust-vs-high-confidence.json
  05-partial-update.json
  (≥5 required by spec; see §6)
/scripts
  seed.ts                          loads fixtures through the real API for a full demo
/tests
  unit/resolve.test.ts
  integration/events.test.ts
  integration/replay.test.ts
  e2e/judge-flow.test.ts
/.github/workflows
  ci.yml                           lint + typecheck + test only, no deploy step
docker-compose.yml                 optional local Postgres alternative
.env.example
README.md
CLAUDE.md
MASTER_PROMPT.md
```

## 4. Data model (SQL — SQLite by default, Postgres-compatible)

```sql
-- append-only raw event log (source of truth for replay)
create table events (
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
create index idx_events_doc_ts on events (document_id, event_timestamp);

create table agents (
  agent_id     text primary key,
  trust_score  real not null check (trust_score >= 0 and trust_score <= 1),
  display_name text,
  updated_at   text not null
);

-- immutable, versioned, one row per (document_id, version)
create table document_states (
  document_id                 text not null,
  version                     integer not null,
  facts                       text not null,       -- JSON: {key: {value, source_agent_id, confidence, weight}}
  resolved_at                 text not null,
  conflict_resolution_notes   text not null,
  triggering_event_id         text references events(id),
  primary key (document_id, version)
);

-- append-only decision/audit trail (one row per decision, not just per event)
create table audit_log (
  id            text primary key,
  document_id   text not null,
  event_id      text references events(id),
  decision      text not null,      -- plain English, no enums
  created_at    text not null
);
```

Notes on SQLite vs. Postgres compatibility: use `text` for timestamps (ISO 8601 strings) and
JSON-as-text columns so the same DDL (with trivial type-name swaps: `text`→`timestamptz`/
`jsonb` for the Postgres variant in `docker-compose` mode) works on both. Keep two DDL files
(`schema.sqlite.sql`, `schema.postgres.sql`) if the type differences make a single file
awkward — but the table/column *shape* must stay identical either way.

No RLS/managed-cloud auth here (there is no cloud). Instead: the DB file/container is only
reachable on `localhost`, and the Express layer is the sole gatekeeper — see §8.

## 5. Conflict resolution algorithm (deterministic spec)

Implement as a **pure function** in `server/src/resolution/resolve.ts`:
`resolve(documentId, events[], agents[], asOfTimestamp?) -> ResolvedState`.

1. Filter events to `event_timestamp <= asOfTimestamp` (temporal consistency — "only consider
   events up to current time").
2. Sort deterministically: `event_timestamp ASC`, tie-break `agent_id ASC`, tie-break
   `dedupe_key ASC`. Never sort by `received_at`/insertion order.
3. Group by `facts[].key` across all events for the document.
4. For each key, compute a **weight** per candidate value:
   `weight = trust_score(agent) * confidence_score * recency_factor`, where
   `recency_factor` is a documented, deterministic function of how stale the event is relative
   to `asOfTimestamp` (e.g., linear decay over a configurable half-life) — not real wall-clock
   time.
5. Resolution mode is configurable per fact key (config file, not hardcoded per-agent):
   - `highest-weight`: pick the single value with the highest weight; ties broken by
     `agent_id` lexicographic order (documented, deterministic, arbitrary-but-fixed).
   - `weighted-average`: only valid for numeric fact values; weighted mean.
6. Write a plain-English `conflict_resolution_notes` string explaining exactly why each
   contested key resolved the way it did (agents involved, their weights, the winning value).
7. Support **partial updates**: an event with only some fact keys must not null out
   previously-resolved keys for other keys on the same document.
8. Increment `document_states.version` and insert a new immutable row — never update in place.

This function must have zero I/O so it can be unit tested exhaustively and reused identically
by both the live ingestion path and the `/events/replay` endpoint (replay must call the exact
same function — never a second, drifted copy of the logic).

## 6. Required fixtures (`/fixtures/*.json`, ≥5)

1. Duplicate event submitted twice → state unchanged, second insert is a no-op (idempotency).
2. Late/out-of-order event with an older `event_timestamp` arriving after newer ones →
   triggers a re-resolution and a new state version with a note explaining the correction.
3. Two agents extract conflicting values for the same fact key → resolved by weight, note
   explains why.
4. Low-trust-but-high-confidence agent vs. high-trust-but-low-confidence agent → demonstrates
   the weighting formula isn't a single-field decision.
5. Partial update — an agent submits only one fact key → other keys remain untouched.
Each fixture ships as an ordered JSON array of event payloads plus a `expected_state.json`
snapshot judges (and CI) can diff against.

## 7. API contract

- `POST /events` → 201 `{document_id, version, facts, resolved_at}` | 400 invalid payload
  (zod validation errors) | 409 only if the event is structurally valid but cannot be
  reconciled under current config (explain why in body — do not silently drop).
- `GET /documents/:id/state` → current resolved state (latest version).
- `GET /documents/:id/state?version=N` → historical version (nice-to-have, supports
  "time travel" bonus scope).
- `GET /documents/:id/audit` → full audit trail, paginated.
- `POST /events/replay` → body `{events: [...]}`, returns the final resolved state
  computed by replaying strictly on `event_timestamp`, regardless of array order in the
  request. Must be a **dry-run by default** (does not mutate persisted state) unless
  `{persist: true}` is explicitly passed — call this out clearly in the README so judges don't
  accidentally corrupt demo data.

All request/response bodies validated with `zod`; validation errors return field-level
messages, never a stack trace.

## 8. Security requirements (local-appropriate, still real)

Even though nothing is internet-facing, treat the local server as if it were — this is what
makes the security story credible to judges, and it's what you'd need on day one if this ever
did get deployed.

- Write endpoints (`POST /events`, `POST /events/replay?persist=true`) require a bearer token
  (`X-API-Key` header) checked against a value in `.env` (`.env.example` documents it with a
  placeholder). Read endpoints (`GET state`, `GET audit`) can be open for judges.
- Input validation on every endpoint via `zod`; reject unknown fields; enforce a max payload
  size (e.g., 100KB via `express.json({limit: '100kb'})`) and a max `facts` array length.
- In-memory token-bucket rate limiting on write endpoints (`express-rate-limit` or hand-rolled)
  — document in the README that this is process-local and resets on restart.
- Parameterized queries only (prepared statements via `better-pg`/`better-sqlite3` — no
  string-built SQL, ever).
- `helmet` for standard HTTP security headers; CORS locked to `http://localhost:5173` (the
  Vite dev origin) for write endpoints.
- No secrets committed; `.env.example` provided, `.env*` gitignored.
- Audit log and event log are append-only at the application layer (no UPDATE/DELETE routes
  exposed); optionally enforce this with SQL triggers that reject UPDATE/DELETE on `events`
  and `audit_log` as defense in depth.
- `npm audit --production` run in CI (see §9) — dependency hygiene even without a cloud
  deploy target.

## 9. CI pipeline (local-only — CI, not CD)

Because there is no cloud deployment target, the pipeline is **continuous integration only**:
it proves the code is correct and safe, it does not ship anywhere. `.github/workflows/ci.yml`
on every push/PR:
1. Install deps for both `/server` and `/client` (cached).
2. Lint (`eslint`) + typecheck (`tsc --noEmit`) for both.
3. `npm audit --production` (fail on high/critical).
4. Run DB setup: apply `schema.sqlite.sql` to a fresh throwaway SQLite file (no external
   service needed — this is the point of choosing SQLite as the default).
5. Unit tests (`server/tests/unit/resolve.ts` — no DB needed, pure functions).
6. Integration tests (`server/tests/integration`) against the throwaway SQLite file, covering
   exactly the spec's required list: duplicate events, late/out-of-order events, conflicting
   facts, replay, agent trust score impact, versioned state changes.
7. Build both `/server` and `/client` (`tsc`/`vite build`) to catch build-time errors.
8. (Optional, non-blocking job) spin up `docker-compose up -d postgres`, point the same
   integration suite at Postgres via env var, confirm parity — this is what proves the
   SQLite/Postgres schemas actually stay in sync, without making Postgres a hard requirement
   for the main pipeline.

No deploy job exists. If the user later decides to host this somewhere, that's a deliberate
future decision — do not add deployment steps speculatively.

## 10. Judge testability checklist

- One-command local run: `npm install` (root script fans out to `/server` and `/client`, or
  document both separately), then `npm run dev` starts Express on `:4000` and Vite on `:5173`
  concurrently (`concurrently` package). Zero external services required in default (SQLite)
  mode.
- `npm run seed` posts all `/fixtures/*.json` through the real running API and prints the
  resulting state + audit trail to stdout, so a judge can see the whole pipeline exercised
  without opening the UI.
- `npm test` runs the full suite (unit + integration) with no manual setup beyond
  `npm install` — the throwaway SQLite DB is created and torn down by the test runner itself.
- README includes: exact local URLs (`http://localhost:4000`, `http://localhost:5173`), curl
  examples for all 4 endpoints, the demo API key from `.env.example`, one paragraph per
  fixture explaining what it demonstrates and the expected outcome, and the optional
  `docker-compose up` Postgres path for anyone who wants to test that variant.
- The React UI's `/replay` page lets a judge paste/select a fixture and visually see the
  resolved state + notes without touching curl at all.

## 11. Explicit non-goals

- No ML/LLM/embeddings/vector search anywhere in the repo.
- No Kafka/Redis/message queues/distributed consensus.
- No cloud services of any kind — nothing runs anywhere but the judge's own machine.
- No hardcoded agent-preference logic.
- No mixing MongoDB and SQL — one persistence layer only (SQL, per §3).

## 12. When Claude Code works in this repo

- Prefer small, reviewable commits per component (schema → resolution engine → API →
  frontend → tests → CI → docs), each buildable/testable independently.
- Write the resolution engine and its unit tests before wiring up any API route.
- Never let the replay path and the live-ingestion path diverge — both call
  `server/src/resolution/resolve.ts`.
- Update this file if an architectural decision changes; don't let README and CLAUDE.md drift
  apart.