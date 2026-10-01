import { describe, expect, it } from 'vitest';
import { shieldDeposits as seamDeposits, type Intent } from '@strkworld/privacy';
import { shieldDeposits } from './shield-deposits.js';

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb';
const ONE = 10n ** 18n;
const pool = { feeToken: STRK, feeAmount: 6n * ONE };

describe("the shell's shield deposits match the seam's (D-094)", () => {
  const cases: Intent[][] = [
    [{ kind: 'shield', token: STRK, amount: 9n * ONE }],
    [{ kind: 'shield', token: STRK, amount: 9n * ONE }, { kind: 'shield', token: STRK, amount: ONE }],
    [{ kind: 'shield', token: USDC, amount: 7n }, { kind: 'shield', token: '0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d', amount: ONE }],
    [{ kind: 'unshield', token: STRK, amount: ONE, recipient: '0x1' }],
  ];

  it('amount + fee = deposit for the first STRK shield, and the note is the amount', () => {
    expect(shieldDeposits(cases[0]!, pool)).toEqual([15n * ONE]);
  });

  it.each(cases.map((intents, index) => [index, intents] as const))('agrees with the seam on case %i', (_index, intents) => {
    expect(shieldDeposits(intents, pool)).toEqual(seamDeposits(intents, pool));
  });
});
