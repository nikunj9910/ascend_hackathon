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

function postEvent(body: Record<string, unknown>) {
  return request(app).post('/events').set('X-API-Key', TEST_API_KEY).send(body);
}

describe('POST /events — auth and validation', () => {
  it('rejects writes without a valid API key', async () => {
    const res = await request(app)
      .post('/events')
      .send({
        agent_id: 'agent-alpha',
        document_id: 'doc-auth',
        event_type: 'extraction',
        event_timestamp: '2026-01-01T00:00:00.000Z',
        confidence_score: 0.9,
        facts: [{ key: 'k', value: 'v' }],
      });
    expect(res.status).toBe(401);
  });

  it('rejects a structurally invalid payload with field-level 400 errors, not a stack trace', async () => {
    const res = await postEvent({
      agent_id: 'agent-alpha',
      document_id: 'doc-bad',
      event_type: 'not-a-real-type',
      event_timestamp: 'not-a-date',
      confidence_score: 5,
      facts: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(Array.isArray(res.body.details)).toBe(true);
    expect(res.body.stack).toBeUndefined();
  });

  it('rejects an event whose own facts array asserts two values for the same key (409, not a silent drop)', async () => {
    const res = await postEvent({
      agent_id: 'agent-alpha',
      document_id: 'doc-selfconflict',
      event_type: 'extraction',
      event_timestamp: '2026-01-01T00:00:00.000Z',
      confidence_score: 0.9,
      facts: [
        { key: 'total', value: 100 },
        { key: 'total', value: 200 },
      ],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('total');
  });

  it('rejects unknown fields in the payload', async () => {
    const res = await postEvent({
      agent_id: 'agent-alpha',
      document_id: 'doc-unknown-field',
      event_type: 'extraction',
      event_timestamp: '2026-01-01T00:00:00.000Z',
      confidence_score: 0.9,
      facts: [{ key: 'k', value: 'v' }],
      unexpected_field: 'nope',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /events — idempotency (duplicate events)', () => {
  const body = {
    agent_id: 'agent-alpha',
    document_id: 'doc-dup',
    event_type: 'extraction' as const,
    event_timestamp: '2026-01-01T00:00:00.000Z',
    confidence_score: 0.9,
    facts: [{ key: 'k', value: 'v' }],
  };

  it('submitting the same event twice leaves state and version unchanged and creates no duplicate audit rows', async () => {
    const first = await postEvent(body);
    expect(first.status).toBe(201);
    expect(first.body.version).toBe(1);

    const second = await postEvent(body);
    expect(second.status).toBe(200);
    expect(second.body.version).toBe(1);
    expect(second.body.facts).toEqual(first.body.facts);

    const audit = await request(app).get('/documents/doc-dup/audit');
    expect(audit.body.total).toBe(2); // acceptance line + no-conflict line, once only
  });
});

describe('POST /events — conflicting facts and trust-score impact', () => {
  it('resolves a conflict between two agents deterministically and explains why in the notes', async () => {
    await postEvent({
      agent_id: 'agent-alpha', // trust 0.9
      document_id: 'doc-conflict',
      event_type: 'extraction',
      event_timestamp: '2026-01-01T00:00:00.000Z',
      confidence_score: 0.9,
      facts: [{ key: 'category', value: 'invoice' }],
    });
    const second = await postEvent({
      agent_id: 'agent-delta', // trust 0.35, much lower
      document_id: 'doc-conflict',
      event_type: 'extraction',
      event_timestamp: '2026-01-01T00:00:01.000Z',
      confidence_score: 0.9,
      facts: [{ key: 'category', value: 'receipt' }],
    });

    expect(second.status).toBe(201);
    expect(second.body.version).toBe(2);
    // agent-alpha's higher trust score should carry its value despite a lower confidence tie.
    expect(second.body.facts.category.value).toBe('invoice');
    expect(second.body.facts.category.sourceAgentId).toBe('agent-alpha');

    const state = await request(app).get('/documents/doc-conflict/state');
    expect(state.body.conflict_resolution_notes).toContain('agent-alpha');
    expect(state.body.conflict_resolution_notes).toContain('agent-delta');
    expect(state.body.conflict_resolution_notes).not.toMatch(/ALLOWED|DENIED|CONFLICT/);
  });

  it('lets a low-trust-but-high-confidence agent outweigh a high-trust-but-low-confidence agent when the math says so', async () => {
    await postEvent({
      agent_id: 'agent-alpha', // trust 0.9, low confidence
      document_id: 'doc-weight-math',
      event_type: 'extraction',
      event_timestamp: '2026-01-01T00:00:00.000Z',
      confidence_score: 0.2,
      facts: [{ key: 'amount', value: 100 }],
    });
    const second = await postEvent({
      agent_id: 'agent-delta', // trust 0.35, high confidence
      document_id: 'doc-weight-math',
      event_type: 'extraction',
      event_timestamp: '2026-01-01T00:00:00.000Z',
      confidence_score: 0.99,
      facts: [{ key: 'amount', value: 200 }],
    });

    // 0.9*0.2=0.18 vs 0.35*0.99=0.3465 -> agent-delta should win despite lower trust.
    expect(second.body.facts.amount.value).toBe(200);
    expect(second.body.facts.amount.sourceAgentId).toBe('agent-delta');
  });
});

describe('POST /events — late / out-of-order arrival', () => {
  it('slots a late event into its correct temporal position, changes state, bumps version, and notes the correction', async () => {
    const newer = await postEvent({
      agent_id: 'agent-gamma',
      document_id: 'doc-late',
      event_type: 'extraction',
      event_timestamp: '2026-01-10T00:00:00.000Z',
      confidence_score: 0.8,
      facts: [{ key: 'status', value: 'final' }],
    });
    expect(newer.body.version).toBe(1);

    const late = await postEvent({
      agent_id: 'agent-gamma',
      document_id: 'doc-late',
      event_type: 'extraction',
      event_timestamp: '2026-01-01T00:00:00.000Z', // older than the event already recorded
      confidence_score: 0.8,
      facts: [{ key: 'status', value: 'draft' }],
    });
    expect(late.status).toBe(201);
    expect(late.body.version).toBe(2);
    // agent-gamma's own newer submission (final) still supersedes its own older one.
    expect(late.body.facts.status.value).toBe('final');

    const audit = await request(app).get('/documents/doc-late/audit');
    const decisions = audit.body.entries.map((e: { decision: string }) => e.decision).join(' ');
    expect(decisions).toContain('arrived out of order');
  });
});

describe('POST /events — versioned state and partial updates', () => {
  it('never clears a key that a later partial-update event does not mention', async () => {
    await postEvent({
      agent_id: 'agent-alpha',
      document_id: 'doc-partial',
      event_type: 'extraction',
      event_timestamp: '2026-01-01T00:00:00.000Z',
      confidence_score: 0.9,
      facts: [
        { key: 'title', value: 'Report' },
        { key: 'author', value: 'Alice' },
      ],
    });
    const second = await postEvent({
      agent_id: 'agent-alpha',
      document_id: 'doc-partial',
      event_type: 'extraction',
      event_timestamp: '2026-01-02T00:00:00.000Z',
      confidence_score: 0.9,
      facts: [{ key: 'title', value: 'Report (Revised)' }],
    });

    expect(second.body.facts.title.value).toBe('Report (Revised)');
    expect(second.body.facts.author.value).toBe('Alice');
  });

  it('never updates a state row in place — GET ?version=N still returns the original historical snapshot', async () => {
    const v1State = await request(app).get('/documents/doc-partial/state?version=1');
    expect(v1State.body.facts.title.value).toBe('Report');

    const latest = await request(app).get('/documents/doc-partial/state');
    expect(latest.body.version).toBe(2);
    expect(latest.body.facts.title.value).toBe('Report (Revised)');
  });
});

describe('GET /documents/:id/state and /audit — not found', () => {
  it('returns 404 for a document with no events', async () => {
    const res = await request(app).get('/documents/doc-nonexistent/state');
    expect(res.status).toBe(404);
  });

  it('does not require an API key for reads', async () => {
    const res = await request(app).get('/documents/doc-partial/state');
    expect(res.status).toBe(200);
  });
});
