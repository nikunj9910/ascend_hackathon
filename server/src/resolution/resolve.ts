import { canonicalStringify, sortEventsCanonically } from './canonicalize';
import { DEFAULT_RESOLUTION_CONFIG } from './config';
import type {
  AgentRecord,
  EventRecord,
  FactValue,
  ResolutionConfig,
  ResolvedFactValue,
  ResolvedState,
} from './types';

interface Candidate {
  agentId: string;
  value: FactValue;
  confidence: number;
  trustScore: number;
  recency: number;
  weight: number;
  eventTimestamp: string;
}

/**
 * Deterministic, zero-I/O conflict resolution. Same documentId + events +
 * agents + asOfTimestamp + config always produces a byte-identical
 * ResolvedState — this is what both the live ingestion route and
 * POST /events/replay call, so the two paths can never drift.
 */
export function resolve(
  documentId: string,
  events: EventRecord[],
  agents: AgentRecord[],
  asOfTimestamp?: string,
  config: ResolutionConfig = DEFAULT_RESOLUTION_CONFIG
): ResolvedState {
  const docEvents = events.filter((e) => e.documentId === documentId);
  const effectiveAsOf = asOfTimestamp ?? maxTimestamp(docEvents);

  if (effectiveAsOf === undefined) {
    return {
      facts: {},
      asOfTimestamp: asOfTimestamp ?? new Date(0).toISOString(),
      conflictResolutionNotes: 'No events were found for this document, so there is nothing to resolve.',
    };
  }

  const filtered = docEvents.filter((e) => e.eventTimestamp <= effectiveAsOf);
  const sorted = sortEventsCanonically(filtered);
  const agentMap = new Map(agents.map((a) => [a.agentId, a]));

  // For each fact key, keep only the latest (as of effectiveAsOf) value each
  // agent asserted for it — an agent's newer submission supersedes its own
  // older one for that key, while keys it never mentions are left alone
  // (this is what makes partial updates never clear unrelated keys).
  const latestPerKeyPerAgent = new Map<string, Map<string, { event: EventRecord; value: FactValue }>>();
  for (const event of sorted) {
    for (const fact of event.facts) {
      if (!latestPerKeyPerAgent.has(fact.key)) {
        latestPerKeyPerAgent.set(fact.key, new Map());
      }
      latestPerKeyPerAgent.get(fact.key)!.set(event.agentId, { event, value: fact.value });
    }
  }

  const facts: Record<string, ResolvedFactValue> = {};
  const contestedNotes: string[] = [];
  const sortedKeys = [...latestPerKeyPerAgent.keys()].sort();

  for (const key of sortedKeys) {
    const perAgent = latestPerKeyPerAgent.get(key)!;
    const keyConfig = config.perKey?.[key];
    const mode = keyConfig?.mode ?? config.defaultMode;
    const halfLifeMs = keyConfig?.halfLifeMs ?? config.defaultHalfLifeMs;

    const candidates: Candidate[] = [...perAgent.keys()]
      .sort()
      .map((agentId) => {
        const { event, value } = perAgent.get(agentId)!;
        const trustScore = agentMap.get(agentId)?.trustScore ?? 0;
        const ageMs = Math.max(0, toMs(effectiveAsOf) - toMs(event.eventTimestamp));
        const recency = recencyFactor(ageMs, halfLifeMs);
        const weight = trustScore * event.confidenceScore * recency;
        return {
          agentId,
          value,
          confidence: event.confidenceScore,
          trustScore,
          recency,
          weight,
          eventTimestamp: event.eventTimestamp,
        };
      });

    const allNumeric = candidates.every((c) => typeof c.value === 'number' && Number.isFinite(c.value));

    if (mode === 'weighted-average' && allNumeric) {
      const totalWeight = round(candidates.reduce((sum, c) => sum + c.weight, 0));
      const value =
        totalWeight > 0
          ? round(candidates.reduce((sum, c) => sum + (c.value as number) * c.weight, 0) / totalWeight)
          : round(candidates.reduce((sum, c) => sum + (c.value as number), 0) / candidates.length);
      const confidence = round(candidates.reduce((sum, c) => sum + c.confidence, 0) / candidates.length);

      facts[key] = { value, sourceAgentId: null, confidence, weight: totalWeight };

      if (new Set(candidates.map((c) => c.value)).size > 1) {
        contestedNotes.push(formatWeightedAverageNote(key, candidates, value, totalWeight));
      }
      continue;
    }

    const usedFallback = mode === 'weighted-average' && !allNumeric;
    const { winningGroup, groups } = pickHighestWeightGroup(candidates);
    const primary = [...winningGroup.members].sort(
      (a, b) => b.weight - a.weight || compareStrings(a.agentId, b.agentId)
    )[0]!;

    facts[key] = {
      value: winningGroup.value,
      sourceAgentId: primary.agentId,
      confidence: primary.confidence,
      weight: round(winningGroup.totalWeight),
    };

    if (groups.length > 1) {
      contestedNotes.push(formatHighestWeightNote(key, groups, winningGroup, usedFallback));
    }
  }

  const conflictResolutionNotes =
    contestedNotes.length > 0
      ? contestedNotes.join('\n')
      : `No conflicts were detected across ${sortedKeys.length} resolved fact key(s); each had either a single source or full agreement among sources.`;

  return { facts, asOfTimestamp: effectiveAsOf, conflictResolutionNotes };
}

interface ValueGroup {
  value: FactValue;
  totalWeight: number;
  members: Candidate[];
}

function pickHighestWeightGroup(candidates: Candidate[]): { winningGroup: ValueGroup; groups: ValueGroup[] } {
  const byValue = new Map<string, ValueGroup>();
  for (const candidate of candidates) {
    const valueKey = canonicalStringify(candidate.value);
    if (!byValue.has(valueKey)) {
      byValue.set(valueKey, { value: candidate.value, totalWeight: 0, members: [] });
    }
    const group = byValue.get(valueKey)!;
    group.totalWeight += candidate.weight;
    group.members.push(candidate);
  }

  // Deterministic group order: highest total weight first; ties broken by
  // the lexicographically smallest agent_id among each group's members
  // (documented, arbitrary-but-fixed, per CLAUDE.md §5 step 5).
  const groups = [...byValue.values()].sort((a, b) => {
    if (a.totalWeight !== b.totalWeight) return b.totalWeight - a.totalWeight;
    return compareStrings(minAgentId(a), minAgentId(b));
  });

  return { winningGroup: groups[0]!, groups };
}

function minAgentId(group: ValueGroup): string {
  return [...group.members].map((m) => m.agentId).sort()[0]!;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function maxTimestamp(events: EventRecord[]): string | undefined {
  if (events.length === 0) return undefined;
  return events.reduce((max, e) => (e.eventTimestamp > max ? e.eventTimestamp : max), events[0]!.eventTimestamp);
}

function toMs(iso: string): number {
  return Date.parse(iso);
}

/**
 * Exponential half-life decay: at age 0 the factor is 1; at age = halfLifeMs
 * it is 0.5; it approaches 0 as age grows. Deterministic given ageMs and
 * halfLifeMs — never touches wall-clock time itself.
 */
function recencyFactor(ageMs: number, halfLifeMs: number): number {
  if (halfLifeMs <= 0) return ageMs <= 0 ? 1 : 0;
  return Math.pow(2, -ageMs / halfLifeMs);
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function formatCandidateClause(c: Candidate): string {
  return `${c.agentId} asserted ${JSON.stringify(c.value)} (trust ${round(c.trustScore)} × confidence ${round(
    c.confidence
  )} × recency ${round(c.recency)} = weight ${round(c.weight)})`;
}

function formatHighestWeightNote(
  key: string,
  groups: ValueGroup[],
  winningGroup: ValueGroup,
  usedFallback: boolean
): string {
  const clauses = groups.map((group) => {
    const memberClauses = group.members.map(formatCandidateClause).join('; ');
    return group.members.length > 1
      ? `${memberClauses} (combined weight ${round(group.totalWeight)})`
      : memberClauses;
  });
  const fallbackNote = usedFallback
    ? ' (configured for weighted-average, but fell back to highest-weight because not every submitted value was numeric)'
    : '';
  return `For '${key}'${fallbackNote}: ${clauses.join('; ')}. The value ${JSON.stringify(
    winningGroup.value
  )} won with total weight ${round(winningGroup.totalWeight)}.`;
}

function formatWeightedAverageNote(
  key: string,
  candidates: Candidate[],
  value: number,
  totalWeight: number
): string {
  const clauses = candidates.map(formatCandidateClause).join('; ');
  return `For '${key}': ${clauses}. The weighted average ${value} was computed across ${candidates.length} source(s) with total weight ${round(
    totalWeight
  )}.`;
}
