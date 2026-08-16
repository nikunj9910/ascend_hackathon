import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './client';
import agentSeeds from '../config/agents.seed.json';

const SCHEMA_PATH = path.resolve(__dirname, 'schema.sqlite.sql');

/**
 * Applies schema.sqlite.sql (idempotent — every statement is CREATE ... IF
 * NOT EXISTS) and seeds the agents table with base trust scores for any
 * agent_id not already present. Safe to call on every server boot.
 */
export function setupDatabase(): void {
  const db = getDb();
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(schema);

  const insertAgent = db.prepare(
    `insert into agents (agent_id, trust_score, display_name, updated_at)
     values (@agent_id, @trust_score, @display_name, @updated_at)
     on conflict (agent_id) do nothing`
  );

  const seedAgents = db.transaction((agents: typeof agentSeeds) => {
    const updatedAt = new Date(0).toISOString(); // fixed, deterministic seed timestamp
    for (const agent of agents) {
      insertAgent.run({ ...agent, updated_at: updatedAt });
    }
  });

  seedAgents(agentSeeds);
}

if (require.main === module) {
  setupDatabase();
  console.log('Database schema applied and base agents seeded.');
}
