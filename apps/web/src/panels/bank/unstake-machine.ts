import type {
  Address,
  EndurAction,
  EndurWithdrawalRequest,
  OperationStage,
  PreparedEndurBatch,
  PrivacyErrorKind,
  PrivacyOperations,
  VaultOutcome,
} from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { parseTokenAmount, sameAddress } from '../../format.js';
import { XSTRK_TOKEN } from '../../production/config.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import { toFailure, type ShellFailure } from '../../privacy/errors.js';
import type { ReceiptLedger } from '../../receipts/receipt-ledger.js';
import { createStore, type ReadableStore } from '../../store/store.js';
import {
  ENDUR_CLAIM_ROUTE,
  ENDUR_UNSTAKE_ROUTE,
  routeDisclosure,
  routeDoor,
  routeRequiresDisclosure,
  type DoorState,
} from '../routes.js';
import { stageCopy } from './bank-machine.js';

/**
 * The Bank's unstaking counter, as a state machine (D-085): xSTRK out of the
 * pool into Endur's withdrawal queue through the player's unstaking shadow
 * account, and the STRK back into the pool once Endur releases it.
 *
 * The seam owns everything protocol-shaped (the commitment, the stand-in
 * address, the queue, the calls, the collect policy). This machine names
 * only an xSTRK amount, "request" and "claim", so the shell can never compose
 * a target, a selector or calldata (D-018). Its rules are the Vault's
 * counter's (`vault-machine.ts`), for the same reasons:
 *
 * - **Nothing that could prompt is read on its own.** Opening asks the
 *   wallet which API it speaks, a version query that prompts nobody. The
 *   requests are read only when the player asks: the wallet derives a
 *   commitment, and may ask first.
 * - **Time comes from the chain.** Each request is waiting or ready by the
 *   latest block's timestamp, as the seam reports it; the browser's clock
 *   decides nothing, and the counter never counts down on its own.
 * - **A request needs xSTRK in the pool balance.** Reviewing one first reads
 *   that one balance (a player action); with none there it says so and asks
 *   the wallet nothing more.
 * - **A claim needs something to claim**: a ready request or STRK Endur has
 *   already paid to the stand-in address. Otherwise the counter offers none.
 * - **The stand-in address stays in memory**, never stored, logged or sent
 *   anywhere by this machine (D-079's rule).
 * - **The approved disclosure is on screen at the commit point** (D-020,
 *   D-024), from the register, for the route actually prepared.
 * - **Every submission is an attempt with an identity**: a second confirm
 *   cannot start, a late answer cannot overwrite a newer surface, and the
 *   hash is recorded before anything else.
 */

export type UnstakeCapabilityView =
  | { readonly status: 'checking' }
  | { readonly status: 'supported' }
  | { readonly status: 'unsupported' }
  | { readonly status: 'failed'; readonly kind: PrivacyErrorKind; readonly message: string };

export type UnstakePositionView =
  /** Never read, or changed by a submission. The player asks; nothing reads on its own. */
  | { readonly status: 'unrequested' }
  | { readonly status: 'loading' }
  | {
      readonly status: 'loaded';
      /** Public on-chain; held here for the counter's line and link, never stored. */
      readonly standIn: Address;
      readonly chainTime: number;
      readonly requests: readonly EndurWithdrawalRequest[];
      readonly strkHeld: bigint;
      readonly xstrkHeld: bigint;
      readonly unlisted: number;
      /** False when the read's scan ran out of pages: the list may be missing requests. */
      readonly complete: boolean;
    }
  | { readonly status: 'failed'; readonly kind: PrivacyErrorKind; readonly message: string };

/** What the player agrees to, from the prepared batch rather than from a constant. */
export interface UnstakeSummary {
  readonly action: EndurAction;
  readonly routeId: string;
  readonly poolFee: bigint;
  readonly gasEstimate: bigint;
  readonly totalCost: bigint;
  /** The hard guard passed to `confirm`. Never signs above the prepared total. */
  readonly feeCeiling: bigint;
  /** The prepared route's approved disclosure, verbatim, for the commit point. */
  readonly disclosures: readonly string[];
  readonly requiresDisclosure: boolean;
  /**
   * Leaderboard phase 1: present, and true, only when the prepared batch
   * carries a private placement receipt or tick. The review says so, subtly.
   */
  readonly countsTowardPlacement?: true;
}

export type UnstakeFlow =
  | { readonly name: 'idle' }
  | { readonly name: 'composing' }
  | { readonly name: 'preparing' }
  | { readonly name: 'review'; readonly summary: UnstakeSummary }
  | { readonly name: 'submitting'; readonly stage: OperationStage; readonly message: string; readonly summary: UnstakeSummary }
  | { readonly name: 'submitted'; readonly transactionHash: string; readonly outcome: VaultOutcome; readonly kind: EndurAction['kind'] }
  | { readonly name: 'failed'; readonly kind: PrivacyErrorKind; readonly message: string; readonly recovery: 'prepare-again' | 'close' };

export interface UnstakeNotice {
  readonly tone: 'error' | 'info';
  readonly text: string;
}

export interface UnstakeState {
  /** The request route's door: the counter's own. */
  readonly door: DoorState;
  /** The claim route's door. */
  readonly claimDoor: DoorState;
  readonly capability: UnstakeCapabilityView;
  readonly position: UnstakePositionView;
  /** The last request review found no xSTRK in the pool balance. */
  readonly noXstrk: boolean;
  readonly amountText: string;
  readonly notice: UnstakeNotice | null;
  readonly flow: UnstakeFlow;
}

export interface UnstakePanelOptions {
  operations: PrivacyOperations;
  receipts: ReceiptLedger;
  /** Session-level capability for starting financial work: the live D-035 gate. */
  canStartFinancialAction: () => boolean;
  /** Every failure, for the connect flow and the session notice. Kind only. */
  onError?: (failure: ShellFailure) => void;
  register?: readonly RouteGrade[];
  /** Headroom over the prepared total. Zero: never sign a fee larger than the one shown. */
  feeTolerance?: bigint;
}

export interface UnstakePanel {
  readonly store: ReadableStore<UnstakeState>;
  open(signal?: AbortSignal): Promise<void>;
  close(): void;
  recheck(signal?: AbortSignal): Promise<void>;
  setAmount(text: string): void;
  /** Read the requests. The wallet may ask first. */
  refreshPosition(signal?: AbortSignal): Promise<void>;
  prepareRequest(signal?: AbortSignal): Promise<void>;
  prepareClaim(signal?: AbortSignal): Promise<void>;
  confirm(signal?: AbortSignal): Promise<void>;
  cancelPrepared(): void;
  acknowledge(): void;
}

/** xSTRK's decimals (D-063): its amounts are typed and shown in these. */
export const XSTRK_DECIMALS = 18;

/**
 * Whether the last read leaves anything to claim: STRK already paid to the
 * stand-in, or a request whose claim a dry run found payable now. A request
 * past its wait that Endur has not funded is not claimable (D-085).
 */
export function hasClaimable(position: UnstakePositionView): boolean {
  return position.status === 'loaded'
    && (position.strkHeld > 0n || position.requests.some((entry) => entry.status === 'ready'));
}

/**
 * Time left as the counter says it, from whole seconds: "6 days 23 hours",
 * "5 hours 12 minutes", "40 minutes", "under a minute". Never seconds, and
 * never more than two units: the chain's clock moves in blocks, not ticks.
 */
export function formatTimeLeft(seconds: number): string {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return 'under a minute';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? '' : 's'}`;
  if (days > 0) return hours > 0 ? `${unit(days, 'day')} ${unit(hours, 'hour')}` : unit(days, 'day');
  if (hours > 0) return minutes > 0 ? `${unit(hours, 'hour')} ${unit(minutes, 'minute')}` : unit(hours, 'hour');
  if (minutes > 0) return unit(minutes, 'minute');
  return 'under a minute';
}

export function createUnstakePanel(options: UnstakePanelOptions): UnstakePanel {
  const { operations, receipts, onError } = options;
  const canStartFinancialAction = options.canStartFinancialAction ?? (() => false);
  const register = options.register ?? PRIVACY_REGISTER;
  const feeTolerance = options.feeTolerance ?? 0n;

  const stateStore = createStore<UnstakeState>(freeze(initialState(register)));
  const store: ReadableStore<UnstakeState> = Object.freeze({
    getState: stateStore.getState,
    getServerSnapshot: stateStore.getServerSnapshot,
    subscribe: stateStore.subscribe,
  });
  let prepared: PreparedEndurBatch | null = null;
  let signingBatch: PreparedEndurBatch | null = null;
  let attempt = 0;
  let session = 0;
  let positionRead = 0;
  let capabilityRead = 0;
  const begin = (): number => (attempt += 1);
  const current = (id: number): boolean => attempt === id;

  function patch(next: Partial<UnstakeState>): void {
    stateStore.setState((previous) => freeze({ ...previous, ...next }));
  }

  function notice(tone: UnstakeNotice['tone'], text: string): void {
    patch({ notice: { tone, text } });
  }

  function report(kind: PrivacyErrorKind): void {
    onError?.({ kind, cause: null });
  }

  function gateOpen(): boolean {
    if (canStartFinancialAction()) return true;
    notice('error', COPY.errors['submission-uncertain']);
    return false;
  }

  function discardPrepared(): void {
    if (prepared !== null && prepared === signingBatch) {
      prepared = null;
      return;
    }
    try {
      prepared?.discard();
    } catch {
      // Releasing a stale batch cannot fail the player's next step.
    }
    prepared = null;
  }

  function fail(error: unknown, recovery: 'prepare-again' | 'close', id: number): void {
    const { kind } = toFailure(error);
    if (!current(id)) return;
    report(kind);
    discardPrepared();
    if (kind === 'shadow-accounts-unsupported') patch({ capability: { status: 'unsupported' } });
    patch({
      flow: {
        name: 'failed',
        kind,
        message: COPY.errors[kind],
        recovery: kind === 'shadow-accounts-unsupported' ? 'close' : recovery,
      },
    });
  }

  async function checkCapability(signal?: AbortSignal): Promise<void> {
    const mySession = session;
    const read = ++capabilityRead;
    patch({ capability: { status: 'checking' } });
    try {
      const capability = await operations.capability(signal);
      if (session !== mySession || read !== capabilityRead) return;
      patch({ capability: { status: capability.supportsShadowAccounts === true ? 'supported' : 'unsupported' } });
    } catch (error) {
      if (session !== mySession || read !== capabilityRead) return;
      const { kind } = toFailure(error);
      report(kind);
      patch({ capability: { status: 'failed', kind, message: COPY.errors[kind] } });
    }
  }

  /** Whether the pool balance holds any xSTRK. The figure itself never leaves this function. */
  async function xstrkInPool(signal?: AbortSignal): Promise<'some' | 'none' | 'declined' | 'unknown'> {
    try {
      const balances = await operations.balances([XSTRK_TOKEN], signal);
      const entry = balances.find((candidate) => sameAddress(candidate.token, XSTRK_TOKEN));
      return (entry?.total ?? 0n) > 0n ? 'some' : 'none';
    } catch (error) {
      return toFailure(error).kind === 'user-rejected' ? 'declined' : 'unknown';
    }
  }

  async function prepareWith(
    routeId: string,
    run: (signal?: AbortSignal) => Promise<PreparedEndurBatch>,
    id: number,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const batch = await run(signal);
      if (!current(id)) {
        try {
          batch.discard();
        } catch {
          // A batch nobody will confirm.
        }
        return;
      }
      prepared = batch;
      const disclosure = routeDisclosure(routeId, register);
      patch({
        flow: {
          name: 'review',
          summary: {
            action: batch.action,
            routeId,
            poolFee: batch.poolFee,
            gasEstimate: batch.gasEstimate,
            totalCost: batch.totalCost,
            feeCeiling: batch.totalCost + feeTolerance,
            disclosures: disclosure ? [disclosure] : [],
            requiresDisclosure: routeRequiresDisclosure(routeId, register),
            ...(batch.countsTowardPlacement === true ? { countsTowardPlacement: true as const } : {}),
          },
        },
      });
    } catch (error) {
      fail(error, 'prepare-again', id);
    }
  }

  function canPrepare(): boolean {
    const state = store.getState();
    return state.door.open
      && state.capability.status === 'supported'
      && (state.flow.name === 'composing' || state.flow.name === 'failed');
  }

  return Object.freeze<UnstakePanel>({
    store,

    async open(signal?: AbortSignal): Promise<void> {
      session += 1;
      begin();
      discardPrepared();
      positionRead += 1;
      stateStore.setState(freeze({ ...initialState(register), flow: { name: 'composing' } }));
      await checkCapability(signal);
    },

    close(): void {
      session += 1;
      begin();
      discardPrepared();
      positionRead += 1;
      capabilityRead += 1;
    },

    async recheck(signal?: AbortSignal): Promise<void> {
      await checkCapability(signal);
    },

    setAmount(text: string): void {
      const state = store.getState();
      if (state.flow.name === 'submitting') return;
      if (state.flow.name === 'review' || state.flow.name === 'preparing') {
        begin();
        discardPrepared();
        patch({ amountText: text, noXstrk: false, flow: { name: 'composing' } });
        return;
      }
      patch({ amountText: text, noXstrk: false });
    },

    async refreshPosition(signal?: AbortSignal): Promise<void> {
      const mySession = session;
      const read = ++positionRead;
      patch({ position: { status: 'loading' } });
      try {
        const answer = await operations.endurUnstakePosition({ signal });
        if (session !== mySession || read !== positionRead) return;
        patch({
          position: {
            status: 'loaded',
            standIn: answer.standIn,
            chainTime: answer.chainTime,
            requests: answer.requests,
            strkHeld: answer.strkHeld,
            xstrkHeld: answer.xstrkHeld,
            unlisted: answer.unlisted,
            complete: answer.complete,
          },
        });
      } catch (error) {
        if (session !== mySession || read !== positionRead) return;
        const { kind } = toFailure(error);
        report(kind);
        patch({
          position: { status: 'failed', kind, message: COPY.errors[kind] },
          ...(kind === 'shadow-accounts-unsupported' ? { capability: { status: 'unsupported' } as const } : {}),
        });
      }
    },

    async prepareRequest(signal?: AbortSignal): Promise<void> {
      if (!gateOpen() || !canPrepare()) return;
      const shares = parseTokenAmount(store.getState().amountText, XSTRK_DECIMALS);
      if (shares === null || shares <= 0n) {
        notice('error', COPY.notices.badAmount);
        return;
      }
      const id = begin();
      discardPrepared();
      patch({ flow: { name: 'preparing' }, notice: null, noXstrk: false });
      const held = await xstrkInPool(signal);
      if (!current(id)) return;
      if (held === 'declined') {
        patch({ flow: { name: 'composing' } });
        return;
      }
      if (held === 'none') {
        patch({ flow: { name: 'composing' }, noXstrk: true });
        return;
      }
      await prepareWith(ENDUR_UNSTAKE_ROUTE, (s) => operations.prepareEndurUnstake(shares, { signal: s }), id, signal);
    },

    async prepareClaim(signal?: AbortSignal): Promise<void> {
      if (!gateOpen() || !canPrepare()) return;
      if (!store.getState().claimDoor.open) return;
      const id = begin();
      discardPrepared();
      patch({ flow: { name: 'preparing' }, notice: null });
      await prepareWith(ENDUR_CLAIM_ROUTE, (s) => operations.prepareEndurClaim({ signal: s }), id, signal);
    },

    async confirm(signal?: AbortSignal): Promise<void> {
      if (!gateOpen()) return;
      const state = store.getState();
      const batch = prepared;
      if (state.flow.name !== 'review' || !batch) return;
      const { summary } = state.flow;
      // Leave `review` synchronously: a second click finds the flow moved on.
      const id = begin();
      patch({ flow: { name: 'submitting', stage: 'composing', message: COPY.flow.handingOver, summary } });

      // The live fee first, so a moved fee reads as that rather than as a
      // generic failure; the seam's own ceiling check still stands behind it.
      try {
        const pool = await operations.poolConfig(signal);
        if (!current(id)) return;
        if (!canStartFinancialAction()) {
          patch({ flow: { name: 'review', summary } });
          notice('error', COPY.errors['submission-uncertain']);
          return;
        }
        if (pool.feeAmount + summary.gasEstimate > summary.feeCeiling) {
          discardPrepared();
          patch({ flow: { name: 'failed', kind: 'unknown', message: COPY.notices.feeMoved, recovery: 'prepare-again' } });
          return;
        }
      } catch (error) {
        fail(error, 'prepare-again', id);
        return;
      }

      signingBatch = batch;
      const record = (transactionHash: string): void => {
        // First, and whether or not this window is still open: the hash is
        // the player's only proof, and the ledger ignores a repeat.
        receipts.record({ building: 'bank', transactionHash, intents: [] });
      };
      try {
        const result = await batch.confirm({
          feeCeiling: summary.feeCeiling,
          signal,
          onSubmitted: ({ transactionHash }) => record(transactionHash),
          onProgress: ({ stage }) => {
            if (!current(id)) return;
            patch({ flow: { name: 'submitting', stage, message: stageCopy(stage), summary } });
          },
        });
        if (signingBatch === batch) signingBatch = null;
        record(result.transactionHash);
        if (prepared === batch) prepared = null;
        positionRead += 1;
        if (!current(id)) return;
        patch({
          flow: { name: 'submitted', transactionHash: result.transactionHash, outcome: result.outcome, kind: summary.action.kind },
          position: { status: 'unrequested' },
          notice: result.outcome === 'reverted' ? null : { tone: 'info', text: COPY.unstake.changed },
          amountText: '',
        });
      } catch (error) {
        if (signingBatch === batch) signingBatch = null;
        fail(error, 'prepare-again', id);
      }
    },

    cancelPrepared(): void {
      if (store.getState().flow.name === 'submitting') return;
      begin();
      discardPrepared();
      patch({ flow: { name: 'composing' }, notice: null });
    },

    acknowledge(): void {
      const flow = store.getState().flow;
      if (flow.name !== 'submitted') return;
      receipts.acknowledge(flow.transactionHash);
      patch({ flow: { name: 'composing' }, notice: null });
    },
  });
}

function initialState(register: readonly RouteGrade[]): UnstakeState {
  return {
    door: routeDoor(ENDUR_UNSTAKE_ROUTE, register),
    claimDoor: routeDoor(ENDUR_CLAIM_ROUTE, register),
    capability: { status: 'checking' },
    position: { status: 'unrequested' },
    noXstrk: false,
    amountText: '',
    notice: null,
    flow: { name: 'idle' },
  };
}

function freeze(state: UnstakeState): UnstakeState {
  const flow = state.flow.name === 'review' || state.flow.name === 'submitting'
    ? Object.freeze({
        ...state.flow,
        summary: Object.freeze({
          ...state.flow.summary,
          action: Object.freeze({ ...state.flow.summary.action }) as EndurAction,
          disclosures: Object.freeze([...state.flow.summary.disclosures]),
        }),
      })
    : Object.freeze({ ...state.flow });
  const position = state.position.status === 'loaded'
    ? Object.freeze({
        ...state.position,
        requests: Object.freeze(state.position.requests.map((entry) => Object.freeze({ ...entry }))),
      })
    : Object.freeze({ ...state.position });
  return Object.freeze({
    ...state,
    door: Object.freeze({ ...state.door }),
    claimDoor: Object.freeze({ ...state.claimDoor }),
    capability: Object.freeze({ ...state.capability }) as UnstakeCapabilityView,
    position: position as UnstakePositionView,
    notice: state.notice === null ? null : Object.freeze({ ...state.notice }),
    flow: flow as UnstakeFlow,
  });
}
