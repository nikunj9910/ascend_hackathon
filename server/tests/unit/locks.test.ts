import { describe, expect, it } from 'vitest';
import { withDocumentLock } from '../../src/security/locks';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('withDocumentLock', () => {
  it('serializes concurrent operations on the same document_id in call order', async () => {
    const order: number[] = [];
    const tasks = [1, 2, 3].map((n) =>
      withDocumentLock('doc-A', async () => {
        await delay(10 - n); // later-queued tasks would finish first if unserialized
        order.push(n);
      })
    );
    await Promise.all(tasks);
    expect(order).toEqual([1, 2, 3]);
  });

  it('runs operations on different document_ids concurrently, not serialized', async () => {
    const start = Date.now();
    await Promise.all([
      withDocumentLock('doc-A', () => delay(30)),
      withDocumentLock('doc-B', () => delay(30)),
    ]);
    expect(Date.now() - start).toBeLessThan(55);
  });

  it('propagates each call rejection to its own caller without breaking the queue for later calls', async () => {
    await expect(
      withDocumentLock('doc-C', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const result = await withDocumentLock('doc-C', () => 'still works');
    expect(result).toBe('still works');
  });
});
