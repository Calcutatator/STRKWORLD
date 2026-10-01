import type { STRK20_ACTION } from 'starknet';

/**
 * Endur liquid staking through its STRK20 anonymizer (D-063), and private
 * unstaking through the player's STRK20 shadow account (D-085).
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

// ---------------------------------------------------------------------------
// Unstaking through a shadow account (D-085)
// ---------------------------------------------------------------------------

/**
 * Endur's xSTRK withdrawal queue, an ERC-721: `request_withdrawal(assets: u256,
 * shares: u256, receiver) -> u128`, which only xSTRK calls (its `redeem` and
 * `withdraw` burn the shares and queue the STRK), `claim_withdrawal(request_id:
 * u128)`, `get_request_info(request_id) -> WithdrawRequest` and ERC-721's
 * `balance_of(owner)`. A request mints its NFT to the receiver with a plain
 * mint, not `safe_mint`: a simulated xSTRK `redeem` naming a live shadow
 * account (which has no SRC5 and no `on_erc721_received`) as receiver
 * succeeded, and `request_withdrawal` made no call to the receiver. Anyone may
 * call `claim_withdrawal`: it burns the NFT and pays the STRK to its owner, and
 * Endur's own service claims requests once they are ready and funded.
 *
 * Read over mainnet RPC at block 15,726,652, 2026-10-01 (class hash
 * `ENDUR_WITHDRAWAL_QUEUE_CLASS_HASH`); see D-085.
 */
export const ENDUR_WITHDRAWAL_QUEUE =
  '0x0518a66e579f9eb1603f5ffaeff95d3f013788e9c37ee94995555026b9648b6';

/** The queue's class at the read above (D-085). */
export const ENDUR_WITHDRAWAL_QUEUE_CLASS_HASH =
  '0x6b2e18936382d3f686472418a81ccac0a996a6261afe7416bc905be12903f34';

/**
 * The queue's wait: every one of the 200 requests before #10589 had
 * `claimTime` exactly `timestamp + 604,800` (seven days). Read, not
 * enforced here: the chain's own `claimTime` decides, and Endur can change
 * it. A ready request still pays only once the queue holds the STRK
 * ("Insufficient funds" otherwise), D-085.
 */
export const ENDUR_OBSERVED_CLAIM_DELAY_SECONDS = 604_800;

/**
 * The unstaking counter's `dapp_name`. Its own, never the Vault's: one name
 * per protocol keeps a player's Endur requests off their Vault address, so the
 * two are not linked on-chain. Part of every player's unstaking stand-in
 * address, so fixed for good (D-085).
 */
export const ENDUR_DAPP_NAME = 'strkworld-endur';

/** The one shadow account per player for unstaking (D-085). */
export const ENDUR_SHADOW_NONCE = '0x0';

/** The most ready requests one claim pays out; more wait for the next one. */
export const MAX_ENDUR_CLAIMS_PER_BATCH = 8;

const ENDUR_U128_MASK = (1n << 128n) - 1n;
const ENDUR_MAX_UINT256 = (1n << 256n) - 1n;
const ENDUR_ADDRESS_BOUND = 1n << 251n;

/**
 * The unstake request the wallet proves (D-085), flow A:
 *
 * 1. if xSTRK already sits on the stand-in address (`leftover`), open an
 *    xSTRK note for the player, which the invoke fills with it;
 * 2. withdraw `shares` xSTRK from the pool to the shadow account: the public
 *    leg;
 * 3. through the shadow account, xSTRK's `redeem(shares, receiver, owner)`
 *    with the shadow account as both, which burns exactly those shares and
 *    queues the STRK, minting the request NFT to the shadow account;
 * 4. collect every xSTRK left on it into the open note (`all`), or nothing
 *    (`exact 0`, no note) when nothing was left.
 *
 * Nothing returns yet: the STRK is paid to the shadow account when the queue
 * releases it, and a claim moves it into the pool.
 */
export function endurUnstakeRequestActions(input: {
  shadowAccount: string;
  player: string;
  shares: bigint;
  leftover: bigint;
}): STRK20_ACTION[] {
  const shadow = endurAddress(input.shadowAccount);
  const player = endurAddress(input.player);
  const shares = endurU256(input.shares, true);
  if (typeof input.leftover !== 'bigint' || input.leftover < 0n || input.leftover > ENDUR_MAX_UINT256) {
    throw new Error('Invalid Endur amount.');
  }
  const returnsLeftover = input.leftover > 0n;
  return [
    ...(returnsLeftover
      ? [{ type: 'transfer', token: ENDUR_XSTRK, amount: 'OPEN', recipient: player } as STRK20_ACTION]
      : []),
    { type: 'withdraw', token: ENDUR_XSTRK, amount: endurFelt(input.shares), recipient: shadow },
    {
      type: 'shadow_account_invoke',
      dapp_name: ENDUR_DAPP_NAME,
      nonce: ENDUR_SHADOW_NONCE,
      calls: [
        { contractAddress: ENDUR_XSTRK, entrypoint: 'redeem', calldata: [...shares, shadow, shadow] },
      ],
      collect_policy: returnsLeftover ? { type: 'all' } : { type: 'exact', amount: '0x0' },
    },
  ];
}

/**
 * The claim the wallet proves (D-085), flow B:
 *
 * 1. open one STRK note for the player;
 * 2. through the shadow account, `claim_withdrawal(id)` for each ready request
 *    still unpaid (at most `MAX_ENDUR_CLAIMS_PER_BATCH`), or, when Endur's own
 *    service has already paid every one, a `balance_of` read of the shadow
 *    account's STRK, since an invoke needs at least one call;
 * 3. collect every STRK on the shadow account (`all`) into the note: what
 *    these claims paid and what Endur already paid there. The shadow account
 *    is unstaking's alone, so all its STRK came from its requests.
 */
export function endurUnstakeClaimActions(input: {
  shadowAccount: string;
  player: string;
  requestIds: readonly bigint[];
}): STRK20_ACTION[] {
  const shadow = endurAddress(input.shadowAccount);
  const player = endurAddress(input.player);
  const ids = [...input.requestIds];
  if (ids.length > MAX_ENDUR_CLAIMS_PER_BATCH) throw new Error('Too many Endur claims in one batch.');
  const seen = new Set<bigint>();
  for (const id of ids) {
    if (typeof id !== 'bigint' || id < 0n || id > ENDUR_U128_MASK || seen.has(id)) throw new Error('Invalid Endur request.');
    seen.add(id);
  }
  const calls = ids.length > 0
    ? ids.map((id) => ({ contractAddress: ENDUR_WITHDRAWAL_QUEUE, entrypoint: 'claim_withdrawal', calldata: [endurFelt(id)] }))
    : [{ contractAddress: ENDUR_XSTRK_ASSET, entrypoint: 'balance_of', calldata: [shadow] }];
  return [
    { type: 'transfer', token: ENDUR_XSTRK_ASSET, amount: 'OPEN', recipient: player },
    {
      type: 'shadow_account_invoke',
      dapp_name: ENDUR_DAPP_NAME,
      nonce: ENDUR_SHADOW_NONCE,
      calls,
      collect_policy: { type: 'all' },
    },
  ];
}

/** One request as the chain records it, before it is classified. */
export interface EndurRequestRecord {
  readonly requestId: bigint;
  readonly assets: bigint;
  readonly shares: bigint;
  readonly claimed: boolean;
  readonly requestedAt: number;
  readonly claimableAt: number;
  /** A read-only `claim_withdrawal` dry run succeeded: past its wait, unpaid and funded. */
  readonly claimableNow: boolean;
}

/** An unpaid request, classified against the chain's clock. */
export interface EndurPendingRequest {
  readonly requestId: bigint;
  readonly assets: bigint;
  readonly shares: bigint;
  readonly requestedAt: number;
  readonly claimableAt: number;
  /**
   * `waiting` before `claimableAt`; then `awaiting-funds` until Endur funds
   * its queue (a claim would revert "Insufficient funds"), and `ready` once a
   * dry run of the claim succeeds.
   */
  readonly status: EndurRequestStatus;
  /** Whole seconds until `claimableAt` by the chain's clock; zero once ready. */
  readonly secondsLeft: number;
}

/** Where an unpaid request stands (D-085). */
export type EndurRequestStatus = 'waiting' | 'awaiting-funds' | 'ready';

/**
 * The unpaid requests, oldest first, each `waiting` by the chain's own time
 * (the latest block's timestamp, never the browser's clock), then
 * `awaiting-funds` or `ready` by whether a dry run of its claim succeeded. A
 * paid request is left out: its STRK is on the shadow account, counted in its
 * balance. Throws on a malformed or repeated record.
 */
export function classifyEndurRequests(records: readonly EndurRequestRecord[], chainTime: number): EndurPendingRequest[] {
  if (!Number.isSafeInteger(chainTime) || chainTime < 0) throw new Error('Invalid Endur chain time.');
  const seen = new Set<bigint>();
  const pending: EndurPendingRequest[] = [];
  for (const record of records) {
    const { requestId, assets, shares, claimed, requestedAt, claimableAt, claimableNow } = record;
    if (
      typeof requestId !== 'bigint' || requestId < 0n || requestId > ENDUR_U128_MASK || seen.has(requestId)
      || typeof assets !== 'bigint' || assets < 0n || assets > ENDUR_MAX_UINT256
      || typeof shares !== 'bigint' || shares < 0n || shares > ENDUR_MAX_UINT256
      || typeof claimed !== 'boolean'
      || typeof claimableNow !== 'boolean'
      || !Number.isSafeInteger(requestedAt) || requestedAt < 0
      || !Number.isSafeInteger(claimableAt) || claimableAt < requestedAt
    ) {
      throw new Error('Invalid Endur request.');
    }
    seen.add(requestId);
    if (claimed) continue;
    const secondsLeft = claimableAt > chainTime ? claimableAt - chainTime : 0;
    pending.push(Object.freeze({
      requestId,
      assets,
      shares,
      requestedAt,
      claimableAt,
      status: secondsLeft > 0 ? 'waiting' : claimableNow ? 'ready' : 'awaiting-funds',
      secondsLeft,
    }));
  }
  return pending.sort((a, b) => (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0));
}

function endurAddress(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new Error('Invalid Endur address.');
  const parsed = BigInt(value);
  if (parsed === 0n || parsed >= ENDUR_ADDRESS_BOUND) throw new Error('Invalid Endur address.');
  return endurFelt(parsed);
}

/** Cairo serializes a u256 as two felts, low 128 bits first. */
function endurU256(value: unknown, positive: boolean): [string, string] {
  if (typeof value !== 'bigint' || value < (positive ? 1n : 0n) || value > ENDUR_MAX_UINT256) {
    throw new Error('Invalid Endur amount.');
  }
  return [endurFelt(value & ENDUR_U128_MASK), endurFelt(value >> 128n)];
}

function endurFelt(value: bigint): string {
  return `0x${value.toString(16)}`;
}
