import { Router } from 'express';
import { validate } from '../validation/validate';
import { auditQuerySchema, documentIdParamSchema, documentStateQuerySchema } from '../validation/schemas';
import * as queries from '../db/queries';

const router = Router();

router.get(
  '/:id/state',
  validate(documentIdParamSchema, 'params'),
  validate(documentStateQuerySchema, 'query'),
  (req, res) => {
    const { id } = req.params as unknown as { id: string };
    const { version } = req.query as unknown as { version?: number };

    const row = version !== undefined ? queries.getDocumentStateAtVersion(id, version) : queries.getLatestDocumentState(id);
    if (!row) {
      res.status(404).json({
        error:
          version !== undefined
            ? `Document ${id} has no version ${version}.`
            : `Document ${id} has no resolved state yet — no events have been accepted for it.`,
      });
      return;
    }

    res.status(200).json({
      document_id: row.document_id,
      version: row.version,
      facts: JSON.parse(row.facts),
      resolved_at: row.resolved_at,
      conflict_resolution_notes: row.conflict_resolution_notes,
    });
  }
);

router.get('/:id/audit', validate(documentIdParamSchema, 'params'), validate(auditQuerySchema, 'query'), (req, res) => {
  const { id } = req.params as unknown as { id: string };
  const { page, limit } = req.query as unknown as { page: number; limit: number };

  const { rows, total } = queries.getAuditLogPage(id, page, limit);
  res.status(200).json({
    document_id: id,
    page,
    limit,
    total,
    has_more: page * limit < total,
    entries: rows.map((r) => ({ id: r.id, event_id: r.event_id, decision: r.decision, created_at: r.created_at })),
  });
});

export default router;
