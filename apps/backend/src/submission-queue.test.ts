import { describe, expect, it } from 'vitest';
import { BoundedSubmissionQueue } from './submission-queue.js';

describe('BoundedSubmissionQueue', () => {
  it('removes an aborted pending request so it cannot relay later or occupy capacity', async () => {
    const queue = new BoundedSubmissionQueue(1, 1);
    let releaseFirst!: () => void;
    const first = queue.run(
      () => new Promise<string>((resolve) => { releaseFirst = () => resolve('first'); }),
      { allowQueue: true },
    );
    const controller = new AbortController();
    let abortedTaskRan = false;
    const aborted = queue.run(async () => {
      abortedTaskRan = true;
      return 'aborted';
    }, { allowQueue: true, signal: controller.signal });

    controller.abort(new DOMException('deadline', 'TimeoutError'));
    await expect(aborted).rejects.toMatchObject({ name: 'TimeoutError' });

    const replacement = queue.run(async () => 'replacement', { allowQueue: true });
    releaseFirst();
    await expect(first).resolves.toBe('first');
    await expect(replacement).resolves.toBe('replacement');
    expect(abortedTaskRan).toBe(false);
  });
});
