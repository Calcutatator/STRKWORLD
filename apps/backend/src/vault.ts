/**
 * The Vault's public reads (D-077, D-079), pinned here independently of the
 * browser.
 *
 * The Vault lends to Vesu from the player's STRK20 shadow account: a keyless
 * address the canonical `ShadowAccountAnonymizer` derives for the player and
 * this dapp. Finding that address, and reading the positions it holds, are
 * public reads. They come through this service rather than a third-party RPC
 * for the reason D-014 gives for the recipient preflight and receipt polling:
 * the player's IP next to their partial commitment or their stand-in address
 * is exactly the link the shadow account exists to hide. The service logs
 * nothing per request, and a request cannot name a contract or a selector:
 * every route reads the pinned contracts below and nothing else. The third,
 * Vesu's supply APY (D-079), is read from Vesu's public API by this service
 * alone, so Vesu never sees a player's IP either.
 *
 * Mainnet only, like the rest of this service.
 */

/**
 * The canonical `ShadowAccountAnonymizer`, deployed by StarkWare. Its
 * `get_privacy_contract()` is the STRK20 pool; its `get_shadow_accounts`
 * resolves a partial commitment to shadow accounts by nonce. Read from the
 * deployed class (class hash
 * `0xb61dee4f9f6b243f5310fbfab4224128db5c4815077b6329c232f8fc9af409`) at
 * block 15,636,298, 2026-09-29; see D-077.
 */
export const SHADOW_ACCOUNT_ANONYMIZER =
  '0x04f33230dc57855c6e7eabe66dfa0fde82c5458fd0e54827cdb7cb4c474888a7';

/**
 * Vesu's vSTRK vault ("Vesu Starknet", ERC-4626 over STRK, 18 decimals) in
 * its Prime pool. Read from the deployed contract (class hash
 * `0x41b16e0ca0565a58d1379ffc3c7eab7459b382ba8f8208b3b87d18d2aed4f78`) at
 * block 15,636,298, 2026-09-29; see D-077.
 */
export const VESU_VSTRK =
  '0x06d6d2bf905dd199c78f2e421521d8473042737be9f47904e7578536c10f279d';

/**
 * Vesu's Prime pool, whose vaults these are: each one's `pool_contract()`
 * returns it (D-079).
 */
export const VESU_PRIME_POOL =
  '0x0451fe483d5921a2919ddd81d0de6696669bccdacd859f72a4fba7656b97c3b5';

/** A vault this service reads, and the token it lends. */
export interface PinnedVault {
  readonly token: string;
  readonly vault: string;
}

/**
 * Every Vesu Prime vault the Vault lends through, in the browser's order
 * (D-079), pinned here independently: `vault.test.ts` checks this list
 * against the privacy package's `VAULT_MARKETS`, token for token. Each was
 * read on mainnet at block 15,669,141 on 2026-09-30: `asset()` is its token,
 * `pool_contract()` the Prime pool, and its class vSTRK's
 * (`0x41b16e0ca0565a58d1379ffc3c7eab7459b382ba8f8208b3b87d18d2aed4f78`).
 * STRK, ETH, Circle's USDC, USDT, WBTC.
 */
export const VESU_VAULTS: readonly PinnedVault[] = Object.freeze([
  { token: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d', vault: VESU_VSTRK },
  { token: '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7', vault: '0x006ac248c18c69e57573aa3eeccbb7f8cd29e3024561be252ee7b34b96c1043e' },
  { token: '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb', vault: '0x00387e8ddbb1ab36ca08874d9abc702ef4872ad600dcf76b7f240b71d7bc4e65' },
  { token: '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8', vault: '0x06be9f8980779930045b93c295105c6810d38191ec522b5175ddf7dbf9b22f9d' },
  { token: '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac', vault: '0x04ecb0667140b9f45b067d026953ed79f22723f1cfac05a7b26c3ac06c88f56c' },
].map((entry) => Object.freeze(entry)));

/**
 * Vesu's public pool endpoint for the Prime pool: no key, and nothing from a
 * request reaches it. Its `assets` list each token's vToken and
 * `stats.supplyApy` (D-079).
 */
export const VESU_PRIME_POOL_API_URL = `https://api.vesu.xyz/pools/${VESU_PRIME_POOL}`;

/** `sn_keccak('get_shadow_accounts')`, pinned in vault.test.ts. */
export const GET_SHADOW_ACCOUNTS_SELECTOR =
  '0x21108f52038fd171399fadd200a5243018cee55ae27e6a44e948df18d4b779f';
/** `sn_keccak('preview_redeem')`, pinned in vault.test.ts. */
export const PREVIEW_REDEEM_SELECTOR =
  '0x82c661d8fec0d7c2d8de38b2276e2ae2976aee47a3860369fe9594d5dd9e45';
/** `sn_keccak('max_withdraw')`, pinned in vault.test.ts. */
export const MAX_WITHDRAW_SELECTOR =
  '0x1b8c63e132bbd5b9eaffa415eadeeeb1bd75050efa9dbc4697ddb3e46f10d71';
/** `sn_keccak('max_redeem')`, pinned in vault.test.ts. */
export const MAX_REDEEM_SELECTOR =
  '0x24101f2b9fd275ad1325d86746340993673fa341d415f6ead337a25e1a82aba';

/** The shadow account for a partial commitment, at nonce 0 (D-077). */
export const VAULT_SHADOW_ACCOUNT_PATH = '/v1/rpc/shadow-account';
/** A stand-in address's position in every pinned vault (D-077, D-079). */
export const VAULT_POSITION_PATH = '/v1/rpc/vault-position';
/** Vesu's supply APY for every pinned vault, from this service's cache (D-079). */
export const VAULT_RATES_PATH = '/v1/vault-rates';
