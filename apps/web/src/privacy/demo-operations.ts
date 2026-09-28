import { FakePrivacyOperations, type Address } from '@strkworld/privacy';
import { DEMO_DEGEN_EXPIRES_AT, DEMO_DEGEN_RATES, DEMO_DEGEN_SLIPPAGE_BPS } from './demo-degen.js';

/**
 * The shell's default financial seam: the deterministic fake.
 *
 * This is not a placeholder to be swapped out later and forgotten. The shell is
 * built and tested end to end against `FakePrivacyOperations` on purpose — it
 * is what makes a mainnet-only project (D-001) survivable, and it is the same
 * property the forward-compatibility test relies on: if an implementation that
 * is neither a wallet nor a chain can drive every room, a real wallet will.
 *
 * The production adapter implements the identical interface, so wiring it in is
 * one argument at the composition root, not a rewrite.
 */

/**
 * The canonical public STRK token contract on Starknet mainnet, and the pool's
 * fee token. A public contract address, not a credential — the same value in
 * `packages/privacy/src/testing/fake.ts` is the known gitleaks false positive
 * recorded in the AGENTS.md findings log.
 */
const STRK: Address = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

/** A neighbour who has registered with the pool, so transfers have a target. */
export const DEMO_NEIGHBOUR: Address =
  '0x02b4c7d1a1f8f39e0e6e8b9a2c7d0e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293';

/** The practice balance a funded demo player starts with. */
export const DEMO_PRACTICE_BALANCE = 250n * 10n ** 18n;

/**
 * The demo seam.
 *
 * A fresh demo player has nothing in the pool, like a new player at D-072's
 * entry gate, and deposits their way in. `funded` starts them with the old
 * 250 STRK practice balance instead, so tests (and the gate's pass path) need
 * no deposit first.
 *
 * DEMO ONLY: notes mature at once (a zero-block window), so a practice deposit
 * is spendable in the Bank, Exchange and Post Office straight away. The real
 * pool makes new notes wait (`PoolConfig.noteMaturityBlocks`), and the demo has
 * no clock to advance blocks with.
 */
export function createDemoOperations({ funded = false }: { funded?: boolean } = {}): FakePrivacyOperations {
  return new FakePrivacyOperations({
    ...(funded ? { balances: { [STRK]: DEMO_PRACTICE_BALANCE } } : {}),
    poolConfig: { noteMaturityBlocks: 0 },
    registered: [DEMO_NEIGHBOUR],
    swapReview: {
      expectedAmountOut: 2n * 10n ** 18n,
      slippageBps: 50,
      expiresAt: 4_102_444_800_000,
    },
    // The degen floor's DEMO rates (D-067): explicit fixtures, never prices.
    demoSwapRates: {
      perStrk: DEMO_DEGEN_RATES,
      slippageBps: DEMO_DEGEN_SLIPPAGE_BPS,
      expiresAt: DEMO_DEGEN_EXPIRES_AT,
    },
  });
}
