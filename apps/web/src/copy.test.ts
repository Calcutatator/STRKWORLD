import { describe, expect, it } from 'vitest';
import { PRIVACY_REGISTER } from './privacy/register.js';
import { COPY, allCopyStrings } from './copy.js';

describe('shell copy', () => {
  it('says "your wallet", never "your extension"', () => {
    // v1 happens to ship against browser wallets. The forward-compatibility
    // design (SPEC §5 rule 5) exists so a web or embedded wallet can appear
    // with no rewrite, and copy naming the delivery mechanism would age the
    // day it does.
    for (const line of allCopyStrings()) {
      expect(line.toLowerCase(), line).not.toContain('extension');
    }
  });

  it('holds no local copy of an approved privacy disclosure (D-024)', () => {
    const lines = allCopyStrings();
    for (const entry of PRIVACY_REGISTER) {
      if (!entry.disclosure) continue;
      for (const line of lines) {
        expect(line, `${entry.route} disclosure restated in shell copy`).not.toContain(
          entry.disclosure,
        );
      }
    }
  });

  it('has a player-facing sentence for every failure class', () => {
    for (const [kind, text] of Object.entries(COPY.errors)) {
      expect(text.length, kind).toBeGreaterThan(10);
    }
  });

  it('uses the exact D-034 uncertainty copy without a retry or failure claim', () => {
    const copy = COPY.errors['submission-uncertain'];
    expect(copy).toBe(
      'We could not confirm whether this private action was submitted. Do not retry it yet. Reconnect, wait a few minutes, and refresh your private balance before taking another action.',
    );
    expect(copy).not.toContain('Try again');
    expect(copy).not.toContain('Nothing was sent');
  });

  it('never promises that timing or a batch hides more than it does', () => {
    for (const line of allCopyStrings()) {
      expect(line.toLowerCase(), line).not.toContain('untraceable');
      expect(line.toLowerCase(), line).not.toContain('completely private');
      expect(line.toLowerCase(), line).not.toContain('anonymous forever');
    }
  });
});
