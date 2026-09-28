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

  it('renders an approximate wait for maturing funds from blocksRemaining', () => {
    const warning: BatchWarning = { kind: 'funds-maturing', maturingAmount: 10n ** 18n, blocksRemaining: 42 };
    const text = describeWarning(warning);
    expect(text).toContain('about 42 blocks');
    // No block-time constant exists in this repo; a seconds estimate would be invented.
    expect(text).not.toMatch(/second/i);
  });

  it('keeps the maturity wait singular for exactly one block', () => {
    const warning: BatchWarning = { kind: 'funds-maturing', maturingAmount: 1n, blocksRemaining: 1 };
    expect(describeWarning(warning)).toContain('about 1 block');
    expect(describeWarning(warning)).not.toContain('1 blocks');
  });

  it('describes a stake as exact STRK in and xSTRK out, with no output figure', () => {
    const XSTRK = '0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a';
    const intent: Intent = { kind: 'stake', tokenIn: TOKEN, tokenOut: XSTRK, amountIn: 5_000000000000000001n };
    expect(describeIntent(intent)).toBe('Stake 5.000000000000000001 STRK → xSTRK');
  });

  it('describes a transfer with its recipient shortened for display', () => {
    const intent: Intent = { kind: 'transfer', token: TOKEN, amount: 10n ** 18n, recipient: BOB };
    expect(describeIntent(intent)).toContain('→');
    expect(describeIntent(intent)).not.toContain(BOB);
  });
});
