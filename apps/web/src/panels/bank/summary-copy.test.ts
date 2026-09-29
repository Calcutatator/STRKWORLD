import { describe, expect, it } from 'vitest';
import type { BatchWarning, Intent } from '@strkworld/privacy';
import { FakePrivacyOperations } from '@strkworld/privacy';
import { describeIntent, describeWarning, describeWarnings, formatTokenFigure } from './summary-copy.js';

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

describe('the deposit warning in its own token (D-072)', () => {
  const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb';
  const WBTC = '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac';
  const UNLISTED = '0x0123456789abcdef';
  const TAIL = 'is public: the amount and your address are visible on-chain.';
  const seam = (amount: bigint): BatchWarning => ({ kind: 'public-leg', detail: `Depositing ${amount} ${TAIL}` });

  it('states a shield\'s amount with its token\'s decimals and symbol', () => {
    expect(describeWarnings([seam(5n * 10n ** 17n)], [{ kind: 'shield', token: TOKEN, amount: 5n * 10n ** 17n }]))
      .toEqual([`Depositing 0.5 STRK ${TAIL}`]);
    expect(describeWarnings([seam(12_500000n)], [{ kind: 'shield', token: USDC, amount: 12_500000n }]))
      .toEqual([`Depositing 12.5 USDC ${TAIL}`]);
    expect(describeWarnings([seam(1n)], [{ kind: 'shield', token: WBTC, amount: 1n }]))
      .toEqual([`Depositing 0.00000001 WBTC ${TAIL}`]);
  });

  it('pairs each public leg with its own shield, in order, and leaves other warnings alone', () => {
    const intents: Intent[] = [
      { kind: 'shield', token: TOKEN, amount: 10n ** 18n },
      { kind: 'shield', token: USDC, amount: 2_000000n },
    ];
    const maturing: BatchWarning = { kind: 'funds-maturing', maturingAmount: 10n ** 18n, blocksRemaining: 3 };
    expect(describeWarnings([seam(10n ** 18n), maturing, seam(2_000000n)], intents)).toEqual([
      `Depositing 1 STRK ${TAIL}`,
      describeWarning(maturing),
      `Depositing 2 USDC ${TAIL}`,
    ]);
  });

  it('shows the seam\'s words when it cannot pair or describe the deposit', () => {
    const shield: Intent = { kind: 'shield', token: TOKEN, amount: 1n };
    // Two legs for one shield: nothing is paired.
    expect(describeWarnings([seam(1n), seam(2n)], [shield])).toEqual([`Depositing 1 ${TAIL}`, `Depositing 2 ${TAIL}`]);
    // A token the catalog cannot describe: no invented symbol.
    expect(describeWarnings([seam(9n)], [{ kind: 'shield', token: UNLISTED, amount: 9n }])).toEqual([`Depositing 9 ${TAIL}`]);
    // An unshield's leg names no raw amount; it passes through as written.
    const withdraw: BatchWarning = { kind: 'public-leg', detail: 'Withdrawing reveals the amount and 0xabc on-chain.' };
    expect(describeWarnings([withdraw], [{ kind: 'unshield', token: TOKEN, amount: 1n, recipient: BOB }]))
      .toEqual(['Withdrawing reveals the amount and 0xabc on-chain.']);
  });

  it('turns the fake\'s real shield warnings into figures, never base units', async () => {
    const operations = new FakePrivacyOperations();
    const intents: Intent[] = [
      { kind: 'shield', token: TOKEN, amount: 5n * 10n ** 17n },
      { kind: 'shield', token: USDC, amount: 12_500000n },
    ];
    const batch = await operations.prepare(intents);
    const lines = describeWarnings(batch.warnings, batch.intents);
    expect(lines).toEqual([`Depositing 0.5 STRK ${TAIL}`, `Depositing 12.5 USDC ${TAIL}`]);
    expect(lines.join(' ')).not.toMatch(/500000000000000000|12500000/);
  });

  it('describes a shield in any listed token, and an unlisted one by address and base units', () => {
    expect(describeIntent({ kind: 'shield', token: USDC, amount: 12_500000n })).toBe('Shield 12.5 USDC');
    expect(describeIntent({ kind: 'shield', token: TOKEN, amount: 5n * 10n ** 18n })).toBe('Shield 5 STRK');
    expect(formatTokenFigure(UNLISTED, 9n)).toBe('9 base units of 0x0123…bcdef');
  });
});
