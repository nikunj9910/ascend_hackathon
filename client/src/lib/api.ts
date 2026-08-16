export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:4000';

export type FactValue = string | number | boolean | null;

export interface Fact {
  key: string;
  value: FactValue;
}

export interface EventSubmission {
  agent_id: string;
  document_id: string;
  event_type: 'summary' | 'metadata' | 'extraction';
  event_timestamp: string;
  confidence_score: number;
  facts: Fact[];
}

export interface ResolvedFact {
  value: FactValue;
  sourceAgentId: string | null;
  confidence: number;
  weight: number;
}

export interface DocumentState {
  document_id: string;
  version: number;
  facts: Record<string, ResolvedFact>;
  resolved_at: string;
  conflict_resolution_notes: string;
  note?: string;
}

export interface AuditEntry {
  id: string;
  event_id: string | null;
  decision: string;
  created_at: string;
}

export interface AuditPage {
  document_id: string;
  page: number;
  limit: number;
  total: number;
  has_more: boolean;
  entries: AuditEntry[];
}

export interface ReplayDocumentResult {
  document_id: string;
  inserted_count?: number;
  duplicate_count?: number;
  version?: number;
  facts: Record<string, ResolvedFact>;
  resolved_at: string;
  conflict_resolution_notes: string;
}

export interface ReplayResponse {
  persisted: boolean;
  documents: ReplayDocumentResult[];
}

export class ApiError extends Error {
  status: number;
  details?: { path: string; message: string }[];

  constructor(status: number, message: string, details?: { path: string; message: string }[]) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function parseJsonOrThrow<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, body.error ?? `Request failed with status ${res.status}`, body.details);
  }
  return body as T;
}

export function submitEvent(apiKey: string, payload: EventSubmission): Promise<DocumentState> {
  return fetch(`${API_BASE_URL}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify(payload),
  }).then((res) => parseJsonOrThrow<DocumentState>(res));
}

export function getDocumentState(documentId: string, version?: number): Promise<DocumentState> {
  const query = version !== undefined ? `?version=${version}` : '';
  return fetch(`${API_BASE_URL}/documents/${encodeURIComponent(documentId)}/state${query}`).then((res) =>
    parseJsonOrThrow<DocumentState>(res)
  );
}

export function getAudit(documentId: string, page = 1, limit = 50): Promise<AuditPage> {
  return fetch(`${API_BASE_URL}/documents/${encodeURIComponent(documentId)}/audit?page=${page}&limit=${limit}`).then(
    (res) => parseJsonOrThrow<AuditPage>(res)
  );
}

export function replayEvents(events: EventSubmission[], persist: boolean, apiKey?: string): Promise<ReplayResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (persist && apiKey) headers['X-API-Key'] = apiKey;
  return fetch(`${API_BASE_URL}/events/replay`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ events, persist }),
  }).then((res) => parseJsonOrThrow<ReplayResponse>(res));
}
