const locks = new Map<string, Promise<void>>();

/**
 * Serializes async work per document_id: concurrent writes to the same
 * document run one at a time, in call order; writes to different documents
 * run fully in parallel. This is the in-process replacement for a message
 * queue per CLAUDE.md §3 — no Redis/Kafka involved.
 *
 * A failure in one queued operation never wedges the queue: the internal
 * chain always settles, so the next caller's fn still runs. Each caller
 * still receives its own fn's real result or rejection.
 */
export function withDocumentLock<T>(documentId: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = locks.get(documentId) ?? Promise.resolve();
  const run = previous.then(fn, fn);

  const settleTracker: Promise<void> = run.then(
    () => undefined,
    () => undefined
  );
  locks.set(documentId, settleTracker);
  settleTracker.finally(() => {
    if (locks.get(documentId) === settleTracker) {
      locks.delete(documentId);
    }
  });

  return run;
}

/**
 * Acquires locks for a set of document_ids, always in sorted order, so that
 * two overlapping multi-document batches (e.g. two /events/replay calls)
 * can never acquire the same two locks in opposite order and deadlock.
 */
export async function withDocumentLocks<T>(documentIds: string[], fn: () => Promise<T> | T): Promise<T> {
  const sorted = [...new Set(documentIds)].sort();

  async function acquire(index: number): Promise<T> {
    if (index >= sorted.length) return fn();
    return withDocumentLock(sorted[index]!, () => acquire(index + 1));
  }

  return acquire(0);
}
