import { randomUUID } from 'node:crypto';
import { getDb } from './client';
import * as queries from './queries';
import type { DocumentStateRow } from './queries';
import { resolve } from '../resolution/resolve';
import { computeDedupeKey } from '../resolution/canonicalize';
import type { Fact } from '../resolution/types';

export interface EventInput {
  agentId: string;
  documentId: string;
  eventType: string;
  eventTimestamp: string;
  confidenceScore: number;
  facts: Fact[];
}

/** Maps the wire-format (snake_case) submission shape to the internal EventInput shape. */
export function fromSubmission(body: {
  agent_id: string;
  document_id: string;
  event_type: string;
  event_timestamp: string;
  confidence_score: number;
  facts: Fact[];
}): EventInput {
  return {
    agentId: body.agent_id,
    documentId: body.document_id,
    eventType: body.event_type,
    eventTimestamp: body.event_timestamp,
    confidenceScore: body.confidence_score,
    facts: body.facts,
  };
}

/**
 * A single event's facts array asserting two different values for the same
 * key has no resolution rule to fall back on (resolution only decides
 * between different *events*, never between two facts inside one event) —
 * this is the structurally-valid-but-irreconcilable case in CLAUDE.md §7.
 */
export function findDuplicateFactKeys(facts: Fact[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const fact of facts) {
    if (seen.has(fact.key)) duplicates.add(fact.key);
    seen.add(fact.key);
  }
  return [...duplicates].sort();
}

interface InsertResult {
  inserted: boolean;
  eventId: string;
  isLateArrival: boolean;
}

/** Idempotent insert: a dedupe_key collision means this exact event was already accepted. */
function insertEventIfNew(input: EventInput): InsertResult {
  const dedupeKey = computeDedupeKey(input);
  const existing = queries.getEventByDedupeKey(dedupeKey);
  if (existing) {
    return { inserted: false, eventId: existing.id, isLateArrival: false };
  }

  const priorEvents = queries.getEventsForDocument(input.documentId);
  const isLateArrival = priorEvents.some((e) => e.eventTimestamp > input.eventTimestamp);

  const id = randomUUID();
  const now = new Date().toISOString();
  queries.insertEventRow({
    id,
    dedupeKey,
    agentId: input.agentId,
    documentId: input.documentId,
    eventType: input.eventType,
    eventTimestamp: input.eventTimestamp,
    receivedAt: now,
    confidenceScore: input.confidenceScore,
    facts: input.facts,
    createdAt: now,
  });

  return { inserted: true, eventId: id, isLateArrival };
}

/**
 * Re-resolves a document from ALL of its persisted events (never just the
 * triggering one) and writes one new immutable document_states version plus
 * one audit_log row per decision — the summary line, and one line per
 * contested fact key from resolve()'s notes.
 */
function resolveAndPersist(
  documentId: string,
  decision: { triggeringEventId: string | null; summary: string }
): DocumentStateRow {
  const events = queries.getEventsForDocument(documentId);
  const agents = queries.getAllAgents();
  const resolved = resolve(documentId, events, agents);
  const version = queries.getNextVersion(documentId);

  queries.insertDocumentStateRow({
    documentId,
    version,
    facts: resolved.facts,
    resolvedAt: resolved.asOfTimestamp,
    conflictResolutionNotes: resolved.conflictResolutionNotes,
    triggeringEventId: decision.triggeringEventId,
  });

  const now = new Date().toISOString();
  queries.insertAuditLogRow({
    id: randomUUID(),
    documentId,
    eventId: decision.triggeringEventId,
    decision: `${decision.summary} This produced document state version ${version}.`,
    createdAt: now,
  });
  for (const line of resolved.conflictResolutionNotes.split('\n')) {
    queries.insertAuditLogRow({
      id: randomUUID(),
      documentId,
      eventId: decision.triggeringEventId,
      decision: line,
      createdAt: now,
    });
  }

  return queries.getDocumentStateAtVersion(documentId, version)!;
}

export interface AcceptResult {
  status: 'created' | 'duplicate';
  eventId: string;
  isLateArrival: boolean;
  state: DocumentStateRow;
}

/**
 * Accepts one event: insert (or detect duplicate) + resolve + persist, all
 * inside a single synchronous SQLite transaction (CLAUDE.md §3 — ingestion
 * writes directly to the DB inside a transaction, no queue).
 */
export function acceptEvent(input: EventInput): AcceptResult {
  const db = getDb();
  const run = db.transaction((): AcceptResult => {
    const { inserted, eventId, isLateArrival } = insertEventIfNew(input);

    if (!inserted) {
      const state = queries.getLatestDocumentState(input.documentId);
      if (!state) {
        throw new Error(
          `Invariant violated: duplicate event ${eventId} exists but document ${input.documentId} has no resolved state.`
        );
      }
      return { status: 'duplicate', eventId, isLateArrival: false, state };
    }

    const lateNote = isLateArrival
      ? ' This event arrived out of order: its timestamp is earlier than other already-recorded events for this document, so it was slotted into its correct temporal position and triggered a full recomputation of the resolved state.'
      : '';
    const summary = `Event ${eventId} from agent ${input.agentId} (event_type ${input.eventType}, confidence ${input.confidenceScore}) was accepted for document ${input.documentId} at ${input.eventTimestamp}.${lateNote}`;

    const state = resolveAndPersist(input.documentId, { triggeringEventId: eventId, summary });
    return { status: 'created', eventId, isLateArrival, state };
  });

  return run();
}

export interface BatchResult {
  insertedCount: number;
  duplicateCount: number;
  state: DocumentStateRow | undefined;
}

/**
 * Used by POST /events/replay when persist:true. Inserts every new event in
 * the batch (grouped by document_id) inside one transaction, then performs
 * ONE resolution pass per affected document — not one version per event —
 * so a replayed batch produces a single readable new version rather than
 * replaying the whole version history. Still calls the exact same resolve()
 * used by acceptEvent(), so live ingestion and replay never diverge.
 */
export function acceptEventsBatch(inputs: EventInput[]): Map<string, BatchResult> {
  const db = getDb();
  const byDocument = new Map<string, EventInput[]>();
  for (const input of inputs) {
    if (!byDocument.has(input.documentId)) byDocument.set(input.documentId, []);
    byDocument.get(input.documentId)!.push(input);
  }

  const results = new Map<string, BatchResult>();

  const run = db.transaction(() => {
    for (const [documentId, docInputs] of byDocument) {
      let insertedCount = 0;
      let duplicateCount = 0;
      let anyLate = false;

      for (const input of docInputs) {
        const { inserted, isLateArrival } = insertEventIfNew(input);
        if (inserted) {
          insertedCount++;
          if (isLateArrival) anyLate = true;
        } else {
          duplicateCount++;
        }
      }

      let state = queries.getLatestDocumentState(documentId);
      if (insertedCount > 0) {
        const lateNote = anyLate
          ? ' At least one event in this batch arrived out of order and was slotted into its correct temporal position.'
          : '';
        const summary = `Replay batch for document ${documentId}: ${insertedCount} new event(s) inserted, ${duplicateCount} duplicate event(s) skipped.${lateNote}`;
        state = resolveAndPersist(documentId, { triggeringEventId: null, summary });
      }

      results.set(documentId, { insertedCount, duplicateCount, state });
    }
  });

  run();
  return results;
}
