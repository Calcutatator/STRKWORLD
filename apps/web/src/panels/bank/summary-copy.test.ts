import { describe, expect, it } from 'vitest';
import type { BatchWarning, Intent } from '@strkworld/privacy';
import { describeIntent, describeWarning } from './summary-copy.js';

const TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const BOB = '0x02b4c7d1a1f8f39e0e6e8b9a2c7d0e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293';

describe('summary copy', () => {
  it('states amounts exactly — these are the figures being agreed to', () => {
    const intent: Intent = { kind: 'shield', token: TOKEN, amount: 1_999999999999999999n };
    // Not 1.9999: a truncated figure is a different number to the one signed.
    expect(describeIntent(intent)).toContain('1.999999999999999999');
  });

  it('never promises how many times the wallet will ask', () => {
    // D-028 keeps prompt sequence provisional until the funded run, and
    // SPEC §5 rule 5 forbids encoding wallet behaviour into copy.
    const warning: BatchWarning = { kind: 'multiple-prompts', count: 2 };
    const text = describeWarning(warning);
    expect(text).not.toMatch(/\d/);
    expect(text.toLowerCase()).toContain('more than once');
  });

  it('passes a public-leg detail through as the seam wrote it', () => {
    const warning: BatchWarning = { kind: 'public-leg', detail: 'Depositing 5 is public.' };
    expect(describeWarning(warning)).toBe('Depositing 5 is public.');
  });

  it('describes a transfer with its recipient shortened for display', () => {
    const intent: Intent = { kind: 'transfer', token: TOKEN, amount: 10n ** 18n, recipient: BOB };
    expect(describeIntent(intent)).toContain('→');
    expect(describeIntent(intent)).not.toContain(BOB);
  });
});
