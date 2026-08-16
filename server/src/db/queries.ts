import { getDb } from './client';
import type { AgentRecord, EventRecord, Fact } from '../resolution/types';

interface EventRow {
  id: string;
  dedupe_key: string;
  agent_id: string;
  document_id: string;
  event_type: string;
  event_timestamp: string;
  received_at: string;
  confidence_score: number;
  facts: string;
  created_at: string;
}

interface AgentRow {
  agent_id: string;
  trust_score: number;
  display_name: string | null;
  updated_at: string;
}

export interface DocumentStateRow {
  document_id: string;
  version: number;
  facts: string;
  resolved_at: string;
  conflict_resolution_notes: string;
  triggering_event_id: string | null;
}

export interface AuditLogRow {
  id: string;
  document_id: string;
  event_id: string | null;
  decision: string;
  created_at: string;
}

function rowToEventRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    agentId: row.agent_id,
    documentId: row.document_id,
    eventType: row.event_type as EventRecord['eventType'],
    eventTimestamp: row.event_timestamp,
    confidenceScore: row.confidence_score,
    facts: JSON.parse(row.facts) as Fact[],
  };
}

function rowToAgentRecord(row: AgentRow): AgentRecord {
  return { agentId: row.agent_id, trustScore: row.trust_score, displayName: row.display_name };
}

export function getAllAgents(): AgentRecord[] {
  const rows = getDb().prepare<[], AgentRow>('select * from agents').all();
  return rows.map(rowToAgentRecord);
}

export function getEventsForDocument(documentId: string): EventRecord[] {
  const rows = getDb()
    .prepare<[string], EventRow>('select * from events where document_id = ?')
    .all(documentId);
  return rows.map(rowToEventRecord);
}

export function getEventByDedupeKey(dedupeKey: string): EventRecord | undefined {
  const row = getDb()
    .prepare<[string], EventRow>('select * from events where dedupe_key = ?')
    .get(dedupeKey);
  return row ? rowToEventRecord(row) : undefined;
}

export function insertEventRow(input: {
  id: string;
  dedupeKey: string;
  agentId: string;
  documentId: string;
  eventType: string;
  eventTimestamp: string;
  receivedAt: string;
  confidenceScore: number;
  facts: Fact[];
  createdAt: string;
}): void {
  getDb()
    .prepare(
      `insert into events
        (id, dedupe_key, agent_id, document_id, event_type, event_timestamp, received_at, confidence_score, facts, created_at)
       values (@id, @dedupeKey, @agentId, @documentId, @eventType, @eventTimestamp, @receivedAt, @confidenceScore, @facts, @createdAt)`
    )
    .run({ ...input, facts: JSON.stringify(input.facts) });
}

export function getLatestDocumentState(documentId: string): DocumentStateRow | undefined {
  return getDb()
    .prepare<[string], DocumentStateRow>(
      'select * from document_states where document_id = ? order by version desc limit 1'
    )
    .get(documentId);
}

export function getDocumentStateAtVersion(documentId: string, version: number): DocumentStateRow | undefined {
  return getDb()
    .prepare<[string, number], DocumentStateRow>(
      'select * from document_states where document_id = ? and version = ?'
    )
    .get(documentId, version);
}

export function getNextVersion(documentId: string): number {
  const row = getDb()
    .prepare<[string], { maxVersion: number | null }>(
      'select max(version) as maxVersion from document_states where document_id = ?'
    )
    .get(documentId);
  return (row?.maxVersion ?? 0) + 1;
}

export function insertDocumentStateRow(row: {
  documentId: string;
  version: number;
  facts: unknown;
  resolvedAt: string;
  conflictResolutionNotes: string;
  triggeringEventId: string | null;
}): void {
  getDb()
    .prepare(
      `insert into document_states
        (document_id, version, facts, resolved_at, conflict_resolution_notes, triggering_event_id)
       values (@documentId, @version, @facts, @resolvedAt, @conflictResolutionNotes, @triggeringEventId)`
    )
    .run({ ...row, facts: JSON.stringify(row.facts) });
}

export function insertAuditLogRow(row: {
  id: string;
  documentId: string;
  eventId: string | null;
  decision: string;
  createdAt: string;
}): void {
  getDb()
    .prepare(
      `insert into audit_log (id, document_id, event_id, decision, created_at)
       values (@id, @documentId, @eventId, @decision, @createdAt)`
    )
    .run(row);
}

export function getAuditLogPage(
  documentId: string,
  page: number,
  limit: number
): { rows: AuditLogRow[]; total: number } {
  const db = getDb();
  const total = (
    db
      .prepare<[string], { count: number }>('select count(*) as count from audit_log where document_id = ?')
      .get(documentId) ?? { count: 0 }
  ).count;
  const rows = db
    .prepare<[string, number, number], AuditLogRow>(
      'select * from audit_log where document_id = ? order by created_at asc, id asc limit ? offset ?'
    )
    .all(documentId, limit, (page - 1) * limit);
  return { rows, total };
}
