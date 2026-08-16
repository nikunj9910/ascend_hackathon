import { describe, expect, it } from 'vitest';
import { resolve } from '../../src/resolution/resolve';
import { computeDedupeKey } from '../../src/resolution/canonicalize';
import type { AgentRecord, EventRecord, Fact } from '../../src/resolution/types';
import type { ResolutionConfig } from '../../src/resolution/types';

function makeEvent(overrides: Partial<EventRecord> & { agentId: string; documentId: string; eventTimestamp: string; facts: Fact[] }): EventRecord {
  const base = {
    id: `${overrides.agentId}-${overrides.eventTimestamp}-${Math.random()}`,
    eventType: 'extraction' as const,
    confidenceScore: 0.8,
  };
  const merged: EventRecord = {
    ...base,
    ...overrides,
    dedupeKey:
      overrides.dedupeKey ??
      computeDedupeKey({
        agentId: overrides.agentId,
        documentId: overrides.documentId,
        eventTimestamp: overrides.eventTimestamp,
        eventType: overrides.eventType ?? base.eventType,
        facts: overrides.facts,
      }),
  };
  return merged;
}

const AGENTS: AgentRecord[] = [
  { agentId: 'agent-alpha', trustScore: 0.9 },
  { agentId: 'agent-beta', trustScore: 0.75 },
  { agentId: 'agent-gamma', trustScore: 0.6 },
  { agentId: 'agent-delta', trustScore: 0.35 },
];

const DOC = 'doc-1';

describe('resolve() determinism', () => {
  it('produces byte-identical output on repeated calls with the same input', () => {
    const events = [
      makeEvent({ agentId: 'agent-alpha', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', facts: [{ key: 'title', value: 'Q1 Report' }] }),
      makeEvent({ agentId: 'agent-beta', documentId: DOC, eventTimestamp: '2026-01-02T00:00:00.000Z', facts: [{ key: 'title', value: 'Q1 Financial Report' }] }),
    ];
    const first = resolve(DOC, events, AGENTS);
    const second = resolve(DOC, events, AGENTS);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('produces the same result regardless of input array order (shuffled vs canonical)', () => {
    const events = [
      makeEvent({ agentId: 'agent-alpha', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', facts: [{ key: 'title', value: 'A' }] }),
      makeEvent({ agentId: 'agent-beta', documentId: DOC, eventTimestamp: '2026-01-03T00:00:00.000Z', facts: [{ key: 'title', value: 'C' }] }),
      makeEvent({ agentId: 'agent-gamma', documentId: DOC, eventTimestamp: '2026-01-02T00:00:00.000Z', facts: [{ key: 'title', value: 'B' }] }),
    ];
    const inOrder = resolve(DOC, events, AGENTS);
    const shuffled = resolve(DOC, [events[2]!, events[0]!, events[1]!], AGENTS);
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(inOrder));
  });

  it('ignores object key iteration order in fact values when hashing/comparing', () => {
    const events = [
      makeEvent({
        agentId: 'agent-alpha',
        documentId: DOC,
        eventTimestamp: '2026-01-01T00:00:00.000Z',
        facts: [
          { key: 'b_key', value: 'second' },
          { key: 'a_key', value: 'first' },
        ],
      }),
    ];
    const result = resolve(DOC, events, AGENTS);
    expect(Object.keys(result.facts)).toEqual(['a_key', 'b_key']);
  });
});

describe('resolve() temporal ordering', () => {
  it('lets a later event_timestamp supersede an earlier one from the same agent, regardless of array position', () => {
    const older = makeEvent({ agentId: 'agent-alpha', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', facts: [{ key: 'status', value: 'draft' }] });
    const newer = makeEvent({ agentId: 'agent-alpha', documentId: DOC, eventTimestamp: '2026-01-05T00:00:00.000Z', facts: [{ key: 'status', value: 'final' }] });

    // Fed in reverse (newer first) — the array position must not matter.
    const result = resolve(DOC, [newer, older], AGENTS);
    expect(result.facts.status?.value).toBe('final');
  });

  it('excludes events after asOfTimestamp (temporal consistency / time travel)', () => {
    const early = makeEvent({ agentId: 'agent-alpha', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', facts: [{ key: 'status', value: 'draft' }] });
    const late = makeEvent({ agentId: 'agent-alpha', documentId: DOC, eventTimestamp: '2026-01-10T00:00:00.000Z', facts: [{ key: 'status', value: 'final' }] });

    const asOfEarly = resolve(DOC, [early, late], AGENTS, '2026-01-02T00:00:00.000Z');
    expect(asOfEarly.facts.status?.value).toBe('draft');

    const asOfLate = resolve(DOC, [early, late], AGENTS, '2026-01-11T00:00:00.000Z');
    expect(asOfLate.facts.status?.value).toBe('final');
  });

  it('defaults asOfTimestamp to the max event_timestamp among the given events (deterministic, no wall clock)', () => {
    const events = [
      makeEvent({ agentId: 'agent-alpha', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', facts: [{ key: 'k', value: 1 }] }),
      makeEvent({ agentId: 'agent-beta', documentId: DOC, eventTimestamp: '2026-01-05T00:00:00.000Z', facts: [{ key: 'k', value: 2 }] }),
    ];
    const result = resolve(DOC, events, AGENTS);
    expect(result.asOfTimestamp).toBe('2026-01-05T00:00:00.000Z');
  });
});

describe('resolve() partial updates', () => {
  it('does not clear other keys when a later event only mentions one key', () => {
    const events = [
      makeEvent({
        agentId: 'agent-alpha',
        documentId: DOC,
        eventTimestamp: '2026-01-01T00:00:00.000Z',
        facts: [
          { key: 'title', value: 'Q1 Report' },
          { key: 'author', value: 'Alice' },
        ],
      }),
      makeEvent({
        agentId: 'agent-alpha',
        documentId: DOC,
        eventTimestamp: '2026-01-02T00:00:00.000Z',
        facts: [{ key: 'title', value: 'Q1 Report (Revised)' }],
      }),
    ];
    const result = resolve(DOC, events, AGENTS);
    expect(result.facts.title?.value).toBe('Q1 Report (Revised)');
    expect(result.facts.author?.value).toBe('Alice');
  });
});

describe('resolve() weighting', () => {
  it('is not a single-field decision: low-trust+high-confidence can lose to high-trust+low-confidence, or vice versa, depending on the math', () => {
    // agent-delta: trust 0.35, confidence 0.95 -> weight ~0.3325 (recency 1.0)
    // agent-alpha: trust 0.90, confidence 0.30 -> weight ~0.27
    const events = [
      makeEvent({ agentId: 'agent-delta', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', confidenceScore: 0.95, facts: [{ key: 'total', value: 100 }] }),
      makeEvent({ agentId: 'agent-alpha', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', confidenceScore: 0.3, facts: [{ key: 'total', value: 200 }] }),
    ];
    const result = resolve(DOC, events, AGENTS);
    // Neither agent_id is ever hardcoded as a winner: the low-trust-high-confidence
    // agent wins here purely because trust*confidence*recency computes higher.
    expect(result.facts.total?.value).toBe(100);
    expect(result.facts.total?.sourceAgentId).toBe('agent-delta');
  });

  it('sums weights of agents that agree on the same value ("evidence weight") to outweigh a lone higher-weight dissenter', () => {
    const events = [
      // Two lower-trust agents agree on 50; one higher-trust agent disagrees with 999.
      makeEvent({ agentId: 'agent-gamma', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', confidenceScore: 0.9, facts: [{ key: 'count', value: 50 }] }),
      makeEvent({ agentId: 'agent-delta', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', confidenceScore: 0.9, facts: [{ key: 'count', value: 50 }] }),
      makeEvent({ agentId: 'agent-alpha', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', confidenceScore: 0.5, facts: [{ key: 'count', value: 999 }] }),
    ];
    const result = resolve(DOC, events, AGENTS);
    expect(result.facts.count?.value).toBe(50);
  });

  it('breaks exact weight ties by lexicographically smallest agent_id (documented, deterministic)', () => {
    const agents: AgentRecord[] = [
      { agentId: 'agent-b', trustScore: 0.5 },
      { agentId: 'agent-a', trustScore: 0.5 },
    ];
    const events = [
      makeEvent({ agentId: 'agent-b', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', confidenceScore: 0.5, facts: [{ key: 'k', value: 'from-b' }] }),
      makeEvent({ agentId: 'agent-a', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', confidenceScore: 0.5, facts: [{ key: 'k', value: 'from-a' }] }),
    ];
    const result = resolve(DOC, events, agents);
    expect(result.facts.k?.value).toBe('from-a');
    expect(result.facts.k?.sourceAgentId).toBe('agent-a');
  });

  it('decays weight with age via the recency half-life (older same-strength submission is worth less at a later asOfTimestamp)', () => {
    const config: ResolutionConfig = { defaultMode: 'highest-weight', defaultHalfLifeMs: 24 * 60 * 60 * 1000 };
    const events = [
      makeEvent({ agentId: 'agent-alpha', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', confidenceScore: 0.9, facts: [{ key: 'k', value: 'old' }] }),
    ];
    const atSubmission = resolve(DOC, events, AGENTS, '2026-01-01T00:00:00.000Z', config);
    const oneHalfLifeLater = resolve(DOC, events, AGENTS, '2026-01-02T00:00:00.000Z', config);
    expect(oneHalfLifeLater.facts.k!.weight).toBeCloseTo(atSubmission.facts.k!.weight * 0.5, 5);
  });
});

describe('resolve() weighted-average mode', () => {
  const config: ResolutionConfig = {
    defaultMode: 'highest-weight',
    defaultHalfLifeMs: 30 * 24 * 60 * 60 * 1000,
    perKey: { total_amount: { mode: 'weighted-average' } },
  };

  it('computes a weight-weighted mean for numeric values', () => {
    const events = [
      makeEvent({ agentId: 'agent-alpha', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', confidenceScore: 1, facts: [{ key: 'total_amount', value: 100 }] }),
      makeEvent({ agentId: 'agent-beta', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', confidenceScore: 1, facts: [{ key: 'total_amount', value: 200 }] }),
    ];
    // agent-alpha trust 0.9, agent-beta trust 0.75 -> weights 0.9 and 0.75
    // weighted mean = (100*0.9 + 200*0.75) / (0.9+0.75) = 240/1.65 = 145.4545...
    const result = resolve(DOC, events, AGENTS, undefined, config);
    expect(result.facts.total_amount?.value).toBeCloseTo(145.454545, 4);
    expect(result.facts.total_amount?.sourceAgentId).toBeNull();
  });

  it('falls back to highest-weight when a candidate value is non-numeric, and says so in the note', () => {
    const events = [
      makeEvent({ agentId: 'agent-alpha', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', facts: [{ key: 'total_amount', value: 100 }] }),
      makeEvent({ agentId: 'agent-beta', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', facts: [{ key: 'total_amount', value: 'unknown' }] }),
    ];
    const result = resolve(DOC, events, AGENTS, undefined, config);
    expect(typeof result.facts.total_amount?.value).not.toBe('undefined');
    expect(result.conflictResolutionNotes).toContain('fell back to highest-weight');
  });
});

describe('resolve() conflict notes', () => {
  it('names contested keys, agents, weights, and the winner in plain English', () => {
    const events = [
      makeEvent({ agentId: 'agent-alpha', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', confidenceScore: 0.9, facts: [{ key: 'category', value: 'invoice' }] }),
      makeEvent({ agentId: 'agent-beta', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', confidenceScore: 0.4, facts: [{ key: 'category', value: 'receipt' }] }),
    ];
    const result = resolve(DOC, events, AGENTS);
    expect(result.conflictResolutionNotes).toContain('category');
    expect(result.conflictResolutionNotes).toContain('agent-alpha');
    expect(result.conflictResolutionNotes).toContain('agent-beta');
    expect(result.conflictResolutionNotes).not.toMatch(/ALLOWED|DENIED|CONFLICT/);
  });

  it('reports no-conflict plainly when every key has a single source or full agreement', () => {
    const events = [makeEvent({ agentId: 'agent-alpha', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', facts: [{ key: 'k', value: 'v' }] })];
    const result = resolve(DOC, events, AGENTS);
    expect(result.conflictResolutionNotes).toContain('No conflicts were detected');
  });
});

describe('resolve() edge cases', () => {
  it('returns an empty resolved state with an explanatory note for a document with no events', () => {
    const result = resolve('doc-nonexistent', [], AGENTS);
    expect(result.facts).toEqual({});
    expect(result.conflictResolutionNotes).toContain('No events were found');
  });

  it('ignores events belonging to other documents', () => {
    const events = [
      makeEvent({ agentId: 'agent-alpha', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', facts: [{ key: 'k', value: 'mine' }] }),
      makeEvent({ agentId: 'agent-alpha', documentId: 'doc-other', eventTimestamp: '2026-01-01T00:00:00.000Z', facts: [{ key: 'k', value: 'not-mine' }] }),
    ];
    const result = resolve(DOC, events, AGENTS);
    expect(result.facts.k?.value).toBe('mine');
  });

  it('treats an unknown agent_id as trust_score 0 rather than throwing', () => {
    const events = [makeEvent({ agentId: 'agent-unknown', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', facts: [{ key: 'k', value: 'v' }] })];
    const result = resolve(DOC, events, AGENTS);
    expect(result.facts.k?.weight).toBe(0);
  });

  it('never hardcodes a preferred agent_id: swapping which agent submits which value swaps the winner too', () => {
    const eventsA = [
      makeEvent({ agentId: 'agent-alpha', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', confidenceScore: 0.9, facts: [{ key: 'k', value: 'X' }] }),
      makeEvent({ agentId: 'agent-delta', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', confidenceScore: 0.2, facts: [{ key: 'k', value: 'Y' }] }),
    ];
    const eventsB = [
      makeEvent({ agentId: 'agent-alpha', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', confidenceScore: 0.2, facts: [{ key: 'k', value: 'X' }] }),
      makeEvent({ agentId: 'agent-delta', documentId: DOC, eventTimestamp: '2026-01-01T00:00:00.000Z', confidenceScore: 0.9, facts: [{ key: 'k', value: 'Y' }] }),
    ];
    const resultA = resolve(DOC, eventsA, AGENTS);
    const resultB = resolve(DOC, eventsB, AGENTS);
    expect(resultA.facts.k?.value).toBe('X');
    expect(resultB.facts.k?.value).toBe('Y');
  });
});
