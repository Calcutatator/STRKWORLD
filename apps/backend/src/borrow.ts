import { VESU_PRIME_POOL } from './vault.js';

/**
 * The Borrow counter's public reads (D-083), pinned here independently of the
 * browser.
 *
 * The player borrows on Vesu's Prime pool from their STRK20 shadow account for
 * this dapp (`strkworld-borrow`, nonce 0), found through the Vault's unchanged
 * shadow-account route. The pool's market figures (each token's price, rate
 * accumulator and utilisation inputs, each pair's limits) and the positions
 * that shadow account holds are public reads. They come through this service
 * rather than a third-party RPC for the reason D-014 gives for the recipient
 * preflight and receipt polling: the player's IP next to their stand-in
 * address is exactly the link the shadow account exists to hide. The service
 * logs nothing per request and never logs or keeps the account, and a request
 * cannot name a contract, a token or a selector: both routes read the pinned
 * pool below, for the pinned tokens below, and nothing else.
 *
 * Mainnet only, like the rest of this service.
 */

/** Vesu's Prime pool (D-079, D-083): the one pool the Borrow counter reads. */
export const BORROW_POOL = VESU_PRIME_POOL;

/**
 * The tokens the Borrow counter lends against and borrows, in its order:
 * STRK, ETH, USDC, USDT, WBTC, each a Prime pool asset (D-083).
 */
export const BORROW_TOKENS: readonly string[] = Object.freeze([
  '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
  '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7',
  '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb',
  '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8',
  '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac',
]);

/** A pinned (collateral, debt) pair of the Prime pool. */
export interface BorrowPair {
  readonly collateral: string;
  readonly debt: string;
}

/**
 * Every ordered (collateral, debt) pair of distinct `BORROW_TOKENS`,
 * collateral-major in token order: STRK→ETH, STRK→USDC, STRK→USDT, STRK→WBTC,
 * ETH→STRK, … (twenty).
 */
export const BORROW_PAIRS: readonly BorrowPair[] = Object.freeze(
  BORROW_TOKENS.flatMap((collateral) => BORROW_TOKENS
    .filter((debt) => debt !== collateral)
    .map((debt) => Object.freeze({ collateral, debt }))),
);

/** `sn_keccak('position')`, pinned in borrow.test.ts. */
export const POSITION_SELECTOR =
  '0x334f8ce3b01e25d0b6fe82d0fdb6eb534f3183d7dc5a6bb44d8eb9f676f650c';
/** `sn_keccak('pair_config')`, pinned in borrow.test.ts. */
export const PAIR_CONFIG_SELECTOR =
  '0x171c2fae45c0df09f8253d0a3bdf9756051f8fa442f4349827736d3e3135c06';
/** `sn_keccak('pairs')`, pinned in borrow.test.ts. */
export const PAIRS_SELECTOR =
  '0x26a6843931e99852362ca0dabb728b39e089c8c1788cda36477a012fa9967b9';
/** `sn_keccak('price')`, pinned in borrow.test.ts. */
export const PRICE_SELECTOR =
  '0x2bd803c09c6b34a4d86ee95434129ea89232e91fab09f9e5dc6fe984fa9a6f';
/** `sn_keccak('asset_config')`, pinned in borrow.test.ts. */
export const ASSET_CONFIG_SELECTOR =
  '0x40a1db21c93dd4b0a09e752c7b8cc7db2b84275621c8d2941edd851a22b56f';

/** Every pinned token's price and asset config, and every pinned pair's limits and debt (D-083). */
export const BORROW_MARKET_PATH = '/v1/rpc/borrow-market';
/** A stand-in address's position in every pinned pair (D-083). */
export const BORROW_POSITION_PATH = '/v1/rpc/borrow-position';
