import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp, TEST_API_KEY } from './testApp';

let app: Express;
let cleanup: () => void;

beforeAll(async () => {
  const ctx = await createTestApp();
  app = ctx.app;
  cleanup = ctx.cleanup;
});

afterAll(() => cleanup());

const FIXTURE_EVENTS = [
  {
    agent_id: 'agent-beta',
    document_id: 'doc-replay-parity',
    event_type: 'extraction' as const,
    event_timestamp: '2026-01-03T00:00:00.000Z',
    confidence_score: 0.4,
    facts: [{ key: 'title', value: 'C' }],
  },
  {
    agent_id: 'agent-alpha',
    document_id: 'doc-replay-parity',
    event_type: 'extraction' as const,
    event_timestamp: '2026-01-01T00:00:00.000Z',
    confidence_score: 0.9,
    facts: [{ key: 'title', value: 'A' }],
  },
  {
    agent_id: 'agent-gamma',
    document_id: 'doc-replay-parity',
    event_type: 'extraction' as const,
    event_timestamp: '2026-01-02T00:00:00.000Z',
    confidence_score: 0.6,
    facts: [{ key: 'title', value: 'B' }],
  },
];

describe('POST /events/replay — dry run', () => {
  it('does not require an API key', async () => {
    const res = await request(app)
      .post('/events/replay')
      .send({ events: [FIXTURE_EVENTS[0]] });
    expect(res.status).toBe(200);
  });

  it('does not persist anything', async () => {
    await request(app)
      .post('/events/replay')
      .send({ events: FIXTURE_EVENTS });
    const state = await request(app).get('/documents/doc-replay-parity/state');
    expect(state.status).toBe(404);
  });

  it('produces the same final state as sequential live ingestion, regardless of request array order', async () => {
    // Ingest sequentially, in canonical (already-ordered) order, via /events.
    for (const event of [...FIXTURE_EVENTS].sort((a, b) => a.event_timestamp.localeCompare(b.event_timestamp))) {
      const res = await request(app).post('/events').set('X-API-Key', TEST_API_KEY).send(event);
      expect(res.status).toBe(201);
    }
    const liveState = await request(app).get('/documents/doc-replay-parity/state');

    // Replay the same events in shuffled (non-canonical) request order.
    const shuffled = [FIXTURE_EVENTS[1], FIXTURE_EVENTS[2], FIXTURE_EVENTS[0]];
    const replay = await request(app)
      .post('/events/replay')
      .send({ events: shuffled });

    expect(replay.body.documents).toHaveLength(1);
    const replayedDoc = replay.body.documents[0];
    expect(replayedDoc.facts).toEqual(liveState.body.facts);
    expect(replayedDoc.resolved_at).toBe(liveState.body.resolved_at);
    expect(replayedDoc.conflict_resolution_notes).toBe(liveState.body.conflict_resolution_notes);
  });

  it('rejects an event with duplicate fact keys inside the batch (409)', async () => {
    const res = await request(app)
      .post('/events/replay')
      .send({
        events: [
          {
            agent_id: 'agent-alpha',
            document_id: 'doc-replay-badkeys',
            event_type: 'extraction',
            event_timestamp: '2026-01-01T00:00:00.000Z',
            confidence_score: 0.9,
            facts: [
              { key: 'x', value: 1 },
              { key: 'x', value: 2 },
            ],
          },
        ],
      });
    expect(res.status).toBe(409);
  });
});

describe('POST /events/replay — persist', () => {
  it('requires an API key when persist:true', async () => {
    const res = await request(app)
      .post('/events/replay')
      .send({ persist: true, events: [FIXTURE_EVENTS[0]] });
    expect(res.status).toBe(401);
  });

  const persistEvent = {
    agent_id: 'agent-alpha',
    document_id: 'doc-replay-persist',
    event_type: 'extraction' as const,
    event_timestamp: '2026-01-01T00:00:00.000Z',
    confidence_score: 0.9,
    facts: [{ key: 'title', value: 'C' }],
  };

  it('writes real events and a new document state when persist:true and authorized', async () => {
    const res = await request(app)
      .post('/events/replay')
      .set('X-API-Key', TEST_API_KEY)
      .send({ persist: true, events: [persistEvent] });

    expect(res.status).toBe(200);
    expect(res.body.persisted).toBe(true);
    expect(res.body.documents[0].inserted_count).toBe(1);

    const state = await request(app).get(`/documents/${persistEvent.document_id}/state`);
    expect(state.status).toBe(200);
    expect(state.body.facts.title.value).toBe('C');
  });

  it('is idempotent: replaying the same persisted event again inserts nothing new', async () => {
    const res = await request(app)
      .post('/events/replay')
      .set('X-API-Key', TEST_API_KEY)
      .send({ persist: true, events: [persistEvent] });

    expect(res.body.documents[0].inserted_count).toBe(0);
    expect(res.body.documents[0].duplicate_count).toBe(1);
  });
});
