import { describe, expect, it } from 'vitest';
import { AVATAR_BODY_SIZE } from './avatar-visual.js';

describe('avatar collision body', () => {
  it('keeps the gameplay collision body at the prior 24px footprint', () => {
    expect(AVATAR_BODY_SIZE).toBe(24);
  });
});
