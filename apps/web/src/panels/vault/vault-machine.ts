import type {
  OperationStage,
  PreparedVaultBatch,
  PrivacyErrorKind,
  PrivacyOperations,
  VaultAction,
  VaultOutcome,
  VaultStage,
} from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { debugVault } from '../../debug/debug-tap.js';
import { parseTokenAmount } from '../../format.js';
import { STRK_TOKEN } from '../../production/config.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import { toFailure, type ShellFailure } from '../../privacy/errors.js';
import type { ReceiptLedger } from '../../receipts/receipt-ledger.js';
import { createStore, type ReadableStore } from '../../store/store.js';
import {
  VAULT_REDEEM_ROUTE,
  VAULT_SUPPLY_ROUTE,
  routeDisclosure,
  routeRequiresDisclosure,
  routeDoor,
  type DoorState,
} from '../routes.js';
import { stageCopy } from '../bank/bank-machine.js';

/**
 * The Vault's counter, as a state machine (D-077): Vesu lending from the
 * player's STRK20 shadow account.
 *
 * The seam owns everything protocol-shaped: the commitment, the stand-in
 * address and its cross-check, the Vesu calls and the collect policy. This
 * machine names only a mode, a STRK amount and "everything", so the shell can
 * never compose a target, a selector or calldata (D-018).
 *
 * The rules that make it a machine rather than a form:
 *
 * - **Nothing is read on its own.** Opening the counter asks the wallet which
 *   API it speaks, a version query that prompts nobody. The position is read
 *   only when the player asks: the wallet derives a commitment for it, and a
 *   wallet may ask first.
 * - **Capability, then the wallet's own answer.** A wallet below Wallet API
 *   0.10.4, or without the commitment method, is told plainly that it cannot
 *   run the Vault yet; so is one that then refuses the request as
 *   unsupported. That is a fact about the wallet's release, not the account:
 *   it stays in this window and never moves the connect flow.
 * - **The approved disclosure is on screen at the commit point** (D-020,
 *   D-024), from the register, for the route actually prepared.
 * - **Every submission is an attempt with an identity**, as in the Bank: a
 *   second confirm cannot start, and a late answer cannot overwrite a newer
 *   surface. Once the wallet returns a hash it is recorded before anything
 *   else, so closing the window never loses it.
 * - **The probe log sees codes only** (D-069): what the seam reports as
 *   stages, plus prepare and confirm steps, never an amount, a balance, an
 *   address or a hash. A failure handed on to the connect flow carries its
 *   kind alone, for the same reason: a wallet message could name the
 *   stand-in address.
 */

export type VaultMode = 'supply' | 'redeem';

/** A confirm stage as the probe log names it: the seam's own, or how the attempt ended here. */
export type VaultConfirmStage = OperationStage | 'submitted' | 'fee-moved' | 'gate-closed';

export const ROUTE_BY_VAULT_MODE: Readonly<Record<VaultMode, string>> = Object.freeze({
  supply: VAULT_SUPPLY_ROUTE,
  redeem: VAULT_REDEEM_ROUTE,
});

const ALL_VAULT_MODES: readonly VaultMode[] = Object.freeze(['supply', 'redeem']);

export type VaultCapabilityView =
  | { readonly status: 'checking' }
  | { readonly status: 'supported' }
  /** The wallet cannot run a shadow account yet: by version, method, or its own answer. */
  | { readonly status: 'unsupported' }
  | { readonly status: 'failed'; readonly kind: PrivacyErrorKind; readonly message: string };

export type VaultPositionView =
  /** Never read, or changed by a submission. The player asks; nothing reads on its own. */
  | { readonly status: 'unrequested' }
  | { readonly status: 'loading' }
  | {
      readonly status: 'loaded';
      readonly shares: bigint;
      readonly assets: bigint;
      readonly redeemable: bigint;
    }
  | { readonly status: 'failed'; readonly kind: PrivacyErrorKind; readonly message: string };

/** What the player agrees to, from the prepared batch rather than from a constant. */
export interface VaultSummary {
  readonly action: VaultAction;
  readonly poolFee: bigint;
  readonly gasEstimate: bigint;
  readonly totalCost: bigint;
  /** The hard guard passed to `confirm`. Never signs above the prepared total. */
  readonly feeCeiling: bigint;
  /** The prepared route's approved disclosure, verbatim, for the commit point. */
  readonly disclosures: readonly string[];
  readonly requiresDisclosure: boolean;
}

export type VaultFlow =
  | { readonly name: 'idle' }
  | { readonly name: 'composing' }
  | { readonly name: 'preparing' }
  | { readonly name: 'review'; readonly summary: VaultSummary }
  | {
      readonly name: 'submitting';
      readonly stage: OperationStage;
      readonly message: string;
      readonly summary: VaultSummary;
    }
  | {
      readonly name: 'submitted';
      readonly transactionHash: string;
      /** What the receipt said by the time the wait ended; `pending` is never a failure. */
      readonly outcome: VaultOutcome;
      /** Found outstanding on `open()` rather than confirmed in this window. */
      readonly restored?: boolean;
    }
  | {
      readonly name: 'failed';
      readonly kind: PrivacyErrorKind;
      readonly message: string;
      readonly recovery: 'prepare-again' | 'close';
    };

export interface VaultNotice {
  readonly tone: 'error' | 'info';
  readonly text: string;
}

export interface VaultState {
  readonly mode: VaultMode;
  readonly routeId: string;
  readonly door: DoorState;
  /** The mode's approved disclosure, previewed while composing. */
  readonly disclosure: string | null;
  readonly capability: VaultCapabilityView;
  readonly position: VaultPositionView;
  readonly amountText: string;
  /** Redeem only: every share, by the vault's `redeem`, rather than an amount. */
  readonly redeemAll: boolean;
  readonly notice: VaultNotice | null;
  readonly flow: VaultFlow;
}

export interface VaultPanelOptions {
  operations: PrivacyOperations;
  /** Where receipts go. Required, and outlives the panel (see `ReceiptLedger`). */
  receipts: ReceiptLedger;
  /** Session-level capability for starting financial work: the live D-035 gate. */
  canStartFinancialAction: () => boolean;
  /** Every failure, for the connect flow and the session notice. Kind only. */
  onError?: (failure: ShellFailure) => void;
  register?: readonly RouteGrade[];
  /** Headroom over the prepared total. Zero: never sign a fee larger than the one shown. */
  feeTolerance?: bigint;
  initialMode?: VaultMode;
}

export interface VaultPanel {
  readonly store: ReadableStore<VaultState>;
  open(signal?: AbortSignal): Promise<void>;
  close(): void;
  /** Ask the wallet again which API it speaks, after a failed check. */
  recheck(signal?: AbortSignal): Promise<void>;
  setMode(mode: VaultMode): void;
  setAmount(text: string): void;
  setRedeemAll(all: boolean): void;
  refreshPosition(signal?: AbortSignal): Promise<void>;
  prepare(signal?: AbortSignal): Promise<void>;
  confirm(signal?: AbortSignal): Promise<void>;
  cancelPrepared(): void;
  /** Leave the receipt and return to the counter. */
  acknowledge(): void;
}

export function createVaultPanel(options: VaultPanelOptions): VaultPanel {
  const { operations, receipts, onError } = options;
  const canStartFinancialAction = options.canStartFinancialAction ?? (() => false);
  const register = options.register ?? PRIVACY_REGISTER;
  const feeTolerance = options.feeTolerance ?? 0n;
  const initialMode = options.initialMode ?? 'supply';
  if (!ALL_VAULT_MODES.includes(initialMode)) throw new Error(`VaultPanel unsupported mode: ${String(initialMode)}`);

  const stateStore = createStore<VaultState>(freezeVaultState(initialState(initialMode, register)));
  const store: ReadableStore<VaultState> = Object.freeze({
    getState: stateStore.getState,
    getServerSnapshot: stateStore.getServerSnapshot,
    subscribe: stateStore.subscribe,
  });
  let prepared: PreparedVaultBatch | null = null;
  /** The batch the wallet is handling, which a close must not release. */
  let signingBatch: PreparedVaultBatch | null = null;
  /** A newer prepare or confirm, a cancel, or a mode change retires the older one. */
  let attempt = 0;
  /** The window closed: nothing may write into a reset store. */
  let session = 0;
  /** A newer read, or a submission that changed the position, retires a read. */
  let positionRead = 0;
  let capabilityRead = 0;
  const begin = (): number => (attempt += 1);
  const current = (id: number): boolean => attempt === id;

  function patch(next: Partial<VaultState>): void {
    stateStore.setState((previous) => freezeVaultState({ ...previous, ...next }));
  }

  function notice(tone: VaultNotice['tone'], text: string): void {
    patch({ notice: { tone, text } });
  }

  /** The failure, handed on by kind alone: the connect flow needs nothing else. */
  function report(kind: PrivacyErrorKind): void {
    onError?.({ kind, cause: null });
  }

  function gateOpen(): boolean {
    if (canStartFinancialAction()) return true;
    notice('error', COPY.errors['submission-uncertain']);
    return false;
  }

  /** Forward the seam's own stages to the probe log, untouched. */
  function forwardStage(stage: VaultStage): void {
    debugVault({ step: 'stage', stage });
  }

  function discardPrepared(): void {
    // A batch the wallet is already handling is not ours to release: the
    // transaction may be on its way whatever this window does.
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
    // An abandoned attempt writes nothing and reports nothing, as in the Bank.
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
      const supported = capability.supportsShadowAccounts === true;
      debugVault({ step: 'capability', supported, walletApi: capability.walletApiVersion });
      patch({ capability: { status: supported ? 'supported' : 'unsupported' } });
    } catch (error) {
      if (session !== mySession || read !== capabilityRead) return;
      const { kind } = toFailure(error);
      report(kind);
      patch({ capability: { status: 'failed', kind, message: COPY.errors[kind] } });
    }
  }

  function amountFromText(): bigint | null {
    const amount = parseTokenAmount(store.getState().amountText);
    return amount !== null && amount > 0n ? amount : null;
  }

  return Object.freeze<VaultPanel>({
    store,

    async open(signal?: AbortSignal): Promise<void> {
      session += 1;
      begin();
      discardPrepared();
      positionRead += 1;
      const mode = store.getState().mode;
      stateStore.setState(freezeVaultState(initialState(mode, register)));
      // A transaction that settled while the window was shut is still the
      // player's to see.
      const outstanding = receipts.pending('vault')[0];
      if (outstanding) {
        patch({ flow: { name: 'submitted', transactionHash: outstanding.transactionHash, outcome: 'pending', restored: true } });
      } else {
        patch({ flow: { name: 'composing' } });
      }
      await checkCapability(signal);
    },

    close(): void {
      session += 1;
      begin();
      discardPrepared();
      positionRead += 1;
      capabilityRead += 1;
    },

    recheck: (signal?: AbortSignal) => checkCapability(signal),

    setMode(mode: VaultMode): void {
      if (!ALL_VAULT_MODES.includes(mode)) return;
      const state = store.getState();
      if (state.flow.name === 'submitting' || state.mode === mode) return;
      begin();
      discardPrepared();
      const routeId = ROUTE_BY_VAULT_MODE[mode];
      patch({
        mode,
        routeId,
        door: routeDoor(routeId, register),
        disclosure: routeDisclosure(routeId, register),
        amountText: '',
        redeemAll: false,
        notice: null,
        flow: state.flow.name === 'submitted' ? state.flow : { name: 'composing' },
      });
    },

    setAmount(text: string): void {
      const state = store.getState();
      if (state.flow.name === 'submitting') return;
      if (state.flow.name === 'review' || state.flow.name === 'preparing') {
        begin();
        discardPrepared();
        patch({ amountText: text, flow: { name: 'composing' } });
        return;
      }
      patch({ amountText: text });
    },

    setRedeemAll(all: boolean): void {
      const state = store.getState();
      if (state.mode !== 'redeem' || state.flow.name === 'submitting') return;
      if (state.flow.name === 'review' || state.flow.name === 'preparing') {
        begin();
        discardPrepared();
        patch({ redeemAll: all, flow: { name: 'composing' } });
        return;
      }
      patch({ redeemAll: all });
    },

    async refreshPosition(signal?: AbortSignal): Promise<void> {
      const mySession = session;
      const read = ++positionRead;
      patch({ position: { status: 'loading' } });
      try {
        const position = await operations.vaultPosition({ signal, onStage: forwardStage });
        if (session !== mySession || read !== positionRead) return;
        patch({
          position: {
            status: 'loaded',
            shares: position.shares,
            assets: position.assets,
            redeemable: position.redeemable,
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

    async prepare(signal?: AbortSignal): Promise<void> {
      if (!gateOpen()) return;
      const state = store.getState();
      if (!state.door.open || state.capability.status !== 'supported') return;
      if (state.flow.name !== 'composing' && state.flow.name !== 'failed') return;
      const all = state.mode === 'redeem' && state.redeemAll;
      const amount = all ? null : amountFromText();
      if (!all && amount === null) {
        notice('error', COPY.notices.badAmount);
        return;
      }
      const id = begin();
      discardPrepared();
      debugVault({ step: 'prepare', kind: state.mode, all });
      patch({ flow: { name: 'preparing' }, notice: null });
      try {
        const batch = state.mode === 'supply'
          ? await operations.prepareVaultSupply(STRK_TOKEN, amount!, { signal, onStage: forwardStage })
          : await operations.prepareVaultRedeem(all ? 'all' : amount!, { signal, onStage: forwardStage });
        if (!current(id)) {
          try {
            batch.discard();
          } catch {
            // A batch nobody will confirm.
          }
          return;
        }
        prepared = batch;
        const routeId = ROUTE_BY_VAULT_MODE[batch.action.kind];
        const disclosure = routeDisclosure(routeId, register);
        patch({
          flow: {
            name: 'review',
            summary: {
              action: batch.action,
              poolFee: batch.poolFee,
              gasEstimate: batch.gasEstimate,
              totalCost: batch.totalCost,
              feeCeiling: batch.totalCost + feeTolerance,
              disclosures: disclosure ? [disclosure] : [],
              requiresDisclosure: routeRequiresDisclosure(routeId, register),
            },
          },
        });
      } catch (error) {
        fail(error, 'prepare-again', id);
      }
    },

    async confirm(signal?: AbortSignal): Promise<void> {
      if (!gateOpen()) return;
      const state = store.getState();
      const batch = prepared;
      if (state.flow.name !== 'review' || !batch) return;
      const { summary } = state.flow;
      const kind = summary.action.kind;
      // Leave `review` synchronously: a second click finds the flow moved on.
      const id = begin();
      let lastStage: VaultConfirmStage | null = null;
      const trace = (stage: VaultConfirmStage): void => {
        if (stage === lastStage) return;
        lastStage = stage;
        debugVault({ step: 'confirm', kind, stage });
      };
      patch({ flow: { name: 'submitting', stage: 'composing', message: COPY.flow.handingOver, summary } });
      trace('composing');

      // The live fee first, so a moved fee reads as that rather than as a
      // generic failure; the seam's own ceiling check still stands behind it.
      try {
        const pool = await operations.poolConfig(signal);
        if (!current(id)) return;
        if (!canStartFinancialAction()) {
          patch({ flow: { name: 'review', summary } });
          notice('error', COPY.errors['submission-uncertain']);
          trace('gate-closed');
          return;
        }
        if (pool.feeAmount + summary.gasEstimate > summary.feeCeiling) {
          discardPrepared();
          patch({ flow: { name: 'failed', kind: 'unknown', message: COPY.notices.feeMoved, recovery: 'prepare-again' } });
          trace('fee-moved');
          return;
        }
      } catch (error) {
        fail(error, 'prepare-again', id);
        if (current(id)) trace('failed');
        return;
      }

      signingBatch = batch;
      const record = (transactionHash: string): void => {
        // First, and whether or not this window is still open: the hash is
        // the player's only proof, and the ledger ignores a repeat.
        receipts.record({ building: 'vault', transactionHash, intents: [] });
      };
      try {
        const result = await batch.confirm({
          feeCeiling: summary.feeCeiling,
          signal,
          onStage: forwardStage,
          onSubmitted: ({ transactionHash }) => record(transactionHash),
          onProgress: ({ stage }) => {
            if (!current(id)) return;
            trace(stage);
            patch({ flow: { name: 'submitting', stage, message: stageCopy(stage), summary } });
          },
        });
        if (signingBatch === batch) signingBatch = null;
        record(result.transactionHash);
        if (prepared === batch) prepared = null;
        // Any read in flight predates this transaction.
        positionRead += 1;
        if (!current(id)) return;
        patch({
          flow: { name: 'submitted', transactionHash: result.transactionHash, outcome: result.outcome },
          position: { status: 'unrequested' },
          notice: result.outcome === 'reverted' ? null : { tone: 'info', text: COPY.vault.position.changed },
          amountText: '',
          redeemAll: false,
        });
        trace('submitted');
      } catch (error) {
        if (signingBatch === batch) signingBatch = null;
        fail(error, 'prepare-again', id);
        if (current(id)) trace('failed');
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

function initialState(mode: VaultMode, register: readonly RouteGrade[]): VaultState {
  const routeId = ROUTE_BY_VAULT_MODE[mode];
  return {
    mode,
    routeId,
    door: routeDoor(routeId, register),
    disclosure: routeDisclosure(routeId, register),
    capability: { status: 'checking' },
    position: { status: 'unrequested' },
    amountText: '',
    redeemAll: false,
    notice: null,
    flow: { name: 'idle' },
  };
}

function freezeVaultState(state: VaultState): VaultState {
  const flow = state.flow.name === 'review' || state.flow.name === 'submitting'
    ? Object.freeze({
        ...state.flow,
        summary: Object.freeze({
          ...state.flow.summary,
          action: Object.freeze({ ...state.flow.summary.action }) as VaultAction,
          disclosures: Object.freeze([...state.flow.summary.disclosures]),
        }),
      })
    : Object.freeze({ ...state.flow });
  return Object.freeze({
    ...state,
    door: Object.freeze({ ...state.door }),
    capability: Object.freeze({ ...state.capability }) as VaultCapabilityView,
    position: Object.freeze({ ...state.position }) as VaultPositionView,
    notice: state.notice === null ? null : Object.freeze({ ...state.notice }),
    flow,
  });
}
