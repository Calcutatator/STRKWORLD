import { FakePrivacyOperations, type Address } from '@strkworld/privacy';

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

export function createDemoOperations(): FakePrivacyOperations {
  return new FakePrivacyOperations({
    balances: { [STRK]: 250n * 10n ** 18n },
    registered: [DEMO_NEIGHBOUR],
  });
}
