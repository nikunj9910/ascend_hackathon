import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp, TEST_API_KEY } from './testApp';

let app: Express;
let cleanup: () => void;

const FIXTURES_DIR = path.resolve(__dirname, '../../../fixtures');

beforeAll(async () => {
  const ctx = await createTestApp();
  app = ctx.app;
  cleanup = ctx.cleanup;
});

afterAll(() => cleanup());

const fixtureFiles = fs
  .readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith('.json') && !f.includes('.expected_state.'))
  .sort();

describe.each(fixtureFiles)('fixture %s', (file) => {
  const name = file.replace(/\.json$/, '');
  const events = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf-8'));
  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.expected_state.json`), 'utf-8'));

  it('reaches the documented expected_state.json when submitted sequentially via /events', async () => {
    let documentId: string | undefined;
    for (const event of events) {
      documentId = event.document_id;
      const res = await request(app).post('/events').set('X-API-Key', TEST_API_KEY).send(event);
      expect([200, 201]).toContain(res.status);
    }

    const state = await request(app).get(`/documents/${documentId}/state`);
    expect(state.status).toBe(200);
    expect(state.body).toEqual(expected);
  });

  it('reaches the same expected_state.json via /events/replay dry-run, even with events shuffled', async () => {
    const shuffled = [...events].reverse();
    const res = await request(app)
      .post('/events/replay')
      .send({ events: shuffled });

    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(1);
    expect(res.body.documents[0].facts).toEqual(expected.facts);
    expect(res.body.documents[0].resolved_at).toBe(expected.resolved_at);
    expect(res.body.documents[0].conflict_resolution_notes).toBe(expected.conflict_resolution_notes);
  });
});
