import { z } from 'zod';

// Keeps a single malicious/broken event from ballooning storage or resolution
// cost; well above anything a real document-interpretation event needs.
export const MAX_FACTS_PER_EVENT = 50;
export const MAX_REPLAY_EVENTS = 1000;

export const factSchema = z
  .object({
    key: z.string().min(1).max(200),
    value: z.union([z.string().max(10_000), z.number().finite(), z.boolean(), z.null()]),
  })
  .strict();

export const eventTypeSchema = z.enum(['summary', 'metadata', 'extraction']);

/**
 * Body of POST /events. Only fields the submitter actually controls — id,
 * dedupe_key, received_at, created_at are server-generated.
 */
export const eventSubmissionSchema = z
  .object({
    agent_id: z.string().min(1).max(200),
    document_id: z.string().min(1).max(200),
    event_type: eventTypeSchema,
    event_timestamp: z.string().datetime({ message: 'event_timestamp must be an ISO 8601 UTC timestamp, e.g. 2026-01-01T00:00:00.000Z' }),
    confidence_score: z.number().min(0).max(1),
    facts: z.array(factSchema).min(1).max(MAX_FACTS_PER_EVENT),
  })
  .strict();

export type EventSubmissionInput = z.infer<typeof eventSubmissionSchema>;

/**
 * Body of POST /events/replay. Dry-run (persist: false) unless the caller
 * explicitly opts in — see CLAUDE.md §7.
 */
export const replaySchema = z
  .object({
    events: z.array(eventSubmissionSchema).min(1).max(MAX_REPLAY_EVENTS),
    persist: z.boolean().optional().default(false),
  })
  .strict();

export type ReplayInput = z.infer<typeof replaySchema>;

export const documentStateQuerySchema = z
  .object({
    version: z.coerce.number().int().positive().optional(),
  })
  .strict();

export const auditQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().optional().default(1),
    limit: z.coerce.number().int().positive().max(500).optional().default(50),
  })
  .strict();

export const documentIdParamSchema = z
  .object({
    id: z.string().min(1).max(200),
  })
  .strict();
