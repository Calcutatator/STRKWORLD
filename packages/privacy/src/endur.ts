/**
 * Endur liquid staking through its STRK20 anonymizer (D-063).
 *
 * Protocol constants, not configuration. The shell never supplies a target,
 * selector or calldata (D-018): this package pins the one contract and the one
 * token pair the stake route admits, and the backend relay pins the same
 * values independently before it sponsors a submission. Mainnet only (D-001).
 */

/**
 * `EndurDepositAnonymizer`. Its only entry point is
 * `privacy_invoke(in_token: ContractAddress, out_token: ContractAddress,
 * assets: u256, note_id: felt252) -> Span<OpenNoteDeposit>`. The pool calls it
 * through its fixed `INVOKE_SELECTOR`; a Wallet API `invoke` action names only
 * the contract and calldata, never a selector. The constructor takes no
 * arguments, so the helper does not pin a token pair itself — this package
 * does.
 *
 * Read from the deployed class ABI (class hash
 * `0x15ec74f602ca506c352c193ebe26dd7559ee34bcc2549e8590059d2ea58e77a`),
 * 2026-09-27; see D-063.
 */
export const ENDUR_DEPOSIT_ANONYMIZER =
  '0x030dee638065962eb3642ca54aa48e9e2cd98536bc90b64b99bb306c1db30698';

/**
 * Endur xSTRK, an ERC-4626 vault. The shares the anonymizer mints are
 * credited to the player's open note in this token.
 *
 * Read from the deployed contract (`name` "Endur xSTRK", `asset` STRK,
 * `decimals` 18) over mainnet RPC, 2026-09-27; see D-063.
 */
export const ENDUR_XSTRK =
  '0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a';

/** xSTRK `decimals()`. Read from the deployed contract, 2026-09-27; see D-063. */
export const ENDUR_XSTRK_DECIMALS = 18;

/**
 * STRK, which is xSTRK's ERC-4626 `asset()` and the only token the stake route
 * accepts.
 *
 * Read from the deployed xSTRK contract over mainnet RPC, 2026-09-27; see D-063.
 */
export const ENDUR_XSTRK_ASSET =
  '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
