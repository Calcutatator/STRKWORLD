import type {
  Address,
  BatchWarning,
  Intent,
  OperationStage,
  PoolConfig,
  PreparedBatch,
  PrivacyErrorKind,
  PrivacyOperations,
} from '@strkworld/privacy';
import type { BuildingId } from '@strkworld/shared';
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import { toFailure, type ShellFailure } from '../../privacy/errors.js';
import { COPY } from '../../copy.js';
import { formatTokenAmountExact, looksLikeAddress, parseTokenAmount, sameAddress } from '../../format.js';
import { createStore, type ReadableStore } from '../../store/store.js';
import {
  createBatchAccumulator,
  type BatchAccumulator,
  type BatchRejectionReason,
} from '../../accumulator/batch-accumulator.js';
import {
  ROUTE_BY_INTENT_KIND,
  batchRequiresDisclosure,
  disclosuresForIntents,
  routeDisclosure,
  routeDoor,
  type DoorState,
} from '../routes.js';
import type { ReceiptLedger } from '../../receipts/receipt-ledger.js';
import { XSTRK_TOKEN } from '../../production/config.js';
import { debugBank } from '../../debug/debug-tap.js';

/**
 * The Bank panel, as a state machine.
 *
 * The Bank is the whole pool-native action set behind one door: shield,
 * unshield, and a private transfer to another player — plus the Endur staking
 * counter (D-063), which spends the same shielded STRK balance. All four go out
 * as typed intent through the batch accumulator; the panel never composes a
 * protocol action and has no way to name a contract or a selector (D-018). A
 * stake names only its two tokens; `packages/privacy` owns the anonymizer.
 *
 * Five behaviours here are consequences of verified protocol or wallet
 * behaviour rather than taste, and are why this is a state machine and not a
 * form:
 *
 * **A balance read is a wallet interaction, so it is never automatic.** Ready
 * 5.33.8 raises an explicit "Share private balances" approval for
 * `wallet_strk20Balances`. `open()` therefore reads pool config — an ordinary
 * chain read — and stops. The balance appears when the player asks for it, and
 * goes back to unrequested after a submission changes it. Nothing in this file
 * sets a timer.
 *
 * **`prepare()` is visible work, not a silent preview.** The wallet raises a
 * "Prove transaction" action for the whole array, so the panel shows a
 * preparing state and says the wallet is involved before anything appears.
 *
 * **No prompt counting.** The seam reports a source-derived `promptCount` and
 * the funded run has not happened (D-028); the summary deliberately drops it,
 * and every pending state on screen is driven by the operation's own stage
 * (SPEC §5 rule 5).
 *
 * **Disclosures follow the batch, not the controls.** The approved copy shown
 * at the commit point is derived from the intents actually prepared, never
 * from the control on screen (D-020, D-024).
 *
 * **One action per counter (D-103).** Each counter reviews and confirms one
 * intent, which pays its own pool fee: `review()` checks the form, queues the
 * one intent through the accumulator (which still validates its shape, D-018)
 * and prepares it. Backing out of the review returns the intent to the form,
 * so nothing is left queued behind it. There is no visit-long queue.
 *
 * **Every submission is an attempt with an identity.** A second confirm cannot
 * start, and a late answer from an abandoned attempt cannot overwrite the state
 * of the one that settled — telling a player "nothing was signed" about a
 * settled transaction is the worst lie this panel could tell.
 */

export type BankMode = 'shield' | 'unshield' | 'transfer' | 'stake';

/**
 * Why the Bank refused an Add, as the debug log names it (D-070): the
 * accumulator's own reason, or one of the Bank's checks before it.
 */
export type BankAddRefusal =
  | BatchRejectionReason['reason']
  | 'gate-closed'
  | 'door-locked'
  | 'pool-not-loaded'
  | 'bad-amount'
  | 'bad-recipient'
  | 'recipient-unregistered'
  | 'recipient-check-failed'
  /** D-094: the shield and the pool fee on top are more than the wallet's public balance. */
  | 'exceeds-public-balance';

/**
 * A confirm stage as the debug log names it (D-070): the seam's own stage, or
 * how the attempt ended here — settled, the fee or the Bridge plan moved, or
 * the D-035 gate closed and sent it back to review.
 */
export type BankConfirmStage = OperationStage | 'submitted' | 'fee-moved' | 'plan-moved' | 'gate-closed';

const ALL_BANK_MODES: readonly BankMode[] = ['shield', 'unshield', 'transfer', 'stake'];

/** The graded route each control drives. See `ROUTE_BY_INTENT_KIND`. */
export const ROUTE_BY_MODE: Readonly<Record<BankMode, string>> = Object.freeze({
  shield: ROUTE_BY_INTENT_KIND.shield,
  unshield: ROUTE_BY_INTENT_KIND.unshield,
  transfer: ROUTE_BY_INTENT_KIND.transfer,
  stake: ROUTE_BY_INTENT_KIND.stake,
});

/** The staking counter's output token: Endur xSTRK, the same value the production policy pins. */
export const STAKE_TOKEN_OUT: Address = XSTRK_TOKEN;

type StakeIntent = Extract<Intent, { kind: 'stake' }>;

/**
 * The one stake a prepared batch is reviewing, or null for anything else.
 *
 * The seam prepares a stake strictly alone (D-063), so a batch that is not
 * exactly one stake is reviewed by the ordinary Bank surface instead.
 */
export function reviewedStake(intents: readonly Intent[]): StakeIntent | null {
  const only = intents.length === 1 ? intents[0] : undefined;
  return only?.kind === 'stake' ? only : null;
}

/** Only unshield and transfer name a recipient: a shield is always to self, and a stake's xSTRK comes back to the player's own pool balance. */
export function modeNeedsRecipient(mode: BankMode): boolean {
  return mode === 'unshield' || mode === 'transfer';
}

export type BalanceView =
  /** Never read, or invalidated by a submission. The player asks; we do not. */
  | { readonly status: 'unrequested' }
  | { readonly status: 'loading' }
  | {
      readonly status: 'loaded';
      readonly total: bigint;
      /**
       * False when the wallet exposes one aggregate per token — the shipped
       * Wallet API shape. `spendable` and `maturing` are then conservative
       * zeroes and MAX is unavailable rather than invented (D-022).
       */
      readonly maturityKnown: boolean;
      readonly spendable: bigint;
      readonly maturing: bigint;
      /** Increments on each successful read. Deterministic, unlike a clock. */
      readonly readCount: number;
    }
  | { readonly status: 'failed'; readonly kind: PrivacyErrorKind; readonly message: string };

/**
 * D-094: the connected account's PUBLIC balance of the shield token, which
 * is what a shield draws on. A public chain read over the wallet's own RPC:
 * no wallet is asked, so the Shield control reads it when it opens, when its
 * token changes and on Refresh, unlike the private `BalanceView`.
 */
export type PublicBalanceView =
  | { readonly status: 'unrequested' }
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly token: Address; readonly amount: bigint }
  | { readonly status: 'failed'; readonly message: string };

/**
 * D-094: one shield's figures. The typed amount is what reaches the pool
 * balance; the pool fee goes on top, so the wallet sends `total`.
 */
export interface ShieldFigures {
  readonly amount: bigint;
  readonly fee: bigint;
  readonly total: bigint;
}

export function shieldFigures(amount: bigint, fee: bigint): ShieldFigures {
  return Object.freeze({ amount, fee, total: amount + fee });
}

/**
 * D-094: the most a player can shield from `held` public STRK: all of it
 * but the pool fee and what the visit already queues.
 *
 * No network reserve is held back. On the measured Ready shield
 * (2026-10-01) avnu's relayer paid the network fee out of the pool fee, so
 * the deposit was the only STRK that left the wallet. A wallet that pays its
 * own network fee would refuse a shield it cannot cover, before anything is
 * sent; the funds stay public and nothing is lost. D-013's stranding trap no
 * longer applies either: every private action pays its fees from the pool.
 */
export function shieldMax(held: bigint, fee: bigint, queued: bigint): bigint | null {
  const left = held - fee - queued;
  return left > 0n ? left : null;
}

/**
 * What the player agrees to. Costs come from the prepared batch, not from a
 * constant — the pool fee is governance-settable and has moved once already.
 */
export interface PreparedSummary {
  readonly intents: readonly Intent[];
  readonly poolFee: bigint;
  readonly gasEstimate: bigint;
  readonly totalCost: bigint;
  /** The hard guard passed to `confirm`. Never signs above the quoted total. */
  readonly feeCeiling: bigint;
  readonly warnings: readonly BatchWarning[];
  /**
   * Approved disclosures for the routes in `intents`, verbatim from the
   * register. Carried on the summary so the commit surface cannot render
   * without them.
   */
  readonly disclosures: readonly string[];
  /**
   * Whether any route in `intents` is a below-private deviation, and therefore
   * whether `disclosures` being empty is a bug rather than a fact. The commit
   * gate fails closed on the combination.
   */
  readonly requiresDisclosure: boolean;
}

export type BankFlow =
  | { readonly name: 'idle' }
  | { readonly name: 'loading-pool' }
  | { readonly name: 'composing' }
  | { readonly name: 'preparing' }
  | { readonly name: 'review'; readonly summary: PreparedSummary }
  | {
      readonly name: 'submitting';
      readonly stage: OperationStage;
      readonly message: string;
      /**
       * Carried through submission so the approved disclosures and the figures
       * stay on screen while the wallet works, rather than the panel swapping
       * out from under the player at the moment of commitment.
       */
      readonly summary: PreparedSummary;
    }
  | {
      readonly name: 'submitted';
      readonly transactionHash: string;
      /** Set when this receipt was found outstanding on `open()` rather than just confirmed this session. */
      readonly restored?: boolean;
      /** D-094: the batch was a shield, whose new note matures before the wallet shows it. */
      readonly shielded?: boolean;
    }
  | {
      readonly name: 'failed';
      readonly kind: PrivacyErrorKind;
      readonly message: string;
      /** A prepared batch is single-attempt, so recovery means preparing again. */
      readonly recovery: 'prepare-again' | 'close';
    };

export interface BankNotice {
  readonly tone: 'error' | 'info';
  readonly text: string;
}

export interface BankState {
  readonly mode: BankMode;
  readonly routeId: string;
  readonly door: DoorState;
  /** Approved copy for the mode being composed. Null when the route is private or its disclosure is waived (D-064, D-065). */
  readonly disclosure: string | null;
  /** Approved copy for what is queued. The commit point renders these. */
  readonly batchDisclosures: readonly string[];
  readonly pool: PoolConfig | null;
  /** The game's money and its fee token, read live rather than hardcoded. */
  token: Address | null;
  balance: BalanceView;
  /** D-094: the wallet's public balance of `token`, which the Shield control shows and spends. */
  readonly publicBalance: PublicBalanceView;
  /**
   * Network cost **observed for a batch of exactly the shape a MAX would
   * create** — the queued intents plus one more of the current mode.
   *
   * The seam reports the network cost only at prepare time, and it may vary
   * with batch shape: a relayed route's fee was charged per action. Since
   * D-082 the wallet submits every Bank route and prices its own network fee,
   * so the seam reports zero, but the rule stands. A figure measured on a
   * one-intent batch is not the cost of a two-intent batch, and reusing it is
   * how MAX became a button that always failed. Evidence is therefore kept per
   * shape and MAX is offered only when the exact shape has been costed. Null
   * means no maximum can be stated, which is the same answer D-022 forces for
   * unknown note maturity: not a guess, and not the total.
   */
  readonly quotedGasForNextIntent: bigint | null;
  readonly amountText: string;
  readonly recipientText: string;
  readonly batch: readonly Intent[];
  /** True while a queue action is resolving, so a second click cannot double it. */
  readonly adding: boolean;
  readonly notice: BankNotice | null;
  readonly flow: BankFlow;
}

export interface BankPanelOptions {
  operations: PrivacyOperations;
  /**
   * Called with every failure the panel sees so the shell can escalate a 118
   * or a 162 into its designed room. The panel still shows its own state.
   */
  onError?: (failure: ShellFailure) => void;
  /**
   * Headroom over the quoted total. Zero by default: we refuse to sign a fee
   * larger than the one the player was shown.
   */
  feeTolerance?: bigint;
  /** The counter's controls: one in every shipped window (D-103). An omitted list allows every mode. */
  allowedModes?: readonly BankMode[];
  /** The first mode shown by a fixed station. Must be in `allowedModes`. */
  initialMode?: BankMode;
  /** Injectable for tests that need an unapproved route. */
  register?: readonly RouteGrade[];
  accumulator?: BatchAccumulator;
  /**
   * Session-level capability for starting financial work. Every caller must
   * choose a policy; the rendered Bank injects the live D-035 gate.
   */
  canStartFinancialAction: () => boolean;
  /**
   * Where receipts go. **Required, and deliberately not defaulted:** its
   * lifetime has to outlive the panel, because a transaction settles whether or
   * not the room is still mounted and `building:exited` is not the player's
   * decision. A per-panel default would compile and lose receipts.
   */
  receipts: ReceiptLedger;
  /** Building that owns receipts restored or recorded by this machine. */
  building?: BuildingId;
  /** Optional last-instruction guard for a composed handoff (D-043). */
  preConfirmGuard?: () => Promise<boolean>;
}

export interface BankPanel {
  /** Read-only view; panel methods own every financial state transition. */
  readonly store: ReadableStore<BankState>;
  open(signal?: AbortSignal): Promise<void>;
  close(): void;
  setMode(mode: BankMode): void;
  setAmount(text: string): void;
  setRecipient(text: string): void;
  refreshBalance(signal?: AbortSignal): Promise<void>;
  /**
   * D-094: re-read the wallet's public balance the Shield control spends.
   * A chain read that asks no wallet; nothing happens outside Shield.
   */
  refreshPublicBalance(signal?: AbortSignal): Promise<void>;
  /** `null` whenever a maximum would have to be guessed. See D-022. */
  maxSpendable(): bigint | null;
  applyMax(): void;
  /**
   * D-103: the counter's one primary action: check the form, queue its one
   * intent and prepare it for review, as `addToBatch` then `prepare`.
   */
  review(signal?: AbortSignal): Promise<void>;
  /** Check the form and queue its one intent; a second is refused (D-103). */
  addToBatch(signal?: AbortSignal): Promise<void>;
  prepare(signal?: AbortSignal): Promise<void>;
  confirm(signal?: AbortSignal): Promise<void>;
  cancelPrepared(): void;
  /** Leave the receipt and return to the counter. */
  acknowledge(): void;
  dismissNotice(): void;
}

export function createBankPanel(options: BankPanelOptions): BankPanel {
  const { operations, onError, receipts } = options;
  const building = options.building ?? 'bank';
  // Keep the runtime boundary fail-closed for JavaScript or deliberately
  // untyped callers. TypeScript callers must provide an explicit policy.
  const canStartFinancialAction = options.canStartFinancialAction ?? (() => false);
  const register = options.register ?? PRIVACY_REGISTER;
  const feeTolerance = options.feeTolerance ?? 0n;
  const configuredModes: unknown = options.allowedModes;
  if (configuredModes !== undefined && !Array.isArray(configuredModes)) {
    throw new Error('BankPanel allowed modes must be an array');
  }
  const allowedModes = Object.freeze([
    ...(configuredModes === undefined ? ALL_BANK_MODES : configuredModes),
  ]) as readonly BankMode[];
  if (allowedModes.length === 0) throw new Error('BankPanel requires at least one allowed mode');
  const seenModes = new Set<BankMode>();
  for (const mode of allowedModes) {
    if (!ALL_BANK_MODES.includes(mode)) {
      throw new Error(`BankPanel unsupported allowed mode: ${String(mode)}`);
    }
    if (seenModes.has(mode)) throw new Error(`BankPanel duplicate allowed mode: ${mode}`);
    seenModes.add(mode);
  }
  const initialMode = options.initialMode ?? allowedModes[0]!;
  if (!allowedModes.includes(initialMode)) {
    throw new Error(`BankPanel initial mode is not allowed: ${initialMode}`);
  }
  // D-103: one intent per counter. The accumulator still re-validates the
  // intent's shape and refuses a second one.
  const accumulator = options.accumulator ?? createBatchAccumulator({ maxIntents: 1 });

  const stateStore = createStore<BankState>(freezeBankState(initialState(initialMode, register)));
  const store: ReadableStore<BankState> = Object.freeze({
    getState: stateStore.getState,
    getServerSnapshot: stateStore.getServerSnapshot,
    subscribe: stateStore.subscribe,
  });
  let prepared: PreparedBatch | null = null;
  /** The confirmation attempt that currently owns the wallet handoff. */
  let signingOwner: number | null = null;
  /** The exact prepared batch owned by that confirmation attempt. */
  let signingBatch: PreparedBatch | null = null;
  let readCount = 0;

  /**
   * Three invalidation clocks, because there are three distinct reasons a
   * finished async step should not write what it learned.
   *
   * `attempt` — a newer prepare/confirm, or a cancel, has replaced this one.
   * `session` — the panel closed. Nothing may write into a reset store.
   * `balanceRead` — a newer read, or a submission that changed the balance,
   *   has superseded this read. Without it, a read in flight when a submission
   *   lands overwrites the post-submission reset with the pre-submission
   *   figure, under a notice saying the balance has changed.
   *
   * One counter for all three would mean a balance read cancelling a
   * submission, which is worse than the bug it fixes.
   */
  let attempt = 0;
  let session = 0;
  let balanceRead = 0;
  /** D-094: the public balance read's own clock; a newer read, a mode or token change, or a close supersedes it. */
  let publicRead = 0;
  /** A form edit or a Back owns the composition over work started from an older one. */
  let composition = 0;
  /** D-103: one review at a time, from its check of the form to its prepare. */
  let reviewing = false;
  /**
   * Network cost per batch shape, as reported by the seam.
   *
   * Keyed by the sorted intent kinds rather than by a count, because the seam
   * prices a swap differently from a transfer. Only ever written from an actual
   * quote — there is no model in here, and no interpolation between two
   * observations, because a fitted curve is still a guess about somebody's
   * money.
   */
  const gasByShape = new Map<string, bigint>();
  const begin = (): number => (attempt += 1);
  const current = (id: number): boolean => attempt === id;
  const live = (id: number): boolean => session === id;
  const beginRead = (): number => (balanceRead += 1);
  const invalidateReads = (): void => {
    balanceRead += 1;
  };

  function patch(next: Partial<BankState>): void {
    stateStore.setState((previous) => freezeBankState({ ...previous, ...next }));
  }

  /**
   * A form edit supersedes any recipient preflight that read the previous
   * shape. Keep the ownership bump beside the public form writes so every
   * caller, including MAX, uses the same stale-result guard.
   */
  function editComposition(next: Partial<BankState>, changed = true): void {
    if (changed) composition += 1;
    patch(next);
  }

  function notice(tone: BankNotice['tone'], text: string): void {
    patch({ notice: { tone, text } });
  }

  /** An Add the Bank will not queue: the player reads why, the debug log gets the code alone (D-070). */
  function refuseAdd(reason: BankAddRefusal, text?: string): void {
    if (text !== undefined) notice('error', text);
    debugBank({ step: 'add-refused', reason });
  }

  function gateOpen(): boolean {
    if (canStartFinancialAction()) return true;
    notice('error', COPY.errors['submission-uncertain']);
    return false;
  }

  /**
   * D-094: read the wallet's public balance of the shield token. Only the
   * Shield control spends it, so nothing is read in another mode.
   */
  async function readPublicBalance(signal?: AbortSignal): Promise<void> {
    const { token, mode } = store.getState();
    if (!token || mode !== 'shield') return;
    const mySession = session;
    const epoch = (publicRead += 1);
    patch({ publicBalance: { status: 'loading' } });
    try {
      const amount = await operations.publicBalance(token, signal);
      const now = store.getState();
      if (!live(mySession) || publicRead !== epoch || now.mode !== 'shield' || !now.token || !sameAddress(now.token, token)) return;
      patch({ publicBalance: { status: 'loaded', token, amount } });
    } catch {
      if (!live(mySession) || publicRead !== epoch) return;
      patch({ publicBalance: { status: 'failed', message: COPY.balance.publicFailed } });
    }
  }

  /** D-094: shields already queued, which draw on the same public balance. */
  function queuedShield(intents: readonly Intent[]): bigint {
    return queuedSpend(intents.filter((intent) => intent.kind === 'shield'));
  }

  function setBatch(intents: readonly Intent[]): void {
    patch({
      batch: intents,
      batchDisclosures: disclosuresForIntents(intents, register),
      quotedGasForNextIntent: gasForNextIntent(intents, store.getState().mode),
    });
  }

  /** The observed cost for the batch this visit would have after one more Add. */
  function gasForNextIntent(intents: readonly Intent[], mode: BankMode): bigint | null {
    return gasByShape.get(shapeKey([...intents.map((intent) => intent.kind), mode])) ?? null;
  }

  function fail(error: unknown, recovery: 'prepare-again' | 'close', id: number, operation?: Intent['kind']): void {
    const failure: ShellFailure = operation ? { ...toFailure(error), operation } : toFailure(error);
    // D-034 is the exception to the ordinary stale-write rule. A private
    // submit response can be lost after the player closes the window; the
    // provider-level notice must still learn about that ambiguity. The notice
    // stores one bit only and `retain()` is idempotent.
    if (failure.kind === 'submission-uncertain') onError?.(failure);

    // Every panel-local write remains guarded. An abandoned attempt must not
    // reopen or overwrite a newer surface.
    if (!current(id)) return;
    if (failure.kind !== 'submission-uncertain') onError?.(failure);
    discardPrepared();
    if (failure.kind === 'submission-uncertain') {
      // The lost response is single-attempt. Do not leave the old intent in a
      // newly unlocked form where acknowledgement could turn it into a blind
      // retry; the player may compose a fresh action after the gate opens.
      // D-103: the form held the action too, so it is emptied with it.
      accumulator.clear();
      setBatch(accumulator.intents);
      patch({ amountText: '', recipientText: '' });
    }
    patch({
      flow: {
        name: 'failed',
        kind: failure.kind,
        message: settlingRefusal(failure.kind)
          ? COPY.balance.settling
          : publicShortfall(failure.kind)
            ? `${COPY.entry.publicShortLead} STRK ${COPY.entry.publicShortTail}`
            : COPY.errors[failure.kind],
        recovery: failure.kind === 'submission-uncertain' ? 'close' : recovery,
      },
    });
  }

  /**
   * D-091: the wallet refused a spend as more than the balance, although the
   * total it reported covers it and the pool fee. The total counts notes
   * still maturing (about ten blocks after they arrive), which the wallet
   * will not spend yet: the funds are settling, not missing.
   */
  function settlingRefusal(kind: PrivacyErrorKind): boolean {
    const state = store.getState();
    if (kind !== 'insufficient-balance' || state.balance.status !== 'loaded' || state.balance.maturityKnown || !state.pool) {
      return false;
    }
    const spends = state.batch.filter((intent) => intent.kind !== 'shield');
    return spends.length > 0 && queuedSpend(spends) + state.pool.feeAmount <= state.balance.total;
  }

  /** D-094: a 119 on a shield is the wallet's public balance, not the pool's. */
  function publicShortfall(kind: PrivacyErrorKind): boolean {
    const { batch } = store.getState();
    return kind === 'insufficient-balance' && batch.length > 0 && batch.every((intent) => intent.kind === 'shield');
  }

  function discardPrepared(): void {
    // A batch the wallet is already signing is not ours to release. Discarding
    // it cannot unring that bell, and the seam is entitled to treat a discarded
    // batch as unsubmittable — which would turn "the player left the room" into
    // "the transaction never happened", losing a settling payment. Drop the
    // reference and let the submission finish into the receipt ledger. The
    // owner token and batch identity matter because a stale confirmation may
    // settle after a newer batch has been prepared or entered the handoff.
    if (prepared !== null && prepared === signingBatch) {
      prepared = null;
      return;
    }
    prepared?.discard();
    prepared = null;
  }

  function computeMax(): bigint | null {
    const state = store.getState();
    // D-094: shielding spends the wallet's public STRK, read over its own
    // RPC. The pool fee goes on top of the shield, so it is left behind.
    if (state.mode === 'shield') {
      if (state.publicBalance.status !== 'loaded' || !state.pool) return null;
      return shieldMax(state.publicBalance.amount, state.pool.feeAmount, queuedShield(state.batch));
    }
    if (state.balance.status !== 'loaded') return null;
    // D-091 (amending D-022): a wallet that reports one total per token and
    // no maturity split is taken at that total. The wallet itself refuses a
    // spend that counts a note still maturing, so a Max can fail but cannot
    // misspend, and that refusal says the funds are still settling.
    const held = state.balance.maturityKnown ? state.balance.spendable : state.balance.total;
    const fee = state.pool?.feeAmount;
    // Both fees come out of the same shielded balance, so a maximum that
    // reserves only the pool fee is a button that always fails at prepare.
    // The network cost is only known once something has been costed.
    if (fee === undefined || state.quotedGasForNextIntent === null) return null;
    // And what is already queued is already spent. Cancelling a review does not
    // empty the visit, so a maximum that ignores the queue is a button that
    // fails the moment anything is waiting in it.
    const spendable =
      held - fee - state.quotedGasForNextIntent - queuedSpend(state.batch);
    return spendable > 0n ? spendable : null;
  }

  const panel: BankPanel = Object.freeze<BankPanel>({
    store,

    /**
     * Enter the room.
     *
     * Reads pool config and nothing else. A balance read would raise a wallet
     * approval the player did not ask for, which is the single behaviour the
     * Ready 5.33.8 audit says a HUD must not have.
     */
    async open(signal?: AbortSignal): Promise<void> {
      const id = begin();
      patch({ flow: { name: 'loading-pool' } });
      try {
        const pool = await operations.poolConfig(signal);
        if (!current(id)) return;
        // A transaction that settled while the room was shut left its receipt
        // in the ledger. Show it before anything else: it is the only proof the
        // player has that their money moved.
        const outstanding = receipts.pending(building)[0];
        patch({
          pool,
          token: pool.feeToken,
          flow: outstanding
            ? {
                name: 'submitted',
                transactionHash: outstanding.transactionHash,
                restored: true,
                ...(outstanding.intents.some((intent) => intent.kind === 'shield') ? { shielded: true } : {}),
              }
            : { name: 'composing' },
        });
        // D-094: the Shield control shows the wallet's public balance at once.
        void readPublicBalance(signal);
      } catch (error) {
        fail(error, 'close', id);
      }
    },

    close(): void {
      // Invalidate everything still in flight. A settled transaction's receipt
      // is already in the ledger by then, so nothing of value is dropped.
      begin();
      session += 1;
      invalidateReads();
      publicRead += 1;
      discardPrepared();
      accumulator.clear();
      stateStore.setState(freezeBankState(initialState(store.getState().mode, register)));
    },

    setMode(mode: BankMode): void {
      if (!allowedModes.includes(mode)) return;
      const from = store.getState().mode;
      const routeId = ROUTE_BY_MODE[mode];
      // Selecting a mode has always reset both form fields and the notice,
      // even when the selected tab is already active. That is a composition
      // transition in the public API, so invalidate pending work on every
      // accepted mode selection.
      editComposition({
        mode,
        routeId,
        door: routeDoor(routeId, register),
        disclosure: routeDisclosure(routeId, register),
        // A different mode means a differently shaped batch, and therefore
        // different evidence.
        quotedGasForNextIntent: gasForNextIntent(store.getState().batch, mode),
        amountText: '',
        recipientText: '',
        notice: null,
      });
      if (from !== mode) debugBank({ step: 'mode', mode, from });
      // D-094: opening the Shield control reads the balance it spends; leaving
      // it drops any read in flight.
      publicRead += 1;
      if (mode === 'shield') void readPublicBalance();
      else patch({ publicBalance: { status: 'unrequested' } });
    },

    setAmount(text: string): void {
      editComposition({ amountText: text }, store.getState().amountText !== text);
    },

    setRecipient(text: string): void {
      editComposition({ recipientText: text }, store.getState().recipientText !== text);
    },

    /** Only ever called from a player action. There is no timer in this file. */
    refreshPublicBalance: (signal?: AbortSignal) => readPublicBalance(signal),

    async refreshBalance(signal?: AbortSignal): Promise<void> {
      const { token } = store.getState();
      if (!token) {
        notice('error', COPY.notices.poolNotLoaded);
        return;
      }
      const mySession = session;
      const epoch = beginRead();
      patch({ balance: { status: 'loading' }, notice: null });
      try {
        const balances = await operations.balances([token], signal);
        // A figure read before a submission is not the balance after it, and a
        // closed panel must not be written into at all.
        if (!live(mySession) || balanceRead !== epoch) return;
        const entry = balances.find((candidate) => sameAddress(candidate.token, token));
        readCount += 1;
        patch({
          balance: {
            status: 'loaded',
            total: entry?.total ?? 0n,
            maturityKnown: entry?.maturityKnown ?? false,
            spendable: entry?.spendable ?? 0n,
            maturing: entry?.maturing ?? 0n,
            readCount,
          },
        });
      } catch (error) {
        if (!live(mySession) || balanceRead !== epoch) return;
        const failure = toFailure(error);
        onError?.(failure);
        patch({
          balance: { status: 'failed', kind: failure.kind, message: COPY.errors[failure.kind] },
        });
      }
    },

    maxSpendable: computeMax,

    applyMax(): void {
      const max = computeMax();
      if (max !== null) {
        const maxText = formatTokenAmountExact(max);
        editComposition({
          amountText: maxText,
          notice: { tone: 'info', text: COPY.balance.feeReserved },
        }, store.getState().amountText !== maxText);
        return;
      }
      notice('info', COPY.balance.costUnknown);
    },

    async addToBatch(signal?: AbortSignal): Promise<void> {
      if (!gateOpen()) {
        refuseAdd('gate-closed');
        return;
      }
      const state = store.getState();
      // A second click while the first is still resolving would queue the same
      // intent twice, and the player would see one row appear and then another.
      if (state.adding) return;
      if (!state.door.open) {
        refuseAdd('door-locked', state.door.message);
        return;
      }
      if (!state.token) {
        refuseAdd('pool-not-loaded', COPY.notices.poolNotLoaded);
        return;
      }

      const amount = parseTokenAmount(state.amountText);
      if (amount === null || amount <= 0n) {
        refuseAdd('bad-amount', COPY.notices.badAmount);
        return;
      }

      let recipient = '';
      if (modeNeedsRecipient(state.mode)) {
        recipient = state.recipientText.trim();
        if (!looksLikeAddress(recipient)) {
          refuseAdd('bad-recipient', COPY.notices.badRecipient);
          return;
        }
      }

      // D-094: the shield plus the pool fee on top must fit the wallet's
      // public balance, when it has been read. Unread, the wallet decides.
      if (state.mode === 'shield' && state.publicBalance.status === 'loaded' && state.pool) {
        const needed = queuedShield(state.batch) + amount + state.pool.feeAmount;
        if (needed > state.publicBalance.amount) {
          refuseAdd('exceeds-public-balance', COPY.kit.insufficient.replace('{symbol}', 'STRK'));
          return;
        }
      }

      const mySession = session;
      const myComposition = composition;
      patch({ adding: true });
      try {
        let pending: BankNotice | null = null;
        if (state.mode === 'transfer') {
          // Preflight, because a transfer to an unregistered account otherwise
          // fails late in the wallet with nothing a player can act on. The pool
          // read and the 118 mapping must agree, so both exist.
          try {
            const status = await operations.recipientStatus(recipient, signal);
            // The room may have closed while the pool was answering. Queuing an
            // intent into a reset panel is a financial write nobody asked for.
            if (!live(mySession) || composition !== myComposition) return;
            if (!gateOpen()) {
              refuseAdd('gate-closed');
              return;
            }
            if (status === 'unregistered') {
              refuseAdd('recipient-unregistered', COPY.notices.recipientUnregistered);
              return;
            }
            if (status === 'unknown') {
              pending = { tone: 'info', text: COPY.notices.recipientUnknown };
            }
          } catch (error) {
            if (!live(mySession) || composition !== myComposition) return;
            const failure = toFailure(error);
            onError?.(failure);
            refuseAdd('recipient-check-failed', COPY.errors[failure.kind]);
            return;
          }
        }

        // A stake spends the same shielded balance every other control reads:
        // the pool's own STRK, which is also its fee token. The seam pins the
        // pair itself and refuses anything but STRK in, xSTRK out (D-063).
        const intent: Intent =
          state.mode === 'shield'
            ? { kind: 'shield', token: state.token, amount }
            : state.mode === 'unshield'
              ? { kind: 'unshield', token: state.token, amount, recipient }
              : state.mode === 'transfer'
                ? { kind: 'transfer', token: state.token, amount, recipient }
                : { kind: 'stake', tokenIn: state.token, tokenOut: STAKE_TOKEN_OUT, amountIn: amount };

        const result = accumulator.accept(intent);
        if (!result.ok) {
          refuseAdd(result.rejection.reason, rejectionCopy(result.rejection, intent.kind));
          return;
        }

        // D-103: the form keeps what was typed until the action settles, so
        // backing out of the review leaves it there to edit.
        setBatch(result.value);
        patch({ notice: pending });
      } finally {
        if (live(mySession)) patch({ adding: false });
      }
    },

    /**
     * Cost the visit.
     *
     * This is a visible wallet interaction: the wallet raises a proving action
     * for the whole array, so the panel says so while it waits rather than
     * presenting it as a background preview.
     */
    async prepare(signal?: AbortSignal): Promise<void> {
      if (!gateOpen()) return;
      const confirmed = accumulator.confirm();
      if (!confirmed.ok) {
        notice('error', rejectionCopy(confirmed.rejection));
        return;
      }

      const id = begin();
      discardPrepared();
      debugBank({ step: 'prepare', kinds: confirmed.value.map((intent) => intent.kind) });
      patch({ flow: { name: 'preparing' }, notice: null });
      try {
        const batch = await operations.prepare([...confirmed.value], signal);
        if (!current(id)) {
          batch.discard();
          return;
        }
        prepared = batch;
        // Evidence, filed against the exact shape it was measured on.
        gasByShape.set(shapeKey(batch.intents.map((intent) => intent.kind)), batch.gasEstimate);
        patch({
          quotedGasForNextIntent: gasForNextIntent(store.getState().batch, store.getState().mode),
          flow: {
            name: 'review',
            summary: {
              intents: batch.intents,
              poolFee: batch.poolFee,
              gasEstimate: batch.gasEstimate,
              totalCost: batch.totalCost,
              feeCeiling: batch.totalCost + feeTolerance,
              warnings: batch.warnings,
              disclosures: disclosuresForIntents(batch.intents, register),
              requiresDisclosure: batchRequiresDisclosure(batch.intents, register),
              // `promptCount` is deliberately not carried into the summary:
              // it is a source-derived expectation awaiting the funded run
              // (D-028), and no pending UI may be driven from it.
            },
          },
        });
      } catch (error) {
        fail(error, 'prepare-again', id, confirmed.value[0]?.kind);
      }
    },

    async confirm(signal?: AbortSignal): Promise<void> {
      if (!gateOpen()) return;
      const state = store.getState();
      const batch = prepared;
      if (state.flow.name !== 'review' || !batch) return;
      const { summary } = state.flow;

      // Leave `review` synchronously, before the first await. Two clicks in one
      // tick both reach here; the second finds the flow already moved on. The
      // disabled button is the courtesy, this is the guard.
      const mySession = session;
      const id = begin();
      // D-070: each stage once, in order, for the debug log. Stages only.
      let lastStage: BankConfirmStage | null = null;
      const trace = (stage: BankConfirmStage): void => {
        if (stage === lastStage) return;
        lastStage = stage;
        debugBank({ step: 'confirm', stage });
      };
      patch({ flow: { name: 'submitting', stage: 'composing', message: COPY.flow.handingOver, summary } });
      trace('composing');

      // Re-read the live fee before asking the wallet for anything. The seam's
      // ceiling is the real guard and is still passed below, but it can only
      // report "the fee moved" as a generic failure; reading it here means the
      // player gets that sentence instead of "something went wrong".
      try {
        const pool = await operations.poolConfig(signal);
        if (!current(id)) return;
        if (!canStartFinancialAction()) {
          patch({ flow: { name: 'review', summary } });
          notice('error', COPY.errors['submission-uncertain']);
          trace('gate-closed');
          return;
        }
        patch({ pool });
        if (pool.feeAmount + summary.gasEstimate > summary.feeCeiling) {
          discardPrepared();
          patch({
            flow: { name: 'failed', kind: 'unknown', message: COPY.notices.feeMoved, recovery: 'prepare-again' },
          });
          trace('fee-moved');
          return;
        }
      } catch (error) {
        fail(error, 'prepare-again', id, batch.intents[0]?.kind);
        if (current(id)) trace('failed');
        return;
      }

      try {
        if (!canStartFinancialAction()) {
          patch({ flow: { name: 'review', summary } });
          notice('error', COPY.errors['submission-uncertain']);
          trace('gate-closed');
          return;
        }
        const handoffReady = options.preConfirmGuard ? await options.preConfirmGuard() : true;
        if (!current(id)) return;
        if (!canStartFinancialAction()) {
          patch({ flow: { name: 'review', summary } });
          notice('error', COPY.errors['submission-uncertain']);
          trace('gate-closed');
          return;
        }
        if (!handoffReady) {
          discardPrepared();
          patch({
            flow: {
              name: 'failed',
              kind: 'unknown',
              message: COPY.notices.bridgePlanMoved,
              recovery: 'prepare-again',
            },
          });
          trace('plan-moved');
          return;
        }
        signingOwner = id;
        signingBatch = batch;
        const result = await batch.confirm({
          feeCeiling: summary.feeCeiling,
          signal,
          onProgress: ({ stage }) => {
            if (!current(id)) return;
            trace(stage);
            patch({ flow: { name: 'submitting', stage, message: stageCopy(stage), summary } });
          },
        });
        if (signingOwner === id) {
          signingOwner = null;
          signingBatch = null;
        }
        // Record first, unconditionally. The transaction has settled; the hash
        // is the only proof the player has, and whether their panel is still
        // mounted is not their decision — the world can unmount it mid-signing.
        receipts.record({
          building,
          transactionHash: result.transactionHash,
          intents: summary.intents,
        });
        if (prepared === batch) prepared = null;
        if (current(id) && live(mySession)) accumulator.clear();
        // Any balance read still in flight predates this submission.
        invalidateReads();
        if (!current(id)) return;
        setBatch(accumulator.intents);
        const shielded = summary.intents.some((intent) => intent.kind === 'shield');
        patch({
          flow: {
            name: 'submitted',
            transactionHash: result.transactionHash,
            ...(shielded ? { shielded: true } : {}),
          },
          // The balance moved. It is not re-read here: the player asks.
          balance: { status: 'unrequested' },
          // D-103: the action is done; the form starts empty for the next one.
          amountText: '',
          recipientText: '',
          notice: { tone: 'info', text: COPY.balance.changed },
        });
        trace('submitted');
        // D-094: the public balance is a chain read that asks no wallet, so
        // the Shield control re-reads it rather than show the old figure.
        publicRead += 1;
        if (store.getState().mode === 'shield') void readPublicBalance();
        else patch({ publicBalance: { status: 'unrequested' } });
      } catch (error) {
        if (signingOwner === id) {
          signingOwner = null;
          signingBatch = null;
        }
        // The seam reports a ceiling breach as a generic failure, so ask the
        // pool whether that is what happened rather than matching on a string.
        // Once this attempt is stale there is no panel state left to classify,
        // so do not start a new pool read after close or cancellation.
        if (
          toFailure(error).kind === 'unknown' &&
          current(id) &&
          (await feeMovedPast(summary, signal))
        ) {
          if (!current(id)) return;
          discardPrepared();
          patch({
            flow: { name: 'failed', kind: 'unknown', message: COPY.notices.feeMoved, recovery: 'prepare-again' },
          });
          trace('fee-moved');
          return;
        }
        fail(error, 'prepare-again', id, batch.intents[0]?.kind);
        if (current(id)) trace('failed');
      }
    },

    /**
     * D-103: the form is the action. Anything left queued by an earlier,
     * abandoned attempt is dropped first, so what is prepared is always what
     * the form says now.
     */
    async review(signal?: AbortSignal): Promise<void> {
      const { adding, flow } = store.getState();
      if (reviewing || adding || flow.name === 'preparing' || flow.name === 'review' || flow.name === 'submitting') return;
      reviewing = true;
      try {
        if (accumulator.intents.length > 0) {
          begin();
          discardPrepared();
          accumulator.clear();
          setBatch(accumulator.intents);
        }
        await panel.addToBatch(signal);
        if (accumulator.intents.length === 0) return;
        await panel.prepare(signal);
      } finally {
        reviewing = false;
      }
    },

    /**
     * Back out of a review, or of a failed prepare, to the form. D-103: the
     * one queued intent is dropped rather than left waiting; the form still
     * holds what was typed.
     */
    cancelPrepared(): void {
      begin();
      discardPrepared();
      accumulator.clear();
      composition += 1;
      setBatch(accumulator.intents);
      patch({ flow: { name: 'composing' }, notice: null });
    },

    acknowledge(): void {
      const flow = store.getState().flow;
      if (flow.name !== 'submitted') return;
      receipts.acknowledge(flow.transactionHash);
      patch({ flow: { name: 'composing' }, notice: null });
    },

    dismissNotice(): void {
      patch({ notice: null });
    },
  });
  return panel;

  async function feeMovedPast(summary: PreparedSummary, signal?: AbortSignal): Promise<boolean> {
    try {
      const pool = await operations.poolConfig(signal);
      return pool.feeAmount + summary.gasEstimate > summary.feeCeiling;
    } catch {
      return false;
    }
  }
}

/**
 * A batch shape, as an order-independent key.
 *
 * Sorted because the seam prices a set of actions, not a sequence of them, so
 * two orderings of the same actions are one observation rather than two.
 */
function shapeKey(kinds: readonly string[]): string {
  return [...kinds].sort().join('+');
}

/** What the visit has already committed to spend, in the pool's fee token. */
function queuedSpend(intents: readonly Intent[]): bigint {
  return intents.reduce(
    (total, intent) =>
      total + (intent.kind === 'swap' || intent.kind === 'stake' ? intent.amountIn : intent.amount),
    0n,
  );
}

function initialState(mode: BankMode, register: readonly RouteGrade[]): BankState {
  const routeId = ROUTE_BY_MODE[mode];
  return {
    mode,
    routeId,
    door: routeDoor(routeId, register),
    disclosure: routeDisclosure(routeId, register),
    batchDisclosures: [],
    pool: null,
    token: null,
    balance: { status: 'unrequested' },
    publicBalance: { status: 'unrequested' },
    quotedGasForNextIntent: null,
    amountText: '',
    recipientText: '',
    batch: [],
    adding: false,
    notice: null,
    flow: { name: 'idle' },
  };
}

function freezeIntent(intent: Intent): Intent {
  return Object.freeze({ ...intent }) as Intent;
}

function freezeBankState(state: BankState): BankState {
  const balance = Object.freeze({ ...state.balance }) as BalanceView;
  const flow = state.flow.name === 'review' || state.flow.name === 'submitting'
    ? Object.freeze({
        ...state.flow,
        summary: Object.freeze({
          ...state.flow.summary,
          intents: Object.freeze(state.flow.summary.intents.map(freezeIntent)),
          warnings: Object.freeze(state.flow.summary.warnings.map((warning) => Object.freeze({ ...warning }))),
          disclosures: Object.freeze([...state.flow.summary.disclosures]),
        }),
      })
    : Object.freeze({ ...state.flow });
  return Object.freeze({
    ...state,
    door: Object.freeze({ ...state.door }),
    batchDisclosures: Object.freeze([...state.batchDisclosures]),
    pool: state.pool === null ? null : Object.freeze({ ...state.pool }),
    balance,
    publicBalance: Object.freeze({ ...state.publicBalance }) as PublicBalanceView,
    batch: Object.freeze(state.batch.map(freezeIntent)),
    notice: state.notice === null ? null : Object.freeze({ ...state.notice }),
    flow,
  });
}

/** Every pending string on screen comes from here — from a stage, never a count. */
export function stageCopy(stage: OperationStage): string {
  switch (stage) {
    case 'composing':
      return COPY.flow.handingOver;
    case 'awaiting-approval':
      return COPY.flow.awaitingApproval;
    case 'proving':
      return COPY.flow.proving;
    case 'submitting':
      return COPY.flow.submitting;
    case 'confirming':
      return COPY.flow.confirming;
    case 'done':
      return COPY.flow.done;
    case 'failed':
      return COPY.errors.unknown;
  }
}

/**
 * What the player reads for a refused intent. `incoming` is the kind being
 * added, when there is one: a shield refused behind a queued spend (often one
 * whose prepare failed) is told to remove that item, since there is no queued
 * shield to confirm on its own.
 */
export function rejectionCopy(rejection: BatchRejectionReason, incoming?: Intent['kind']): string {
  switch (rejection.reason) {
    case 'mixed-shield-and-spend':
      return incoming === 'shield' ? COPY.notices.shieldAfterSpend : COPY.notices.mixedShieldAndSpend;
    case 'mixed-route-kinds':
      return COPY.notices.mixedRouteKinds;
    case 'swap-must-be-alone':
      return COPY.notices.swapAlone;
    case 'stake-must-be-alone':
      return COPY.notices.stakeAlone;
    case 'one-recipient-per-send':
      return COPY.notices.oneRecipientPerSend;
    case 'one-unshield-per-send':
      return COPY.notices.oneUnshieldPerSend;
    case 'non-positive-amount':
      return COPY.notices.badAmount;
    case 'batch-full':
      return COPY.notices.batchFull;
    case 'empty-batch':
      return COPY.notices.emptyBatch;
    case 'not-an-intent':
      return COPY.notices.notAnIntent;
  }
}
