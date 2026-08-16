# Real-Time Agentic RAG Conflict Resolution Engine

A deterministic, replayable, auditable conflict-resolution engine for multi-agent document
intelligence. Multiple agents submit interpretations (facts) of the same document over time;
the engine merges those interpretations into one authoritative, versioned state per document
using rule-based logic — no ML, no LLM calls, no embeddings, anywhere in the codebase — and can
reproduce any past state exactly by replaying its event log.

Everything runs on `localhost`. There is no cloud deployment, no external service, and no
internet dependency beyond `npm install`. The full design rationale and binding spec live in
[`CLAUDE.md`](CLAUDE.md).

## Architecture

| Layer    | Tech                                              | Runs at                |
| -------- | -------------------------------------------------- | ----------------------- |
| Backend  | Node.js + Express (TypeScript)                    | `http://localhost:4000` |
| Frontend | React + Vite (TypeScript)                          | `http://localhost:5173` |
| Database | SQLite (`better-sqlite3`), file-based, zero install | `server/data/engine.db` |

No queues, no cache layer, no message broker — ingestion writes directly to SQLite inside a
transaction, and a per-`document_id` in-process mutex (`server/src/security/locks.ts`) serializes
concurrent writes to the same document.

## Quickstart

Requires Node.js 22+. From a fresh clone:

```bash
npm install                          # installs root, server, and client dependencies
cp server/.env.example server/.env   # demo API key already works out of the box
npm run dev                          # starts Express on :4000 and Vite on :5173
```

Open `http://localhost:5173` for the UI, or in a second terminal:

```bash
npm run seed                         # posts every fixture through the real API,
                                      # prints the resulting state + audit trail,
                                      # and diffs each against its expected_state.json
```

Run the test suite (no manual DB setup — each test file creates and tears down its own
throwaway SQLite file):

```bash
npm test
```

That's the whole loop: clone → install → seed → see conflict resolution, replay, and audit
trails working, entirely offline.

## The demo API key

Write endpoints (`POST /events`, `POST /events/replay?persist=true`) require an `X-API-Key`
header. The default demo key, from `server/.env.example`:

```
demo-local-api-key-change-me
```

Paste it into the field at the top-right of the UI, or pass it as `X-API-Key` in curl. Read
endpoints (`GET .../state`, `GET .../audit`) and a dry-run replay never require it.

## API reference

Base URL: `http://localhost:4000`. All bodies are JSON; `Content-Type: application/json`.

### `POST /events` — submit one agent's interpretation

```bash
curl -s -X POST http://localhost:4000/events \
  -H "Content-Type: application/json" \
  -H "X-API-Key: demo-local-api-key-change-me" \
  -d '{
    "agent_id": "agent-alpha",
    "document_id": "doc-1",
    "event_type": "extraction",
    "event_timestamp": "2026-01-01T00:00:00.000Z",
    "confidence_score": 0.9,
    "facts": [{ "key": "title", "value": "Q1 Report" }]
  }'
```

- `201` on a newly accepted event; `200` if the exact same event was already recorded
  (idempotent, no-op — dedupe key is `hash(agent_id, document_id, event_timestamp, event_type, facts)`).
- `400` on schema-invalid payloads (field-level messages, never a stack trace).
- `409` if the event's own `facts` array asserts two different values for the same key — that's
  not resolvable by weight, since resolution only ever decides between different *events*.

### `POST /events/replay` — recompute state from an arbitrary event list

Dry run by default — computed purely from the events in the request body, never touching
persisted data:

```bash
curl -s -X POST http://localhost:4000/events/replay \
  -H "Content-Type: application/json" \
  -d '{
    "events": [
      { "agent_id": "agent-beta",  "document_id": "doc-1", "event_type": "extraction", "event_timestamp": "2026-01-02T00:00:00.000Z", "confidence_score": 0.4, "facts": [{ "key": "title", "value": "Q1 Financial Report" }] },
      { "agent_id": "agent-alpha", "document_id": "doc-1", "event_type": "extraction", "event_timestamp": "2026-01-01T00:00:00.000Z", "confidence_score": 0.9, "facts": [{ "key": "title", "value": "Q1 Report" }] }
    ]
  }'
```

Array order never matters — events are always sorted by `event_timestamp` internally. Pass
`"persist": true` (and the `X-API-Key` header — this is the one variant of replay that requires
it) to actually write the events and produce a new state version, exactly like `POST /events`
would, but as one batch:

```bash
curl -s -X POST http://localhost:4000/events/replay \
  -H "Content-Type: application/json" \
  -H "X-API-Key: demo-local-api-key-change-me" \
  -d '{ "persist": true, "events": [ /* ... */ ] }'
```

### `GET /documents/:id/state` — current or historical resolved state

```bash
curl -s http://localhost:4000/documents/doc-1/state
curl -s http://localhost:4000/documents/doc-1/state?version=1   # an earlier, still-immutable version
```

### `GET /documents/:id/audit` — full audit trail, paginated

```bash
curl -s "http://localhost:4000/documents/doc-1/audit?page=1&limit=50"
```

Every entry's `decision` is a plain English sentence — no invented enums like `ALLOWED` /
`DENIED` / `CONFLICT`.

## The conflict resolution algorithm

Implemented as a pure, zero-I/O function, `resolve()` in
[`server/src/resolution/resolve.ts`](server/src/resolution/resolve.ts), called identically by
live ingestion and by replay — the two paths can never drift.

1. Events for a document are sorted by `event_timestamp` (never insertion/arrival order), tied
   broken by `agent_id`, then `dedupe_key`.
2. For each fact key, each agent's **latest** (as of the resolution horizon) asserted value is a
   candidate — this is what makes partial updates safe: a later event that omits a key never
   clears that key's value from an earlier event.
3. Each candidate's weight is `trust_score(agent) × confidence_score(event) × recency_factor`,
   where `recency_factor` is an exponential half-life decay (`2^(-age/halfLife)`, configurable
   per fact key, default 30 days) — a function of the events' own timestamps, never wall-clock
   time.
4. Resolution mode is configured per fact key (`server/src/resolution/config.ts`) —
   `highest-weight` (candidates with the same value have their weights summed, i.e. corroborating
   agents' evidence adds up) or `weighted-average` (numeric keys only, with a documented
   fallback to `highest-weight` if a submitted value turns out non-numeric). Nothing here is
   keyed on a specific `agent_id` — there is no hardcoded favorite anywhere in this file.
5. A plain-English note is generated for every genuinely contested key, naming the agents
   involved, their trust/confidence/recency/weight, and the winner.

## Fixtures

`fixtures/*.json` — each an ordered array of event payloads — plus a matching
`*.expected_state.json` snapshot, captured from the real running server and independently
re-verified via a shuffled-order replay. `npm run seed` runs all five through the live API and
diffs the result; `server/tests/integration/fixtures.test.ts` runs the same comparison as part
of `npm test`.

1. **`01-duplicate-events`** — the exact same event submitted twice. The second submission must
   be a no-op: same version, same facts, no duplicate audit rows. Proves idempotency via the
   dedupe key.
2. **`02-late-out-of-order`** — a newer-timestamped event first, then an older-timestamped
   ("late") event from the same agent for the same key. The late event still gets slotted into
   its correct temporal position, produces a new state version, and the audit trail explains the
   correction — even though the resolved value doesn't change here, since the agent's own later
   real-world timestamp still wins.
3. **`03-conflicting-facts`** — two different agents assert different values for the same key at
   the same time. The higher-weight value wins, and the note names both agents' trust,
   confidence, recency, and weight.
4. **`04-low-trust-vs-high-confidence`** — a high-trust-but-low-confidence agent versus a
   low-trust-but-high-confidence agent. Demonstrates the weighting formula is never a single-field
   decision: here the math favors the low-trust, high-confidence submission.
5. **`05-partial-update`** — one agent submits two fact keys, then a later event from that same
   agent revises only one of them. The untouched key must remain exactly as it was.

## Frontend

Three pages, calling the API directly (no proxy):

- **Submit** (`/submit`) — manually submit an event with a dynamic, typed facts list; see the
  resulting resolved state and notes, or field-level validation errors.
- **Document** (`/document`) — look up a document's current or historical (`?version=N`)
  resolved state, plus its full paginated audit trail.
- **Replay** (`/replay`) — pick one of the five fixtures (loaded from the real `fixtures/*.json`
  files — no duplicated data), shuffle its event order, and run a dry-run or persisting replay to
  see the recomputed state without touching curl.

## Testing

```bash
npm test                # unit + integration + e2e, from the repo root or server/
```

54 tests across three layers:

- **Unit** (`server/tests/unit/`) — the resolution engine (determinism under shuffled input,
  temporal correctness, partial updates, tie-breaking, recency decay, weighted-average
  fallback) and the per-document mutex. Zero I/O, zero DB.
- **Integration** (`server/tests/integration/`) — every route, against the real Express app and
  a fresh throwaway SQLite file per test file: duplicate events, late/out-of-order arrival,
  conflicting facts, trust-score-vs-confidence weighting, replay/live parity under shuffled
  order, replay auth scoping, and immutable version history.
- **End-to-end** (`server/tests/e2e/judge-flow.test.ts`) — binds the real app to an actual TCP
  port and drives it with plain `fetch()` calls (not an in-process test client): starts the
  server, submits every fixture, fetches state and audit, and confirms determinism by running
  the same shuffled replay request twice and diffing the byte-identical output.

## Security (local-appropriate, still real)

- Write endpoints require `X-API-Key`; a missing/invalid key returns `401`. Read endpoints are
  open.
- Every payload is validated with `zod`; unknown fields are rejected; `express.json` is capped
  at 100KB; the `facts` array is capped at 50 entries.
- In-memory, per-IP rate limiting (`express-rate-limit`) on write endpoints — this is
  process-local and resets on server restart, which is fine for a local demo but worth knowing.
- All queries are parameterized prepared statements (`better-sqlite3`) — no string-built SQL.
- `helmet` for HTTP security headers; CORS locked to `http://localhost:5173`.
- `events`, `document_states`, and `audit_log` are append-only at the application layer (no
  UPDATE/DELETE routes exist) and additionally enforced with SQL triggers that reject
  UPDATE/DELETE at the database layer.
- No secrets are committed; `server/.env.example` documents every variable, `.env*` is
  gitignored.

## Optional: Postgres via `docker-compose`

```bash
docker-compose up -d postgres
```

This stands up a local Postgres 16 container and applies
[`server/src/db/schema.postgres.sql`](server/src/db/schema.postgres.sql) as an init script — the
same table/column shape as the SQLite schema, kept in sync (CI's non-blocking
`postgres-schema-parity` job re-applies it on every push to catch drift).

**Scope note:** this validates that the schema itself is valid, portable Postgres DDL. The
Express server in this repo talks to SQLite via `better-sqlite3` only and does not include a
second Postgres driver, so the app won't actually connect to this container — `docker-compose
up` is provided because CLAUDE.md calls for the optional path to exist, but full dual-backend
support wasn't built out for this submission. The required, zero-install default path (SQLite)
is unaffected either way.

## What this repo deliberately does not have

No ML/LLM calls, embeddings, or vector search anywhere in the codebase. No Kafka, Redis, or
other distributed infrastructure. No cloud deployment or managed service of any kind — every
component runs on `localhost`. No hardcoded per-agent preference anywhere in the resolution
logic. No MongoDB (SQL was chosen as the single persistence layer). No CD/deploy step in CI —
the pipeline proves correctness, it does not ship anywhere.
