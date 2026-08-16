import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError, getAudit, getDocumentState, type AuditPage, type DocumentState } from '../lib/api';

export default function DocumentView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [documentIdInput, setDocumentIdInput] = useState(searchParams.get('id') ?? '');
  const [state, setState] = useState<DocumentState | null>(null);
  const [audit, setAudit] = useState<AuditPage | null>(null);
  const [auditPage, setAuditPage] = useState(1);
  const [versionInput, setVersionInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(documentId: string, version?: number, page = 1) {
    if (!documentId.trim()) return;
    setLoading(true);
    setError(null);
    setState(null);
    setAudit(null);
    try {
      const [stateResult, auditResult] = await Promise.all([
        getDocumentState(documentId, version),
        getAudit(documentId, page),
      ]);
      setState(stateResult);
      setAudit(auditResult);
      setAuditPage(page);
      setSearchParams({ id: documentId });
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status}: ${err.message}` : (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    void load(documentIdInput, versionInput ? Number(versionInput) : undefined, 1);
  }

  return (
    <>
      <h1>Document state &amp; audit trail</h1>
      <p className="page-intro">
        View a document's current resolved state (or an earlier immutable version) and the full, plain-English audit
        trail of every decision that produced it.
      </p>

      <form className="card toolbar" onSubmit={handleLookup} style={{ marginBottom: '1.5rem' }}>
        <div className="field" style={{ flex: 1, minWidth: 200 }}>
          <label htmlFor="doc-id">document_id</label>
          <input id="doc-id" value={documentIdInput} onChange={(e) => setDocumentIdInput(e.target.value)} required />
        </div>
        <div className="field" style={{ width: 140 }}>
          <label htmlFor="doc-version">version (optional)</label>
          <input
            id="doc-version"
            type="number"
            min={1}
            placeholder="latest"
            value={versionInput}
            onChange={(e) => setVersionInput(e.target.value)}
          />
        </div>
        <div style={{ alignSelf: 'flex-end', marginBottom: '0.9rem' }}>
          <button type="submit" disabled={loading}>
            {loading ? 'Loading…' : 'Look up'}
          </button>
        </div>
      </form>

      {error && <div className="callout error">{error}</div>}

      {state && (
        <div className="card">
          <div className="toolbar">
            <h2 style={{ margin: 0 }}>
              Version {state.version} <span className="badge">{state.resolved_at}</span>
            </h2>
          </div>
          <pre className="json-view">{JSON.stringify(state.facts, null, 2)}</pre>
          <p>
            <strong>Resolution notes:</strong>
          </p>
          <p className="audit-decision">{state.conflict_resolution_notes}</p>
        </div>
      )}

      {audit && (
        <div className="card">
          <h2>
            Audit trail <span className="muted">({audit.total} entries)</span>
          </h2>
          <table>
            <thead>
              <tr>
                <th style={{ width: 170 }}>Recorded at</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {audit.entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="timestamp">{entry.created_at}</td>
                  <td className="audit-decision">{entry.decision}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="toolbar" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
            <button
              type="button"
              className="ghost"
              disabled={auditPage <= 1}
              onClick={() => void load(documentIdInput, versionInput ? Number(versionInput) : undefined, auditPage - 1)}
            >
              ← Previous
            </button>
            <span className="muted">Page {auditPage}</span>
            <button
              type="button"
              className="ghost"
              disabled={!audit.has_more}
              onClick={() => void load(documentIdInput, versionInput ? Number(versionInput) : undefined, auditPage + 1)}
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </>
  );
}
