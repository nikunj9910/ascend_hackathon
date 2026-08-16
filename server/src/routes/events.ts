import { Router } from 'express';
import { requireApiKey } from '../security/auth';
import { writeRateLimiter } from '../security/rateLimit';
import { withDocumentLock } from '../security/locks';
import { validate } from '../validation/validate';
import { eventSubmissionSchema, type EventSubmissionInput } from '../validation/schemas';
import { acceptEvent, findDuplicateFactKeys, fromSubmission } from '../db/ingest';

const router = Router();

router.post('/', writeRateLimiter, requireApiKey, validate(eventSubmissionSchema), async (req, res) => {
  const body = req.body as EventSubmissionInput;

  const duplicateKeys = findDuplicateFactKeys(body.facts);
  if (duplicateKeys.length > 0) {
    res.status(409).json({
      error: `This event cannot be reconciled: its own facts array asserts more than one value for the same key(s) (${duplicateKeys.join(
        ', '
      )}). An event may only submit one value per fact key — if the agent wants to revise a value, submit a separate, later event instead.`,
    });
    return;
  }

  const input = fromSubmission(body);
  const result = await withDocumentLock(input.documentId, () => acceptEvent(input));

  res.status(result.status === 'created' ? 201 : 200).json({
    document_id: result.state.document_id,
    version: result.state.version,
    facts: JSON.parse(result.state.facts),
    resolved_at: result.state.resolved_at,
    ...(result.status === 'duplicate' ? { note: 'This exact event was already recorded; no change was made.' } : {}),
  });
});

export default router;
