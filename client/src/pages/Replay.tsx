import { useState } from 'react';
import { ApiError, replayEvents, type EventSubmission, type ReplayResponse } from '../lib/api';

import fixture01 from '../../../fixtures/01-duplicate-events.json';
import fixture02 from '../../../fixtures/02-late-out-of-order.json';
import fixture03 from '../../../fixtures/03-conflicting-facts.json';
import fixture04 from '../../../fixtures/04-low-trust-vs-high-confidence.json';
import fixture05 from '../../../fixtures/05-partial-update.json';

const FIXTURES: Record<string, EventSubmission[]> = {
  '01-duplicate-events': fixture01 as EventSubmission[],
  '02-late-out-of-order': fixture02 as EventSubmission[],
  '03-conflicting-facts': fixture03 as EventSubmission[],
  '04-low-trust-vs-high-confidence': fixture04 as EventSubmission[],
  '05-partial-update': fixture05 as EventSubmission[],
};

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

export default function Replay({ apiKey }: { apiKey: string }) {
  const [selectedFixture, setSelectedFixture] = useState('03-conflicting-facts');
  const [eventsJson, setEventsJson] = useState(() => JSON.stringify(FIXTURES['03-conflicting-facts'], null, 2));
  const [result, setResult] = useState<ReplayResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function loadFixture(name: string) {
    setSelectedFixture(name);
    setEventsJson(JSON.stringify(FIXTURES[name], null, 2));
    setResult(null);
    setError(null);
  }

  function shuffleEvents() {
    try {
      const parsed = JSON.parse(eventsJson) as EventSubmission[];
      setEventsJson(JSON.stringify(shuffled(parsed), null, 2));
    } catch {
      setError('Cannot shuffle: the events field is not valid JSON.');
    }
  }

  async function runReplay(persist: boolean) {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const events = JSON.parse(eventsJson) as EventSubmission[];
      const res = await replayEvents(events, persist, apiKey);
      setResult(res);
    } catch (err) {
      if (err instanceof SyntaxError) {
        setError('The events field is not valid JSON.');
      } else if (err instanceof ApiError) {
        setError(`${err.status}: ${err.message}`);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <h1>Replay console</h1>
      <p className="page-intro">
        Recompute a resolved state directly from a list of events, in any order — this calls the exact same
        resolution engine as live ingestion. Dry run (default) never touches persisted data; persisting requires the
        API key.
      </p>

      <div className="card">
        <div className="field">
          <label htmlFor="fixture-select">Load a fixture</label>
          <select id="fixture-select" value={selectedFixture} onChange={(e) => loadFixture(e.target.value)}>
            {Object.keys(FIXTURES).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="events-json">events (JSON array — edit freely, or paste your own)</label>
          <textarea id="events-json" value={eventsJson} onChange={(e) => setEventsJson(e.target.value)} spellCheck={false} />
        </div>

        <div className="toolbar">
          <button type="button" className="secondary" onClick={shuffleEvents}>
            Shuffle order
          </button>
          <button type="button" onClick={() => void runReplay(false)} disabled={running}>
            {running ? 'Running…' : 'Run replay (dry run)'}
          </button>
          <button type="button" onClick={() => void runReplay(true)} disabled={running || !apiKey}>
            Run replay (persist)
          </button>
          {!apiKey && <span className="muted">Persisting requires an API key.</span>}
        </div>
      </div>

      {error && <div className="callout error">{error}</div>}

      {result && (
        <div className="card">
          <h2>{result.persisted ? 'Persisted result' : 'Dry-run result'}</h2>
          {result.documents.map((doc) => (
            <div key={doc.document_id} style={{ marginBottom: '1.25rem' }}>
              <p>
                <strong>document_id:</strong> <code>{doc.document_id}</code>
                {doc.version !== undefined && (
                  <>
                    {' '}
                    <span className="badge">version {doc.version}</span>
                  </>
                )}
                {doc.inserted_count !== undefined && (
                  <span className="muted">
                    {' '}
                    ({doc.inserted_count} inserted, {doc.duplicate_count} duplicate)
                  </span>
                )}
              </p>
              <pre className="json-view">{JSON.stringify(doc.facts, null, 2)}</pre>
              <p className="audit-decision">{doc.conflict_resolution_notes}</p>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
