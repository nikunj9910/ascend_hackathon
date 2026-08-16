import { config } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

config({ path: path.resolve(__dirname, '../server/.env') });

const BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';
const API_KEY = process.env.API_KEY;
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');

interface Fact {
  key: string;
  value: string | number | boolean | null;
}

interface EventPayload {
  agent_id: string;
  document_id: string;
  event_type: string;
  event_timestamp: string;
  confidence_score: number;
  facts: Fact[];
}

const DESCRIPTIONS: Record<string, string> = {
  '01-duplicate-events':
    'Submits the exact same event twice. The second submission must be a no-op: same version, same facts, no new audit rows — proving idempotency via the dedupe_key.',
  '02-late-out-of-order':
    'Submits a newer-timestamped event first, then an older-timestamped ("late") event from the same agent for the same key. The late event still gets slotted into its correct temporal position, produces a new state version, and its audit entry explains the correction.',
  '03-conflicting-facts':
    'Two different agents assert different values for the same fact key at the same time. The value with more evidence weight (trust × confidence × recency) wins, and the audit trail names both agents and their weights.',
  '04-low-trust-vs-high-confidence':
    'A high-trust-but-low-confidence agent and a low-trust-but-high-confidence agent disagree. Demonstrates that resolution is never a single-field decision — the weighted math decides, not a hardcoded agent preference.',
  '05-partial-update':
    'One agent submits two fact keys, then a later event from the same agent revises only one of them. The untouched key must remain exactly as it was — partial updates never null out other keys.',
};

async function checkServerIsUp(): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (!res.ok) throw new Error(`unexpected status ${res.status}`);
  } catch {
    throw new Error(
      `Could not reach the API at ${BASE_URL}/health. Start the server first with "npm run dev" (or "npm run dev --prefix server"), then re-run "npm run seed".`
    );
  }
}

async function main(): Promise<void> {
  if (!API_KEY) {
    throw new Error(
      'API_KEY is not set. Copy server/.env.example to server/.env (the demo key already works out of the box) before running the seed script.'
    );
  }

  await checkServerIsUp();

  const files = fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json') && !f.includes('.expected_state.'))
    .sort();

  let allMatched = true;

  for (const file of files) {
    const name = file.replace(/\.json$/, '');
    const events: EventPayload[] = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf-8'));
    const expectedPath = path.join(FIXTURES_DIR, `${name}.expected_state.json`);
    const expected = fs.existsSync(expectedPath) ? JSON.parse(fs.readFileSync(expectedPath, 'utf-8')) : undefined;

    console.log(`\n=== ${name} ===`);
    if (DESCRIPTIONS[name]) console.log(DESCRIPTIONS[name]);

    let documentId: string | undefined;
    for (const event of events) {
      documentId = event.document_id;
      const res = await fetch(`${BASE_URL}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
        body: JSON.stringify(event),
      });
      const body = (await res.json()) as { note?: string };
      console.log(
        `  -> POST /events [${res.status}] agent=${event.agent_id} ts=${event.event_timestamp}${
          body.note ? ` (${body.note})` : ''
        }`
      );
    }

    if (!documentId) continue;

    const state = await (await fetch(`${BASE_URL}/documents/${documentId}/state`)).json();
    console.log('  Final state:');
    console.log(indent(JSON.stringify(state, null, 2)));

    const audit = (await (await fetch(`${BASE_URL}/documents/${documentId}/audit`)).json()) as {
      entries: { decision: string }[];
    };
    console.log('  Audit trail:');
    for (const entry of audit.entries) {
      console.log(`    - ${entry.decision}`);
    }

    if (expected) {
      const matches = JSON.stringify(state) === JSON.stringify(expected);
      console.log(matches ? '  ✓ Matches fixtures/' + name + '.expected_state.json' : '  ✗ DOES NOT MATCH fixtures/' + name + '.expected_state.json');
      if (!matches) {
        allMatched = false;
        console.log('  Expected:');
        console.log(indent(JSON.stringify(expected, null, 2)));
      }
    }
  }

  console.log(`\n${allMatched ? 'All fixtures matched their expected_state.json.' : 'Some fixtures did NOT match — see ✗ above.'}`);
  if (!allMatched) process.exitCode = 1;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

main().catch((err) => {
  console.error(`\nSeed script failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
