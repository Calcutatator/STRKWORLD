/**
 * Endur private staking (D-063), pinned here independently of the browser.
 *
 * The relay sponsors a `stake` submission only when its one external invoke
 * targets this anonymizer with STRK in and xSTRK out. Without that pin a relay
 * fee authorization would become a generic sponsored anonymizer call. The
 * anonymizer's constructor takes no arguments, so it pins no pair itself.
 * Mainnet only, like the rest of this service.
 */

/**
 * `EndurDepositAnonymizer`: `privacy_invoke(in_token, out_token, assets: u256,
 * note_id: felt252) -> Span<OpenNoteDeposit>`. Read from the deployed class
 * ABI, 2026-09-27; see D-063.
 */
export const ENDUR_DEPOSIT_ANONYMIZER =
  '0x030dee638065962eb3642ca54aa48e9e2cd98536bc90b64b99bb306c1db30698';

/** Endur xSTRK (ERC-4626, 18 decimals). Read from the deployed contract, 2026-09-27; see D-063. */
export const ENDUR_XSTRK =
  '0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a';

/** STRK, xSTRK's `asset()`. Read from the deployed xSTRK contract, 2026-09-27; see D-063. */
export const ENDUR_XSTRK_ASSET =
  '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
