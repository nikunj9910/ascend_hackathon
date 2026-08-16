import { useState } from 'react';
import { ApiError, submitEvent, type DocumentState, type EventSubmission, type FactValue } from '../lib/api';

interface FactRow {
  key: string;
  value: string;
  type: 'string' | 'number' | 'boolean' | 'null';
}

function coerceFactValue(row: FactRow): FactValue {
  switch (row.type) {
    case 'number':
      return Number(row.value);
    case 'boolean':
      return row.value === 'true';
    case 'null':
      return null;
    default:
      return row.value;
  }
}

function nowAsIso(): string {
  return new Date().toISOString();
}

export default function Submit({ apiKey }: { apiKey: string }) {
  const [agentId, setAgentId] = useState('agent-alpha');
  const [documentId, setDocumentId] = useState('doc-demo-1');
  const [eventType, setEventType] = useState<EventSubmission['event_type']>('extraction');
  const [eventTimestamp, setEventTimestamp] = useState(nowAsIso());
  const [confidenceScore, setConfidenceScore] = useState(0.8);
  const [facts, setFacts] = useState<FactRow[]>([{ key: '', value: '', type: 'string' }]);

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<DocumentState | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);

  function updateFact(index: number, patch: Partial<FactRow>) {
    setFacts((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }

  function addFactRow() {
    setFacts((prev) => [...prev, { key: '', value: '', type: 'string' }]);
  }

  function removeFactRow(index: number) {
    setFacts((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);
    setError(null);

    const payload: EventSubmission = {
      agent_id: agentId,
      document_id: documentId,
      event_type: eventType,
      event_timestamp: eventTimestamp,
      confidence_score: confidenceScore,
      facts: facts.filter((f) => f.key.trim() !== '').map((f) => ({ key: f.key, value: coerceFactValue(f) })),
    };

    try {
      const state = await submitEvent(apiKey, payload);
      setResult(state);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <h1>Submit an event</h1>
      <p className="page-intro">
        Submit one agent's interpretation of a document. Submitting the same event twice is a no-op; two agents
        disagreeing on the same fact key triggers weighted conflict resolution — see the result below.
      </p>

      {!apiKey && (
        <div className="callout error">
          No API key set. Paste the demo key from <code>server/.env</code> into the field at the top right — write
          endpoints require it.
        </div>
      )}

      <form className="card" onSubmit={handleSubmit}>
        <div className="field-row">
          <div className="field">
            <label htmlFor="agent-id">agent_id</label>
            <input id="agent-id" value={agentId} onChange={(e) => setAgentId(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="document-id">document_id</label>
            <input id="document-id" value={documentId} onChange={(e) => setDocumentId(e.target.value)} required />
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="event-type">event_type</label>
            <select id="event-type" value={eventType} onChange={(e) => setEventType(e.target.value as EventSubmission['event_type'])}>
              <option value="extraction">extraction</option>
              <option value="summary">summary</option>
              <option value="metadata">metadata</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="event-timestamp">event_timestamp (ISO 8601 UTC)</label>
            <input id="event-timestamp" value={eventTimestamp} onChange={(e) => setEventTimestamp(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="confidence">confidence_score (0–1)</label>
            <input
              id="confidence"
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={confidenceScore}
              onChange={(e) => setConfidenceScore(Number(e.target.value))}
              required
            />
          </div>
        </div>

        <div className="field">
          <label>facts</label>
          <div className="facts-list">
            {facts.map((fact, i) => (
              <div className="fact-row" key={i}>
                <input placeholder="key" value={fact.key} onChange={(e) => updateFact(i, { key: e.target.value })} />
                {fact.type === 'boolean' ? (
                  <select value={fact.value} onChange={(e) => updateFact(i, { value: e.target.value })}>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    placeholder="value"
                    value={fact.value}
                    disabled={fact.type === 'null'}
                    onChange={(e) => updateFact(i, { value: e.target.value })}
                  />
                )}
                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  <select value={fact.type} onChange={(e) => updateFact(i, { type: e.target.value as FactRow['type'] })}>
                    <option value="string">string</option>
                    <option value="number">number</option>
                    <option value="boolean">boolean</option>
                    <option value="null">null</option>
                  </select>
                  <button type="button" className="ghost" onClick={() => removeFactRow(i)} disabled={facts.length === 1}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: '0.5rem' }}>
            <button type="button" className="secondary" onClick={addFactRow}>
              + Add fact
            </button>
          </div>
        </div>

        <div style={{ marginTop: '1rem' }}>
          <button type="submit" disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit event'}
          </button>
        </div>
      </form>

      {error && (
        <div className="callout error">
          {error instanceof ApiError ? (
            <>
              <strong>
                {error.status}: {error.message}
              </strong>
              {error.details && (
                <ul>
                  {error.details.map((d, i) => (
                    <li key={i}>
                      {d.path}: {d.message}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            error.message
          )}
        </div>
      )}

      {result && (
        <div className="card">
          <h2>
            Resolved state — document <code>{result.document_id}</code>, version {result.version}
          </h2>
          {result.note && <p className="muted">{result.note}</p>}
          <pre className="json-view">{JSON.stringify(result.facts, null, 2)}</pre>
          <p>
            <strong>Resolution notes:</strong>
          </p>
          <p className="audit-decision">{result.conflict_resolution_notes}</p>
        </div>
      )}
    </>
  );
}
