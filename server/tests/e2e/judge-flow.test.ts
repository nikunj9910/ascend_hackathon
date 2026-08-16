import type { Server } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, TEST_API_KEY } from '../integration/testApp';

let server: Server;
let baseUrl: string;
let cleanupDb: () => void;

const FIXTURES_DIR = path.resolve(__dirname, '../../../fixtures');

function listFixtureFiles(): string[] {
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json') && !f.includes('.expected_state.'))
    .sort();
}

beforeAll(async () => {
  const ctx = await createTestApp();
  cleanupDb = ctx.cleanup;
  await new Promise<void>((resolve) => {
    server = ctx.app.listen(0, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  cleanupDb();
});

/**
 * Mimics exactly what a judge does per the README: start the server, submit
 * fixtures, fetch state, fetch audit, replay, confirm determinism — over
 * real HTTP (a bound port + fetch), not supertest's in-process request().
 */
describe('judge flow', () => {
  it('the server is reachable at its documented localhost URL', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('every fixture, submitted through the real API, reaches its documented expected_state.json', async () => {
    for (const file of listFixtureFiles()) {
      const name = file.replace(/\.json$/, '');
      const events = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf-8'));
      const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.expected_state.json`), 'utf-8'));

      let documentId: string | undefined;
      for (const event of events) {
        documentId = event.document_id;
        const res = await fetch(`${baseUrl}/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-Key': TEST_API_KEY },
          body: JSON.stringify(event),
        });
        expect([200, 201]).toContain(res.status);
      }

      const state = await (await fetch(`${baseUrl}/documents/${documentId}/state`)).json();
      expect(state).toEqual(expected);

      const audit = (await (await fetch(`${baseUrl}/documents/${documentId}/audit`)).json()) as {
        entries: { decision: string }[];
      };
      expect(audit.entries.length).toBeGreaterThan(0);
      for (const entry of audit.entries) {
        expect(entry.decision).not.toMatch(/ALLOWED|DENIED|CONFLICT/);
      }
    }
  });

  it('confirms determinism: the same shuffled replay request run twice produces byte-identical output', async () => {
    const allEvents = listFixtureFiles().flatMap((file) =>
      JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf-8'))
    );
    const shuffled = [...allEvents].reverse();

    const replay = () =>
      fetch(`${baseUrl}/events/replay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: shuffled }),
      }).then((r) => r.json()) as Promise<{ persisted: boolean; documents: unknown[] }>;

    const first = await replay();
    const second = await replay();

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.persisted).toBe(false);
    expect(first.documents.length).toBe(listFixtureFiles().length);
  });
});
