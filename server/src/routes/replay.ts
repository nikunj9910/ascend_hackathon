import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { requireApiKey } from '../security/auth';
import { writeRateLimiter } from '../security/rateLimit';
import { withDocumentLocks } from '../security/locks';
import { validate } from '../validation/validate';
import { replaySchema, type ReplayInput } from '../validation/schemas';
import { acceptEventsBatch, findDuplicateFactKeys, fromSubmission, type EventInput } from '../db/ingest';
import { resolve } from '../resolution/resolve';
import { computeDedupeKey } from '../resolution/canonicalize';
import * as queries from '../db/queries';
import type { EventRecord } from '../resolution/types';

const router = Router();

/**
 * Only a persisting replay is a write — per CLAUDE.md §8 the bearer-token
 * requirement is scoped to POST /events/replay?persist=true. A dry run
 * (the default) is a pure read/compute endpoint and stays open for judges.
 */
function requireApiKeyIfPersisting(req: Request, res: Response, next: NextFunction): void {
  const persistRequested = req.query.persist === 'true' || req.body?.persist === true;
  if (persistRequested) {
    requireApiKey(req, res, next);
    return;
  }
  next();
}

router.post('/', writeRateLimiter, requireApiKeyIfPersisting, validate(replaySchema), async (req, res) => {
  const body = req.body as ReplayInput;
  const persist = body.persist || req.query.persist === 'true';

  for (const event of body.events) {
    const duplicateKeys = findDuplicateFactKeys(event.facts);
    if (duplicateKeys.length > 0) {
      res.status(409).json({
        error: `Event for document ${event.document_id} from agent ${event.agent_id} cannot be reconciled: its own facts array asserts more than one value for the same key(s) (${duplicateKeys.join(
          ', '
        )}).`,
      });
      return;
    }
  }

  const inputs = body.events.map(fromSubmission);

  if (persist) {
    const documentIds = inputs.map((i) => i.documentId);
    const results = await withDocumentLocks(documentIds, () => acceptEventsBatch(inputs));

    res.status(200).json({
      persisted: true,
      documents: [...results.entries()].map(([documentId, r]) => ({
        document_id: documentId,
        inserted_count: r.insertedCount,
        duplicate_count: r.duplicateCount,
        ...(r.state
          ? {
              version: r.state.version,
              facts: JSON.parse(r.state.facts),
              resolved_at: r.state.resolved_at,
              conflict_resolution_notes: r.state.conflict_resolution_notes,
            }
          : {}),
      })),
    });
    return;
  }

  res.status(200).json({ persisted: false, documents: computeDryRun(inputs) });
});

/** Computes resolved state purely from the provided events — never touches persisted data. */
function computeDryRun(inputs: EventInput[]) {
  const byDocument = new Map<string, EventInput[]>();
  for (const input of inputs) {
    if (!byDocument.has(input.documentId)) byDocument.set(input.documentId, []);
    byDocument.get(input.documentId)!.push(input);
  }

  const agents = queries.getAllAgents();

  return [...byDocument.entries()].map(([documentId, docInputs]) => {
    const events: EventRecord[] = docInputs.map((input) => {
      const dedupeKey = computeDedupeKey(input);
      return {
        id: dedupeKey,
        dedupeKey,
        agentId: input.agentId,
        documentId: input.documentId,
        eventType: input.eventType as EventRecord['eventType'],
        eventTimestamp: input.eventTimestamp,
        confidenceScore: input.confidenceScore,
        facts: input.facts,
      };
    });
    const resolved = resolve(documentId, events, agents);
    return {
      document_id: documentId,
      facts: resolved.facts,
      resolved_at: resolved.asOfTimestamp,
      conflict_resolution_notes: resolved.conflictResolutionNotes,
    };
  });
}

export default router;
