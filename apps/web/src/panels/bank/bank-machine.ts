import {
  PrivacyError,
  type Address,
  type BatchWarning,
  type Intent,
  type OperationStage,
  type PoolConfig,
  type PreparedBatch,
  type PrivacyErrorKind,
  type PrivacyOperations,
} from '@strkworld/privacy';
import type { RouteGrade } from '@strkworld/shared/src/privacy-grades.js';
import { PRIVACY_REGISTER } from '@strkworld/shared/src/privacy-grades.js';
import { COPY } from '../../copy.js';
import { formatTokenAmountExact, looksLikeAddress, parseTokenAmount, sameAddress } from '../../format.js';
import { createStore, type Store } from '../../store/store.js';
import {
  createBatchAccumulator,
  type BatchAccumulator,
  type BatchRejectionReason,
} from '../../accumulator/batch-accumulator.js';
import { routeDisclosure, routeDoor, type DoorState } from '../routes.js';

/**
 * The Bank panel, as a state machine.
 *
 * The Bank is the whole pool-native action set behind one door: shield,
 * unshield, and a private transfer to another player. All three go out as typed
 * intent through the batch accumulator; the panel never composes a protocol
 * action and has no way to name a contract or a selector (D-018).
 *
 * Three behaviours here are consequences of verified wallet behaviour rather
 * than taste, and are the reason this is a state machine and not a form:
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
 */

export type BankMode = 'shield' | 'unshield' | 'transfer';

/**
 * The register grades the private transfer once, as `post-office.transfer`.
 * The Bank's transfer control drives that exact route, so it reads that entry
 * rather than inventing a `bank.transfer` grade the project lead never saw. If
 * the Bank's transfer is ever meant to be a distinct route, it needs its own
 * register entry — which is a frozen-seam change and a decision entry.
 */
export const ROUTE_BY_MODE: Record<BankMode, string> = {
  shield: 'bank.shield',
  unshield: 'bank.unshield',
  transfer: 'post-office.transfer',
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
}

export type BankFlow =
  | { name: 'idle' }
  | { name: 'loading-pool' }
  | { name: 'composing' }
  | { name: 'preparing' }
  | { name: 'review'; summary: PreparedSummary }
  | { name: 'submitting'; stage: OperationStage; message: string }
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
  /** Approved copy, imported verbatim from the register. Null when private. */
  disclosure: string | null;
  pool: PoolConfig | null;
  /** The game's money and its fee token, read live rather than hardcoded. */
  token: Address | null;
  balance: BalanceView;
  amountText: string;
  recipientText: string;
  batch: readonly Intent[];
  notice: BankNotice | null;
  flow: BankFlow;
}

export interface BankPanelOptions {
  operations: PrivacyOperations;
  /**
   * Called with every `PrivacyError` the panel sees so the shell can escalate
   * a 118 or a 162 into its designed room. The panel still shows its own state.
   */
  onError?: (error: PrivacyError) => void;
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

  function patch(next: Partial<BankState>): void {
    store.setState((previous) => ({ ...previous, ...next }));
  }

  function notice(tone: BankNotice['tone'], text: string): void {
    patch({ notice: { tone, text } });
  }

  function fail(error: unknown, recovery: 'prepare-again' | 'close'): void {
    const privacyError = asPrivacyError(error);
    onError?.(privacyError);
    discardPrepared();
    patch({
      flow: {
        name: 'failed',
        kind: privacyError.kind,
        message: COPY.errors[privacyError.kind],
        recovery,
      },
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
    if (fee === undefined) return null;
    const spendable = state.balance.spendable - fee;
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
      patch({ flow: { name: 'loading-pool' } });
      try {
        const pool = await operations.poolConfig(signal);
        patch({ pool, token: pool.feeToken, flow: { name: 'composing' } });
      } catch (error) {
        fail(error, 'close');
      }
    },

    close(): void {
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
        const privacyError = asPrivacyError(error);
        onError?.(privacyError);
        patch({
          balance: {
            status: 'failed',
            kind: privacyError.kind,
            message: COPY.errors[privacyError.kind],
          },
        });
      }
    },

    maxSpendable: computeMax,

    applyMax(): void {
      const max = computeMax();
      if (max === null) {
        notice('info', COPY.balance.maturityUnknown);
        return;
      }
      patch({ amountText: formatTokenAmountExact(max), notice: { tone: 'info', text: COPY.balance.feeReserved } });
    },

    async addToBatch(signal?: AbortSignal): Promise<void> {
      const state = store.getState();
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
          const privacyError = asPrivacyError(error);
          onError?.(privacyError);
          notice('error', COPY.errors[privacyError.kind]);
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

      patch({
        batch: result.value,
        amountText: '',
        recipientText: '',
        notice: pending,
      });
    },

    removeFromBatch(index: number): void {
      patch({ batch: accumulator.remove(index) });
    },

    clearBatch(): void {
      accumulator.clear();
      discardPrepared();
      patch({ batch: accumulator.intents, notice: null, flow: { name: 'composing' } });
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

      discardPrepared();
      patch({ flow: { name: 'preparing' }, notice: null });
      try {
        const batch = await operations.prepare([...confirmed.value], signal);
        prepared = batch;
        patch({
          flow: {
            name: 'review',
            summary: {
              intents: batch.intents,
              poolFee: batch.poolFee,
              gasEstimate: batch.gasEstimate,
              totalCost: batch.totalCost,
              feeCeiling: batch.totalCost + feeTolerance,
              warnings: batch.warnings,
              // `promptCount` is deliberately not carried into the summary:
              // it is a source-derived expectation awaiting the funded run
              // (D-028), and no pending UI may be driven from it.
            },
          },
        });
      } catch (error) {
        fail(error, 'prepare-again');
      }
    },

    async confirm(signal?: AbortSignal): Promise<void> {
      const state = store.getState();
      const batch = prepared;
      if (state.flow.name !== 'review' || !batch) return;
      const { summary } = state.flow;

      // Re-read the live fee before asking the wallet for anything. The seam's
      // ceiling is the real guard and is still passed below, but it can only
      // report "the fee moved" as a generic failure; reading it here means the
      // player gets that sentence instead of "something went wrong".
      try {
        const pool = await operations.poolConfig(signal);
        patch({ pool });
        if (pool.feeAmount + summary.gasEstimate > summary.feeCeiling) {
          discardPrepared();
          patch({
            flow: { name: 'failed', kind: 'unknown', message: COPY.notices.feeMoved, recovery: 'prepare-again' },
          });
          return;
        }
      } catch (error) {
        fail(error, 'prepare-again');
        return;
      }

      patch({ flow: { name: 'submitting', stage: 'composing', message: COPY.flow.handingOver } });
      try {
        const result = await batch.confirm({
          feeCeiling: summary.feeCeiling,
          signal,
          onProgress: ({ stage }) => {
            patch({ flow: { name: 'submitting', stage, message: stageCopy(stage) } });
          },
        });
        prepared = null;
        accumulator.clear();
        patch({
          batch: accumulator.intents,
          flow: { name: 'submitted', transactionHash: result.transactionHash },
          // The balance moved. It is not re-read here: the player asks.
          balance: { status: 'unrequested' },
          notice: { tone: 'info', text: COPY.balance.changed },
        });
      } catch (error) {
        fail(error, 'prepare-again');
      }
    },

    cancelPrepared(): void {
      discardPrepared();
      patch({ flow: { name: 'composing' }, notice: null });
    },

    dismissNotice(): void {
      patch({ notice: null });
    },
  };
}

function initialState(mode: BankMode, register: readonly RouteGrade[]): BankState {
  const routeId = ROUTE_BY_MODE[mode];
  return {
    mode,
    routeId,
    door: routeDoor(routeId, register),
    disclosure: routeDisclosure(routeId, register),
    pool: null,
    token: null,
    balance: { status: 'unrequested' },
    amountText: '',
    recipientText: '',
    batch: [],
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

function asPrivacyError(error: unknown): PrivacyError {
  if (error instanceof PrivacyError) return error;
  return new PrivacyError('unknown', 'unmapped failure', error);
}
