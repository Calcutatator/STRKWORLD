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

// ---------------------------------------------------------------------------
// Unstaking reads (D-085)
// ---------------------------------------------------------------------------

/**
 * Endur's xSTRK withdrawal queue, an ERC-721 whose token ids are request
 * ids. Read over mainnet RPC at block 15,726,652, 2026-10-01 (class hash
 * `0x6b2e18936382d3f686472418a81ccac0a996a6261afe7416bc905be12903f34`); see
 * D-085. Every unstaking read targets it, xSTRK or STRK, and nothing else.
 */
export const ENDUR_WITHDRAWAL_QUEUE =
  '0x0518a66e579f9eb1603f5ffaeff95d3f013788e9c37ee94995555026b9648b6';

/**
 * `sn_keccak('WithdrawQueue')`: the queue's event for a request and for its
 * claim, keyed `[selector, receiver, caller]`, whose first data felt is the
 * request id. Pinned in endur-unstake.test.ts.
 */
export const WITHDRAW_QUEUE_EVENT_KEY =
  '0x178a5d05765f315f7a5af04455774aa1da91c981d246386797c2845f54036d1';

/** `sn_keccak('get_request_info')`, pinned in endur-unstake.test.ts. */
export const GET_REQUEST_INFO_SELECTOR =
  '0x25ae58a3ecedf764cbf050b77a4407ef1947fbc61e229224b4a19c86d022c3';

/**
 * No unstaking stand-in address can hold a request from before this block:
 * D-085 shipped after it. The scan never starts earlier.
 */
export const ENDUR_UNSTAKE_FIRST_BLOCK = 15_726_000;

/**
 * How far back a read looks for a stand-in address's requests: about twenty
 * days at mainnet's 1.7 s blocks, against Endur's seven-day wait. Endur's own
 * service pays a ready request once the queue is funded, so an unpaid one
 * older than this is rare; the queue's NFT count still reports it, as
 * unlisted.
 */
export const ENDUR_SCAN_WINDOW_BLOCKS = 1_000_000;

/**
 * Event pages one read may take; a node scans about 100,000 blocks a page,
 * so twelve cover the window. A scan that still has pages left stops and
 * marks the read incomplete rather than answering short in silence.
 */
export const ENDUR_SCAN_MAX_PAGES = 12;

/** Events asked for per page. */
export const ENDUR_EVENTS_CHUNK_SIZE = 100;

/** The most requests one read answers, newest kept. Bounds the read's fan-out. */
export const MAX_ENDUR_REQUESTS = 16;

/**
 * The most `claim_withdrawal` dry runs one read makes, oldest due first: a
 * claim batch takes at most eight requests (`MAX_ENDUR_CLAIMS_PER_BATCH` in
 * the privacy package), so more would be read for nothing.
 */
export const MAX_ENDUR_CLAIM_DRY_RUNS = 8;

/**
 * `sn_keccak('claim_withdrawal')`, pinned in endur-unstake.test.ts. Called
 * read-only (`starknet_call`, never submitted) to ask whether a request past
 * its wait can be paid now: it reverts "Insufficient funds" until Endur funds
 * the queue, which its relayer usually does in the same transaction as its
 * own claim. Verified 2026-10-01: #10583 (past due) reverts at the head, and
 * #10451, #10468 and #10469 answered `[]` one block before their owner's
 * successful claims (D-085).
 */
export const CLAIM_WITHDRAWAL_SELECTOR =
  '0x21f0805850429de79467c1fc548640828b4d2ce0d7ed0efdedfb5305dbc8def';

/** What a stand-in address holds at Endur (D-085). */
export const ENDUR_UNSTAKE_PATH = '/v1/rpc/endur-unstake';
