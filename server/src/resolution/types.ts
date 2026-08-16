/**
 * A single fact assertion's value. Kept to JSON scalars — extracted document
 * facts (totals, dates, names, flags) never need richer shapes, and scalars
 * are what make weighted-average and equality-based grouping well-defined.
 */
export type FactValue = string | number | boolean | null;

export interface Fact {
  key: string;
  value: FactValue;
}

export type EventType = 'summary' | 'metadata' | 'extraction';

/**
 * The shape resolve() consumes. Mirrors the `events` table row shape but is
 * intentionally decoupled from it — resolve() has zero I/O and must not
 * import anything from src/db.
 */
export interface EventRecord {
  id: string;
  dedupeKey: string;
  agentId: string;
  documentId: string;
  eventType: EventType;
  eventTimestamp: string; // ISO 8601 — the sole ordering key
  confidenceScore: number; // 0..1
  facts: Fact[];
}

export interface AgentRecord {
  agentId: string;
  trustScore: number; // 0..1
  displayName?: string | null;
}

export type ResolutionMode = 'highest-weight' | 'weighted-average';

export interface FactKeyConfig {
  mode: ResolutionMode;
  /** Half-life for recency decay, in milliseconds. Overrides defaultHalfLifeMs for this key. */
  halfLifeMs?: number;
}

export interface ResolutionConfig {
  defaultMode: ResolutionMode;
  /** Default half-life for recency decay, in milliseconds, when a key has no override. */
  defaultHalfLifeMs: number;
  perKey?: Record<string, FactKeyConfig>;
}

export interface ResolvedFactValue {
  value: FactValue;
  /** null when the value is a weighted-average of multiple agents' numbers. */
  sourceAgentId: string | null;
  confidence: number;
  weight: number;
}

export interface ResolvedState {
  facts: Record<string, ResolvedFactValue>;
  /** The effective timestamp resolution was computed as of (deterministic, never wall-clock). */
  asOfTimestamp: string;
  /** Plain-English explanation of every contested key's outcome. No enums. */
  conflictResolutionNotes: string;
}
