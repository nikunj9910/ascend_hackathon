import type { ResolutionConfig } from './types';

/**
 * Default resolution config. Resolution mode and recency half-life are
 * per-fact-key, not per-agent — this is what keeps "no universal winner"
 * true: nothing here names an agent_id.
 */
export const DEFAULT_RESOLUTION_CONFIG: ResolutionConfig = {
  defaultMode: 'highest-weight',
  defaultHalfLifeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  perKey: {
    invoice_total: { mode: 'weighted-average', halfLifeMs: 7 * 24 * 60 * 60 * 1000 },
    line_item_count: { mode: 'weighted-average' },
    confidence_estimate: { mode: 'weighted-average' },
  },
};
