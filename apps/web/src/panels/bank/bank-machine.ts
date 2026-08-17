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
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import { toFailure, type ShellFailure } from '../../privacy/errors.js';
import { COPY } from '../../copy.js';
import { formatTokenAmountExact, looksLikeAddress, parseTokenAmount, sameAddress } from '../../format.js';
import { createStore, type Store } from '../../store/store.js';
import {
  createBatchAccumulator,
  type BatchAccumulator,
  type BatchRejectionReason,
} from '../../accumulator/batch-accumulator.js';
import {
  ROUTE_BY_INTENT_KIND,
  disclosuresForIntents,
  routeDisclosure,
  routeDoor,
  type DoorState,
} from '../routes.js';

/**
 * The Bank panel, as a state machine.
 *
 * The Bank is the whole pool-native action set behind one door: shield,
 * unshield, and a private transfer to another player. All three go out as typed
 * intent through the batch accumulator; the panel never composes a protocol
 * action and has no way to name a contract or a selector (D-018).
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
 * at the commit point is derived from the intents actually queued, so switching
 * tab after queuing a shield cannot hide the fact that a public deposit is what
 * is about to be signed (D-020, D-024).
 *
 * **Every submission is an attempt with an identity.** A second confirm cannot
 * start, and a late answer from an abandoned attempt cannot overwrite the state
 * of the one that settled — telling a player "nothing was signed" about a
 * settled transaction is the worst lie this panel could tell.
 */

export type BankMode = 'shield' | 'unshield' | 'transfer';

/** The graded route each control drives. See `ROUTE_BY_INTENT_KIND`. */
export const ROUTE_BY_MODE: Record<BankMode, string> = {
  shield: ROUTE_BY_INTENT_KIND.shield,
  unshield: ROUTE_BY_INTENT_KIND.unshield,
  transfer: ROUTE_BY_INTENT_KIND.transfer,
};

export type BalanceView =
  /** Never read, or invalidated by a submission. The player asks; we do not. */
  | { status: 'unrequested' }
  | { status: 'loading' }
  | {
      status: 'loaded';
      total: bigint;
      /**
       * False when the wallet exposes one aggregate per token — the shipped
       * Wallet API shape. `spendable` and `maturing` are then conservative
       * zeroes and MAX is unavailable rather than invented (D-022).
       */
      maturityKnown: boolean;
      spendable: bigint;
      maturing: bigint;
      /** Increments on each successful read. Deterministic, unlike a clock. */
      readCount: number;
    }
  | { status: 'failed'; kind: PrivacyErrorKind; message: string };

/**
 * What the player agrees to. Costs come from the prepared batch, not from a
 * constant — the pool fee is governance-settable and has moved once already.
 */
export interface PreparedSummary {
  intents: readonly Intent[];
  poolFee: bigint;
  gasEstimate: bigint;
  totalCost: bigint;
  /** The hard guard passed to `confirm`. Never signs above the quoted total. */
  feeCeiling: bigint;
  warnings: readonly BatchWarning[];
  /**
   * Approved disclosures for the routes in `intents`, verbatim from the
   * register. Carried on the summary so the commit surface cannot render
   * without them.
   */
  disclosures: readonly string[];
}

export type BankFlow =
  | { name: 'idle' }
  | { name: 'loading-pool' }
  | { name: 'composing' }
  | { name: 'preparing' }
  | { name: 'review'; summary: PreparedSummary }
  | {
      name: 'submitting';
      stage: OperationStage;
      message: string;
      /**
       * Carried through submission so the approved disclosures and the figures
       * stay on screen while the wallet works, rather than the panel swapping
       * out from under the player at the moment of commitment.
       */
      summary: PreparedSummary;
    }
  | { name: 'submitted'; transactionHash: string }
  | {
      name: 'failed';
      kind: PrivacyErrorKind;
      message: string;
      /** A prepared batch is single-attempt, so recovery means preparing again. */
      recovery: 'prepare-again' | 'close';
    };

export interface BankNotice {
  tone: 'error' | 'info';
  text: string;
}

export interface BankState {
  mode: BankMode;
  routeId: string;
  door: DoorState;
  /** Approved copy for the mode being composed. Null when the route is private. */
  disclosure: string | null;
  /** Approved copy for what is queued. The commit point renders these. */
  batchDisclosures: readonly string[];
  pool: PoolConfig | null;
  /** The game's money and its fee token, read live rather than hardcoded. */
  token: Address | null;
  balance: BalanceView;
  /**
   * Network cost from the most recent quote in this visit. The seam only
   * reports it at prepare time, and MAX is not offered without it.
   */
  quotedGasEstimate: bigint | null;
  amountText: string;
  recipientText: string;
  batch: readonly Intent[];
  /** True while a queue action is resolving, so a second click cannot double it. */
  adding: boolean;
  notice: BankNotice | null;
  flow: BankFlow;
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
  maxIntents?: number;
  /** Injectable for tests that need an unapproved route. */
  register?: readonly RouteGrade[];
  accumulator?: BatchAccumulator;
}

export interface BankPanel {
  readonly store: Store<BankState>;
  open(signal?: AbortSignal): Promise<void>;
  close(): void;
  setMode(mode: BankMode): void;
  setAmount(text: string): void;
  setRecipient(text: string): void;
  refreshBalance(signal?: AbortSignal): Promise<void>;
  /** `null` whenever a maximum would have to be guessed. See D-022. */
  maxSpendable(): bigint | null;
  applyMax(): void;
  addToBatch(signal?: AbortSignal): Promise<void>;
  removeFromBatch(index: number): void;
  clearBatch(): void;
  prepare(signal?: AbortSignal): Promise<void>;
  confirm(signal?: AbortSignal): Promise<void>;
  cancelPrepared(): void;
  /** Leave the receipt and return to the counter. */
  acknowledge(): void;
  dismissNotice(): void;
}

export function createBankPanel(options: BankPanelOptions): BankPanel {
  const { operations, onError } = options;
  const register = options.register ?? PRIVACY_REGISTER;
  const feeTolerance = options.feeTolerance ?? 0n;
  const accumulator = options.accumulator ?? createBatchAccumulator({ maxIntents: options.maxIntents });

  const store = createStore<BankState>(initialState('shield', register));
  let prepared: PreparedBatch | null = null;
  let readCount = 0;

  /**
   * Identity for the current prepare/confirm attempt.
   *
   * Every patch from an asynchronous step checks it. Without this, a late
   * rejection from an abandoned attempt can overwrite the state of the one
   * that succeeded.
   */
  let attempt = 0;
  const begin = (): number => (attempt += 1);
  const current = (id: number): boolean => attempt === id;

  function patch(next: Partial<BankState>): void {
    store.setState((previous) => ({ ...previous, ...next }));
  }

  function notice(tone: BankNotice['tone'], text: string): void {
    patch({ notice: { tone, text } });
  }

  function setBatch(intents: readonly Intent[]): void {
    patch({ batch: intents, batchDisclosures: disclosuresForIntents(intents, register) });
  }

  function fail(error: unknown, recovery: 'prepare-again' | 'close', id: number): void {
    const failure = toFailure(error);
    onError?.(failure);
    if (!current(id)) return;
    discardPrepared();
    patch({
      flow: { name: 'failed', kind: failure.kind, message: COPY.errors[failure.kind], recovery },
    });
  }

  function discardPrepared(): void {
    prepared?.discard();
    prepared = null;
  }

  function computeMax(): bigint | null {
    const state = store.getState();
    // Shielding spends public STRK, which the shell cannot see and must not
    // guess — and D-013's stranding trap means the last of it is exactly what
    // a player must not send.
    if (state.mode === 'shield') return null;
    if (state.balance.status !== 'loaded') return null;
    // The aggregate is not a spendable figure. Offering it as MAX is the
    // unsafe button D-022 exists to prevent.
    if (!state.balance.maturityKnown) return null;
    const fee = state.pool?.feeAmount;
    // Both fees come out of the same shielded balance, so a maximum that
    // reserves only the pool fee is a button that always fails at prepare.
    // The network cost is only known once something has been costed.
    if (fee === undefined || state.quotedGasEstimate === null) return null;
    const spendable = state.balance.spendable - fee - state.quotedGasEstimate;
    return spendable > 0n ? spendable : null;
  }

  return {
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
        patch({ pool, token: pool.feeToken, flow: { name: 'composing' } });
      } catch (error) {
        fail(error, 'close', id);
      }
    },

    close(): void {
      begin(); // Invalidate anything still in flight.
      discardPrepared();
      accumulator.clear();
      store.setState(initialState(store.getState().mode, register));
    },

    setMode(mode: BankMode): void {
      const routeId = ROUTE_BY_MODE[mode];
      patch({
        mode,
        routeId,
        door: routeDoor(routeId, register),
        disclosure: routeDisclosure(routeId, register),
        amountText: '',
        recipientText: '',
        notice: null,
      });
    },

    setAmount(text: string): void {
      patch({ amountText: text });
    },

    setRecipient(text: string): void {
      patch({ recipientText: text });
    },

    /** Only ever called from a player action. There is no timer in this file. */
    async refreshBalance(signal?: AbortSignal): Promise<void> {
      const { token } = store.getState();
      if (!token) {
        notice('error', COPY.notices.poolNotLoaded);
        return;
      }
      patch({ balance: { status: 'loading' }, notice: null });
      try {
        const balances = await operations.balances([token], signal);
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
        patch({
          amountText: formatTokenAmountExact(max),
          notice: { tone: 'info', text: COPY.balance.feeReserved },
        });
        return;
      }
      const state = store.getState();
      if (state.balance.status === 'loaded' && !state.balance.maturityKnown) {
        notice('info', COPY.balance.maturityUnknown);
        return;
      }
      notice('info', COPY.balance.costUnknown);
    },

    async addToBatch(signal?: AbortSignal): Promise<void> {
      const state = store.getState();
      // A second click while the first is still resolving would queue the same
      // intent twice, and the player would see one row appear and then another.
      if (state.adding) return;
      if (!state.door.open) {
        notice('error', state.door.message);
        return;
      }
      if (!state.token) {
        notice('error', COPY.notices.poolNotLoaded);
        return;
      }

      const amount = parseTokenAmount(state.amountText);
      if (amount === null || amount <= 0n) {
        notice('error', COPY.notices.badAmount);
        return;
      }

      let recipient = '';
      if (state.mode !== 'shield') {
        recipient = state.recipientText.trim();
        if (!looksLikeAddress(recipient)) {
          notice('error', COPY.notices.badRecipient);
          return;
        }
      }

      patch({ adding: true });
      try {
        let pending: BankNotice | null = null;
        if (state.mode === 'transfer') {
          // Preflight, because a transfer to an unregistered account otherwise
          // fails late in the wallet with nothing a player can act on. The pool
          // read and the 118 mapping must agree, so both exist.
          try {
            const status = await operations.recipientStatus(recipient, signal);
            if (status === 'unregistered') {
              notice('error', COPY.notices.recipientUnregistered);
              return;
            }
            if (status === 'unknown') {
              pending = { tone: 'info', text: COPY.notices.recipientUnknown };
            }
          } catch (error) {
            const failure = toFailure(error);
            onError?.(failure);
            notice('error', COPY.errors[failure.kind]);
            return;
          }
        }

        const intent: Intent =
          state.mode === 'shield'
            ? { kind: 'shield', token: state.token, amount }
            : state.mode === 'unshield'
              ? { kind: 'unshield', token: state.token, amount, recipient }
              : { kind: 'transfer', token: state.token, amount, recipient };

        const result = accumulator.accept(intent);
        if (!result.ok) {
          notice('error', rejectionCopy(result.rejection));
          return;
        }

        setBatch(result.value);
        patch({ amountText: '', recipientText: '', notice: pending });
      } finally {
        patch({ adding: false });
      }
    },

    removeFromBatch(index: number): void {
      setBatch(accumulator.remove(index));
    },

    clearBatch(): void {
      accumulator.clear();
      discardPrepared();
      setBatch(accumulator.intents);
      patch({ notice: null, flow: { name: 'composing' } });
    },

    /**
     * Cost the visit.
     *
     * This is a visible wallet interaction: the wallet raises a proving action
     * for the whole array, so the panel says so while it waits rather than
     * presenting it as a background preview.
     */
    async prepare(signal?: AbortSignal): Promise<void> {
      const confirmed = accumulator.confirm();
      if (!confirmed.ok) {
        notice('error', rejectionCopy(confirmed.rejection));
        return;
      }

      const id = begin();
      discardPrepared();
      patch({ flow: { name: 'preparing' }, notice: null });
      try {
        const batch = await operations.prepare([...confirmed.value], signal);
        if (!current(id)) {
          batch.discard();
          return;
        }
        prepared = batch;
        patch({
          quotedGasEstimate: batch.gasEstimate,
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
              // `promptCount` is deliberately not carried into the summary:
              // it is a source-derived expectation awaiting the funded run
              // (D-028), and no pending UI may be driven from it.
            },
          },
        });
      } catch (error) {
        fail(error, 'prepare-again', id);
      }
    },

    async confirm(signal?: AbortSignal): Promise<void> {
      const state = store.getState();
      const batch = prepared;
      if (state.flow.name !== 'review' || !batch) return;
      const { summary } = state.flow;

      // Leave `review` synchronously, before the first await. Two clicks in one
      // tick both reach here; the second finds the flow already moved on. The
      // disabled button is the courtesy, this is the guard.
      const id = begin();
      patch({ flow: { name: 'submitting', stage: 'composing', message: COPY.flow.handingOver, summary } });

      // Re-read the live fee before asking the wallet for anything. The seam's
      // ceiling is the real guard and is still passed below, but it can only
      // report "the fee moved" as a generic failure; reading it here means the
      // player gets that sentence instead of "something went wrong".
      try {
        const pool = await operations.poolConfig(signal);
        if (!current(id)) return;
        patch({ pool });
        if (pool.feeAmount + summary.gasEstimate > summary.feeCeiling) {
          discardPrepared();
          patch({
            flow: { name: 'failed', kind: 'unknown', message: COPY.notices.feeMoved, recovery: 'prepare-again' },
          });
          return;
        }
      } catch (error) {
        fail(error, 'prepare-again', id);
        return;
      }

      try {
        const result = await batch.confirm({
          feeCeiling: summary.feeCeiling,
          signal,
          onProgress: ({ stage }) => {
            if (!current(id)) return;
            patch({ flow: { name: 'submitting', stage, message: stageCopy(stage), summary } });
          },
        });
        if (!current(id)) return;
        prepared = null;
        accumulator.clear();
        setBatch(accumulator.intents);
        patch({
          flow: { name: 'submitted', transactionHash: result.transactionHash },
          // The balance moved. It is not re-read here: the player asks.
          balance: { status: 'unrequested' },
          notice: { tone: 'info', text: COPY.balance.changed },
        });
      } catch (error) {
        // The seam reports a ceiling breach as a generic failure, so ask the
        // pool whether that is what happened rather than matching on a string.
        if (toFailure(error).kind === 'unknown' && (await feeMovedPast(summary, signal))) {
          if (!current(id)) return;
          discardPrepared();
          patch({
            flow: { name: 'failed', kind: 'unknown', message: COPY.notices.feeMoved, recovery: 'prepare-again' },
          });
          return;
        }
        fail(error, 'prepare-again', id);
      }
    },

    cancelPrepared(): void {
      begin();
      discardPrepared();
      patch({ flow: { name: 'composing' }, notice: null });
    },

    acknowledge(): void {
      if (store.getState().flow.name !== 'submitted') return;
      patch({ flow: { name: 'composing' }, notice: null });
    },

    dismissNotice(): void {
      patch({ notice: null });
    },
  };

  async function feeMovedPast(summary: PreparedSummary, signal?: AbortSignal): Promise<boolean> {
    try {
      const pool = await operations.poolConfig(signal);
      return pool.feeAmount + summary.gasEstimate > summary.feeCeiling;
    } catch {
      return false;
    }
  }
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
    quotedGasEstimate: null,
    amountText: '',
    recipientText: '',
    batch: [],
    adding: false,
    notice: null,
    flow: { name: 'idle' },
  };
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

export function rejectionCopy(rejection: BatchRejectionReason): string {
  switch (rejection.reason) {
    case 'mixed-shield-and-spend':
      return COPY.notices.mixedShieldAndSpend;
    case 'mixed-route-kinds':
      return COPY.notices.mixedRouteKinds;
    case 'swap-must-be-alone':
      return COPY.notices.swapAlone;
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
