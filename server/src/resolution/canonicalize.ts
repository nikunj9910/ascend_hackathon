import { createHash } from 'node:crypto';
import type { EventRecord, Fact, FactValue } from './types';

/**
 * Deterministic comparator for events: event_timestamp ASC, then agent_id
 * ASC, then dedupe_key ASC. Never compares on received_at / array position —
 * that would make resolution depend on arrival order, which breaks replay.
 */
export function compareEventsCanonically(a: EventRecord, b: EventRecord): number {
  if (a.eventTimestamp !== b.eventTimestamp) {
    return a.eventTimestamp < b.eventTimestamp ? -1 : 1;
  }
  if (a.agentId !== b.agentId) {
    return a.agentId < b.agentId ? -1 : 1;
  }
  if (a.dedupeKey !== b.dedupeKey) {
    return a.dedupeKey < b.dedupeKey ? -1 : 1;
  }
  return 0;
}

export function sortEventsCanonically(events: EventRecord[]): EventRecord[] {
  return [...events].sort(compareEventsCanonically);
}

/**
 * Stable JSON stringify: object keys are sorted recursively so the same
 * logical value always produces the same string, regardless of insertion
 * order (JS object/map iteration order must never leak into anything hashed
 * or compared for determinism).
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

/**
 * Canonicalizes a facts array (sorted by key, so submission order within an
 * event never affects the dedupe key) before hashing.
 */
function canonicalizeFacts(facts: Fact[]): Array<{ key: string; value: FactValue }> {
  return [...facts]
    .map((f) => ({ key: f.key, value: f.value }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * dedupe_key = hash(agent_id, document_id, timestamp, event_type, facts).
 * Submitting byte-different-but-semantically-identical JSON (reordered
 * fields/facts) must still hash the same, hence canonicalization.
 */
export function computeDedupeKey(input: {
  agentId: string;
  documentId: string;
  eventTimestamp: string;
  eventType: string;
  facts: Fact[];
}): string {
  const canonical = canonicalStringify({
    agentId: input.agentId,
    documentId: input.documentId,
    eventTimestamp: input.eventTimestamp,
    eventType: input.eventType,
    facts: canonicalizeFacts(input.facts),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
