/**
 * The Vault's two public chain reads (D-077), pinned here independently of the
 * browser.
 *
 * The Vault lends STRK to Vesu from the player's STRK20 shadow account: a
 * keyless address the canonical `ShadowAccountAnonymizer` derives for the
 * player and this dapp. Finding that address, and reading the position it
 * holds, are public reads. They come through this service rather than a
 * third-party RPC for the reason D-014 gives for the recipient preflight and
 * receipt polling: the player's IP next to their partial commitment or their
 * stand-in address is exactly the link the shadow account exists to hide. The
 * service logs nothing per request, and a request cannot name a contract or a
 * selector: both routes read the pinned contracts below and nothing else.
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
/** A stand-in address's vSTRK position (D-077). */
export const VAULT_POSITION_PATH = '/v1/rpc/vault-position';
