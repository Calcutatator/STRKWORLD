import { PrivacyError } from './types.js';

const BASIS_POINTS = 10_000n;

/** Compute AVNU's protected minimum using exact integer basis-point arithmetic. */
export function protectedMinimumOut(expectedAmountOut: bigint, slippageBps: number): bigint {
  if (typeof expectedAmountOut !== 'bigint' || expectedAmountOut <= 0n) {
    throw new PrivacyError('unknown', 'The private swap expected output is malformed.');
  }
  if (!Number.isSafeInteger(slippageBps) || slippageBps <= 0 || slippageBps > 10_000) {
    throw new PrivacyError('unknown', 'The private swap slippage policy is invalid.');
  }
  const protectedMinimum = expectedAmountOut -
    (expectedAmountOut * BigInt(slippageBps)) / BASIS_POINTS;
  if (protectedMinimum <= 0n) {
    throw new PrivacyError('unknown', 'The private swap protected minimum is nonpositive.');
  }
  return protectedMinimum;
}
