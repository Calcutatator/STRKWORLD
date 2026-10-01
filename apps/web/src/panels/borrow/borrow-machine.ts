import type {
  Address,
  BorrowAction,
  BorrowHealth,
  BorrowMarket,
  BorrowPosition,
  BorrowRefusal,
  BorrowRequest,
  OperationStage,
  PreparedBorrowBatch,
  PrivacyErrorKind,
  PrivacyOperations,
  VaultOutcome,
  VaultStage,
  WalletRoutePolicy,
} from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { debugVault, type VaultDebugKind } from '../../debug/debug-tap.js';
import { parseTokenAmount, sameAddress } from '../../format.js';
import { BORROW_TOKENS, detectRoutePolicy } from '../../production/config.js';
import { VAULT_MARKET_METADATA } from '../../production/vesu-markets.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import { toFailure, type ShellFailure } from '../../privacy/errors.js';
import type { ReceiptLedger } from '../../receipts/receipt-ledger.js';
import { createStore, type ReadableStore } from '../../store/store.js';
import { VAULT_BORROW_ROUTE, routeDisclosure, routeDoor, routeRequiresDisclosure, type DoorState } from '../routes.js';
import { stageCopy } from '../bank/bank-machine.js';

/**
 * The Borrow counter, as a state machine (D-083): Vesu loans in its Prime
 * pool from the player's second STRK20 shadow account, at a counter in the
 * Vault's room. Built on the Vault's machine (`vault-machine.ts`) and its
 * rules, with a pair instead of a token:
 *
 * - **Nothing is read on its own that could prompt.** Opening the counter
 *   asks the wallet which API it speaks (no prompt) and reads Vesu's pool
 *   through the backend (public, names nobody). The loans are read only when
 *   the player asks: the wallet derives a commitment for them first.
 * - **The seam owns the protocol and the maths.** This machine names a mode,
 *   a pair, amounts and "everything"; the seam reads, assesses every action
 *   against Vesu's own rules on fresh reads, and refuses before the wallet is
 *   asked anything (D-018). A refusal says which rule in plain words and is
 *   not a failure: nothing was asked of anyone.
 * - **Health is Vesu's.** LTV, health and liquidation price come from the
 *   seam with each loan and with each prepared batch; a stale price shows no
 *   figure. A loan near liquidation, or past it, says so plainly.
 * - **The stand-in address stays in memory**, never stored, logged or sent.
 * - **The approved disclosure is on screen**, previewed while composing and
 *   at the commit point (D-020, D-024).
 * - **Every submission is an attempt with an identity**, as in the Vault:
 *   one confirm at a time, a late answer never overwrites a newer surface,
 *   and the hash is recorded first, for this counter (`counter: 'borrow'`).
 * - **The probe log sees codes only** (D-069): stages, kinds and steps.
 */

export type BorrowMode = 'borrow' | 'add-collateral' | 'repay' | 'withdraw-collateral';
export const BORROW_MODES: readonly BorrowMode[] = Object.freeze(['borrow', 'add-collateral', 'repay', 'withdraw-collateral']);

/** A confirm stage as the probe log names it. */
export type BorrowConfirmStage = OperationStage | 'submitted' | 'fee-moved' | 'gate-closed';

/** A pinned token the counter offers, with its display metadata. */
export interface BorrowTokenView {
  readonly token: Address;
  readonly symbol: string;
  readonly decimals: number;
}

/**
 * The tokens the counter offers (D-083): this build's borrow list, in its
 * order, keeping only pinned borrow tokens, described by the pinned market
 * metadata. With no policy (the demo, tests) every pinned borrow token.
 */
export function borrowTokenChoices(policy: WalletRoutePolicy | null): readonly BorrowTokenView[] {
  let listed: readonly unknown[];
  try {
    const allowlist = policy === null ? BORROW_TOKENS : policy.allowedTokens.borrow;
    listed = Array.isArray(allowlist) ? [...allowlist] : [];
  } catch {
    return Object.freeze([]);
  }
  const offered: BorrowTokenView[] = [];
  for (const token of listed) {
    if (typeof token !== 'string' || !BORROW_TOKENS.some((pinned) => sameAddress(pinned, token))) continue;
    const market = VAULT_MARKET_METADATA.find((entry) => sameAddress(entry.token, token));
    if (!market || offered.some((entry) => sameAddress(entry.token, market.token))) continue;
    offered.push(Object.freeze({ token: market.token, symbol: market.symbol, decimals: market.decimals }));
  }
  return Object.freeze(offered);
}

/** A pair, by its two tokens. */
export interface BorrowPairChoice {
  readonly collateral: Address;
  readonly debt: Address;
}

export type BorrowCapabilityView =
  | { readonly status: 'checking' }
  | { readonly status: 'supported' }
  | { readonly status: 'unsupported' }
  | { readonly status: 'failed'; readonly kind: PrivacyErrorKind; readonly message: string };

export type BorrowMarketView =
  | { readonly status: 'unrequested' }
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly market: BorrowMarket }
  | { readonly status: 'failed' };

export type BorrowLoansView =
  | { readonly status: 'unrequested' }
  | { readonly status: 'loading' }
  | {
      readonly status: 'loaded';
      /** Public on-chain; held for the counter's line and link, never stored. */
      readonly standIn: Address;
      readonly positions: readonly BorrowPosition[];
    }
  | { readonly status: 'failed'; readonly kind: PrivacyErrorKind; readonly message: string };

/** What the player agrees to, from the prepared batch. */
export interface BorrowSummary {
  readonly action: BorrowAction;
  readonly collateral: BorrowTokenView;
  readonly debt: BorrowTokenView;
  /** The loan once this runs, by the seam's fresh reads. */
  readonly after: BorrowHealth;
  readonly poolFee: bigint;
  readonly gasEstimate: bigint;
  readonly totalCost: bigint;
  readonly feeCeiling: bigint;
  readonly disclosures: readonly string[];
  readonly requiresDisclosure: boolean;
}

export type BorrowFlow =
  | { readonly name: 'idle' }
  | { readonly name: 'composing' }
  | { readonly name: 'preparing' }
  | { readonly name: 'review'; readonly summary: BorrowSummary }
  | { readonly name: 'submitting'; readonly stage: OperationStage; readonly message: string; readonly summary: BorrowSummary }
  | {
      readonly name: 'submitted';
      readonly transactionHash: string;
      readonly outcome: VaultOutcome;
      readonly restored?: boolean;
    }
  | {
      readonly name: 'failed';
      readonly kind: PrivacyErrorKind;
      readonly message: string;
      readonly recovery: 'prepare-again' | 'close';
    };

export interface BorrowNotice {
  readonly tone: 'error' | 'info';
  readonly text: string;
}

export interface BorrowState {
  readonly mode: BorrowMode;
  readonly door: DoorState;
  /** The route's approved disclosure, previewed while composing. */
  readonly disclosure: string | null;
  readonly capability: BorrowCapabilityView;
  readonly tokens: readonly BorrowTokenView[];
  /** The chosen pair; null only when there is none to choose. */
  readonly pair: BorrowPairChoice | null;
  readonly market: BorrowMarketView;
  readonly loans: BorrowLoansView;
  /** Borrow mode only: collateral to add with the loan; empty for none. */
  readonly collateralText: string;
  /** The amount to borrow, add, repay or withdraw. */
  readonly amountText: string;
  /** Repay or withdraw everything. */
  readonly all: boolean;
  readonly notice: BorrowNotice | null;
  readonly flow: BorrowFlow;
}

export interface BorrowPanelOptions {
  operations: PrivacyOperations;
  receipts: ReceiptLedger;
  canStartFinancialAction: () => boolean;
  onError?: (failure: ShellFailure) => void;
  register?: readonly RouteGrade[];
  feeTolerance?: bigint;
  tokens?: readonly BorrowTokenView[];
}

export interface BorrowPanel {
  readonly store: ReadableStore<BorrowState>;
  open(signal?: AbortSignal): Promise<void>;
  close(): void;
  recheck(signal?: AbortSignal): Promise<void>;
  /** Read Vesu's pool again: public, no prompt. */
  refreshMarket(signal?: AbortSignal): Promise<void>;
  /** Read the loans, and the pool with them. The wallet may ask first. */
  refreshLoans(signal?: AbortSignal): Promise<void>;
  setMode(mode: BorrowMode): void;
  /** Choose a pair the mode offers: an offered pair to borrow in, or a held loan. */
  setPair(collateral: Address, debt: Address): void;
  setCollateralAmount(text: string): void;
  setAmount(text: string): void;
  setAll(all: boolean): void;
  prepare(signal?: AbortSignal): Promise<void>;
  confirm(signal?: AbortSignal): Promise<void>;
  cancelPrepared(): void;
  acknowledge(): void;
}

/**
 * The pairs a mode offers (D-083): to borrow, every pair Vesu offers now
 * whose tokens this build admits; to change a loan, every pair the last read
 * found a loan in.
 */
export function borrowPairChoices(state: Pick<BorrowState, 'mode' | 'tokens' | 'market' | 'loans'>, mode: BorrowMode = state.mode): readonly BorrowPairChoice[] {
  const admitted = (token: Address) => state.tokens.some((entry) => sameAddress(entry.token, token));
  if (mode === 'borrow') {
    if (state.market.status !== 'loaded') return [];
    return state.market.market.pairs
      .filter((pair) => admitted(pair.collateral) && admitted(pair.debt))
      .map((pair) => ({ collateral: pair.collateral, debt: pair.debt }));
  }
  if (state.loans.status !== 'loaded') return [];
  return state.loans.positions
    .filter((loan) => admitted(loan.collateral) && admitted(loan.debt))
    .filter((loan) => mode !== 'repay' || loan.nominalDebt > 0n)
    .filter((loan) => mode !== 'withdraw-collateral' || loan.collateralShares > 0n)
    .map((loan) => ({ collateral: loan.collateral, debt: loan.debt }));
}

/** The loan the last read found in a pair, if any. */
export function loanFor(state: Pick<BorrowState, 'loans'>, pair: BorrowPairChoice | null): BorrowPosition | undefined {
  if (pair === null || state.loans.status !== 'loaded') return undefined;
  return state.loans.positions.find((loan) => sameAddress(loan.collateral, pair.collateral) && sameAddress(loan.debt, pair.debt));
}

/** The pair's max LTV as Vesu offers it now, if it does. */
export function maxLtvFor(state: Pick<BorrowState, 'market'>, pair: BorrowPairChoice | null): bigint | undefined {
  if (pair === null || state.market.status !== 'loaded') return undefined;
  return state.market.market.pairs.find((entry) => sameAddress(entry.collateral, pair.collateral) && sameAddress(entry.debt, pair.debt))?.maxLtv;
}

/**
 * Whether a typed repay or withdrawal is the whole of it, as Max fills it in
 * (D-089): the debt as last read for a repay, which becomes a repay-all (the
 * seam's buffer covers interest since); for a withdrawal, the whole
 * collateral of a loan that owes nothing, which becomes a withdraw-all.
 */
export function takesEverything(state: Pick<BorrowState, 'mode' | 'loans'>, pair: BorrowPairChoice | null, amount: bigint | null): boolean {
  const loan = loanFor(state, pair);
  if (amount === null || loan === undefined) return false;
  if (state.mode === 'repay') return loan.nominalDebt > 0n && amount === loan.debtAmount;
  if (state.mode === 'withdraw-collateral') return loan.nominalDebt === 0n && loan.collateralShares > 0n && amount === loan.collateralAmount;
  return false;
}

/** A refusal the seam named (`BorrowRefusedError`), read without trusting anything else about the error. */
export function refusalOf(error: unknown): BorrowRefusal | null {
  if (!error || typeof error !== 'object') return null;
  let value: unknown;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'refusal');
    value = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return null;
  }
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(COPY.borrow.refusals, value) ? (value as BorrowRefusal) : null;
}

export function createBorrowPanel(options: BorrowPanelOptions): BorrowPanel {
  const { operations, receipts, onError } = options;
  const canStartFinancialAction = options.canStartFinancialAction ?? (() => false);
  const register = options.register ?? PRIVACY_REGISTER;
  const feeTolerance = options.feeTolerance ?? 0n;
  const tokens = Object.freeze((options.tokens ?? borrowTokenChoices(detectRoutePolicy())).map((entry) => Object.freeze({ ...entry })));

  const stateStore = createStore<BorrowState>(freezeBorrowState(initialState(register, tokens)));
  const store: ReadableStore<BorrowState> = Object.freeze({
    getState: stateStore.getState,
    getServerSnapshot: stateStore.getServerSnapshot,
    subscribe: stateStore.subscribe,
  });
  let prepared: PreparedBorrowBatch | null = null;
  let signingBatch: PreparedBorrowBatch | null = null;
  let attempt = 0;
  let session = 0;
  let loansRead = 0;
  let marketRead = 0;
  let capabilityRead = 0;
  const begin = (): number => (attempt += 1);
  const current = (id: number): boolean => attempt === id;

  function patch(next: Partial<BorrowState>): void {
    stateStore.setState((previous) => freezeBorrowState({ ...previous, ...next }));
  }

  function notice(tone: BorrowNotice['tone'], text: string): void {
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

  function forwardStage(stage: VaultStage): void {
    debugVault({ step: 'stage', stage });
  }

  function tokenView(token: Address): BorrowTokenView | undefined {
    return tokens.find((entry) => sameAddress(entry.token, token));
  }

  /** The chosen pair if the mode still offers it, else the mode's first choice. */
  function pairFor(state: Pick<BorrowState, 'mode' | 'tokens' | 'market' | 'loans'>, pair: BorrowPairChoice | null): BorrowPairChoice | null {
    const choices = borrowPairChoices(state);
    const kept = pair === null ? undefined : choices.find((entry) => sameAddress(entry.collateral, pair.collateral) && sameAddress(entry.debt, pair.debt));
    return kept ?? choices[0] ?? null;
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

  /** Vesu's pool: public, through the backend, no prompt. A failure says nothing about the player. */
  async function loadMarket(signal?: AbortSignal): Promise<void> {
    const mySession = session;
    const read = ++marketRead;
    patch({ market: { status: 'loading' } });
    try {
      const market = await operations.borrowMarket(signal);
      if (session !== mySession || read !== marketRead) return;
      const latest = store.getState();
      const next = { ...latest, market: { status: 'loaded' as const, market } };
      const settled = latest.flow.name !== 'preparing' && latest.flow.name !== 'review' && latest.flow.name !== 'submitting';
      patch({ market: next.market, ...(settled ? { pair: pairFor(next, latest.pair) } : {}) });
    } catch {
      if (session !== mySession || read !== marketRead) return;
      patch({ market: { status: 'failed' } });
    }
  }

  async function loadMarketIfOpen(signal?: AbortSignal): Promise<void> {
    const state = store.getState();
    if (state.door.open && state.capability.status === 'supported' && tokens.length > 1) await loadMarket(signal);
  }

  function amountIn(text: string, decimals: number): bigint | null {
    const amount = parseTokenAmount(text, decimals);
    return amount !== null && amount > 0n ? amount : null;
  }

  /** The request the form says, or the notice why it says none. */
  function requestFrom(state: BorrowState, pair: BorrowPairChoice): BorrowRequest | string {
    const collateral = tokenView(pair.collateral)!;
    const debt = tokenView(pair.debt)!;
    switch (state.mode) {
      case 'borrow': {
        const collateralAmount = state.collateralText.trim() === '' ? 0n : amountIn(state.collateralText, collateral.decimals);
        const borrowAmount = amountIn(state.amountText, debt.decimals);
        if (collateralAmount === null || borrowAmount === null) return COPY.notices.badAmount;
        return { kind: 'borrow', collateral: pair.collateral, debt: pair.debt, collateralAmount, borrowAmount };
      }
      case 'add-collateral': {
        const amount = amountIn(state.amountText, collateral.decimals);
        if (amount === null) return COPY.notices.badAmount;
        return { kind: 'add-collateral', collateral: pair.collateral, debt: pair.debt, amount };
      }
      case 'repay': {
        // D-089: Max fills the whole debt as read, which repays everything.
        const typed = state.all ? null : amountIn(state.amountText, debt.decimals);
        const amount = state.all || takesEverything(state, pair, typed) ? 'all' : typed;
        if (amount === null) return COPY.notices.badAmount;
        return { kind: 'repay', collateral: pair.collateral, debt: pair.debt, amount };
      }
      case 'withdraw-collateral': {
        // D-089: with nothing owed, Max fills the whole collateral, which withdraws everything.
        const typed = state.all ? null : amountIn(state.amountText, collateral.decimals);
        const amount = state.all || takesEverything(state, pair, typed) ? 'all' : typed;
        if (amount === null) return COPY.notices.badAmount;
        return { kind: 'withdraw-collateral', collateral: pair.collateral, debt: pair.debt, amount };
      }
    }
  }

  function composing(state: BorrowState): BorrowFlow {
    return state.flow.name === 'submitted' ? state.flow : { name: 'composing' };
  }

  return Object.freeze<BorrowPanel>({
    store,

    async open(signal?: AbortSignal): Promise<void> {
      session += 1;
      const mySession = session;
      begin();
      discardPrepared();
      loansRead += 1;
      marketRead += 1;
      const { mode } = store.getState();
      stateStore.setState(freezeBorrowState({ ...initialState(register, tokens), mode }));
      const outstanding = receipts.pending('vault').find((receipt) => receipt.counter === 'borrow');
      patch({
        flow: outstanding
          ? { name: 'submitted', transactionHash: outstanding.transactionHash, outcome: 'pending', restored: true }
          : { name: 'composing' },
      });
      await checkCapability(signal);
      if (session !== mySession) return;
      await loadMarketIfOpen(signal);
    },

    close(): void {
      session += 1;
      begin();
      discardPrepared();
      loansRead += 1;
      marketRead += 1;
      capabilityRead += 1;
    },

    async recheck(signal?: AbortSignal): Promise<void> {
      const mySession = session;
      await checkCapability(signal);
      if (session !== mySession || store.getState().market.status === 'loaded') return;
      await loadMarketIfOpen(signal);
    },

    async refreshMarket(signal?: AbortSignal): Promise<void> {
      await loadMarketIfOpen(signal);
    },

    async refreshLoans(signal?: AbortSignal): Promise<void> {
      const mySession = session;
      const read = ++loansRead;
      patch({ loans: { status: 'loading' } });
      const market = loadMarket(signal);
      try {
        const answer = await operations.borrowPositions({ signal, onStage: forwardStage });
        if (session !== mySession || read !== loansRead) return;
        const latest = store.getState();
        const loans: BorrowLoansView = { status: 'loaded', standIn: answer.standIn, positions: answer.positions };
        const settled = latest.flow.name !== 'preparing' && latest.flow.name !== 'review' && latest.flow.name !== 'submitting';
        patch({ loans, ...(settled ? { pair: pairFor({ ...latest, loans }, latest.pair) } : {}) });
      } catch (error) {
        if (session !== mySession || read !== loansRead) return;
        const { kind } = toFailure(error);
        report(kind);
        patch({
          loans: { status: 'failed', kind, message: COPY.errors[kind] },
          ...(kind === 'shadow-accounts-unsupported' ? { capability: { status: 'unsupported' } as const } : {}),
        });
      }
      await market;
    },

    setMode(mode: BorrowMode): void {
      if (!BORROW_MODES.includes(mode)) return;
      const state = store.getState();
      if (state.flow.name === 'submitting' || state.mode === mode) return;
      begin();
      discardPrepared();
      const next = { ...state, mode };
      patch({
        mode,
        pair: pairFor(next, state.pair),
        collateralText: '',
        amountText: '',
        all: false,
        notice: null,
        flow: composing(state),
      });
    },

    setPair(collateral: Address, debt: Address): void {
      const state = store.getState();
      if (state.flow.name === 'submitting' || typeof collateral !== 'string' || typeof debt !== 'string') return;
      const choice = borrowPairChoices(state).find((entry) => sameAddress(entry.collateral, collateral) && sameAddress(entry.debt, debt));
      if (!choice) return;
      if (state.pair && sameAddress(state.pair.collateral, choice.collateral) && sameAddress(state.pair.debt, choice.debt)) return;
      begin();
      discardPrepared();
      patch({ pair: choice, collateralText: '', amountText: '', all: false, notice: null, flow: composing(state) });
    },

    setCollateralAmount(text: string): void {
      const state = store.getState();
      if (state.flow.name === 'submitting' || state.mode !== 'borrow') return;
      if (state.flow.name === 'review' || state.flow.name === 'preparing') {
        begin();
        discardPrepared();
        patch({ collateralText: text, flow: { name: 'composing' } });
        return;
      }
      patch({ collateralText: text });
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

    setAll(all: boolean): void {
      const state = store.getState();
      if ((state.mode !== 'repay' && state.mode !== 'withdraw-collateral') || state.flow.name === 'submitting') return;
      if (state.flow.name === 'review' || state.flow.name === 'preparing') {
        begin();
        discardPrepared();
        patch({ all, flow: { name: 'composing' } });
        return;
      }
      patch({ all });
    },

    async prepare(signal?: AbortSignal): Promise<void> {
      if (!gateOpen()) return;
      const state = store.getState();
      if (!state.door.open || state.capability.status !== 'supported') return;
      if (state.flow.name !== 'composing' && state.flow.name !== 'failed') return;
      const pair = state.pair;
      const collateral = pair ? tokenView(pair.collateral) : undefined;
      const debt = pair ? tokenView(pair.debt) : undefined;
      if (!pair || !collateral || !debt) return;
      const request = requestFrom(state, pair);
      if (typeof request === 'string') {
        notice('error', request);
        return;
      }
      const id = begin();
      discardPrepared();
      const all = (request.kind === 'repay' || request.kind === 'withdraw-collateral') && request.amount === 'all';
      debugVault({ step: 'prepare', kind: request.kind satisfies VaultDebugKind, all });
      patch({ flow: { name: 'preparing' }, notice: null });
      try {
        const batch = await operations.prepareBorrow(request, { signal, onStage: forwardStage });
        if (!current(id)) {
          try {
            batch.discard();
          } catch {
            // A batch nobody will confirm.
          }
          return;
        }
        // The review names the pair the seam prepared, which must be the one chosen.
        if (!sameAddress(batch.action.collateral, pair.collateral) || !sameAddress(batch.action.debt, pair.debt) || batch.action.kind !== request.kind) {
          try {
            batch.discard();
          } catch {
            // A batch nobody will confirm.
          }
          throw new Error('The borrow counter prepared another action than the one chosen.');
        }
        prepared = batch;
        const disclosure = routeDisclosure(VAULT_BORROW_ROUTE, register);
        patch({
          flow: {
            name: 'review',
            summary: {
              action: batch.action,
              collateral,
              debt,
              after: batch.after,
              poolFee: batch.poolFee,
              gasEstimate: batch.gasEstimate,
              totalCost: batch.totalCost,
              feeCeiling: batch.totalCost + feeTolerance,
              disclosures: disclosure ? [disclosure] : [],
              requiresDisclosure: routeRequiresDisclosure(VAULT_BORROW_ROUTE, register),
            },
          },
        });
      } catch (error) {
        // A refusal before any prompt is the counter speaking, not a failure:
        // nothing was asked of the wallet, and nothing is reported.
        const refusal = refusalOf(error);
        if (refusal !== null) {
          if (!current(id)) return;
          patch({ flow: { name: 'composing' }, notice: { tone: 'error', text: COPY.borrow.refusals[refusal] } });
          return;
        }
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
      const id = begin();
      let lastStage: BorrowConfirmStage | null = null;
      const trace = (stage: BorrowConfirmStage): void => {
        if (stage === lastStage) return;
        lastStage = stage;
        debugVault({ step: 'confirm', kind, stage });
      };
      patch({ flow: { name: 'submitting', stage: 'composing', message: COPY.flow.handingOver, summary } });
      trace('composing');

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
        receipts.record({ building: 'vault', counter: 'borrow', transactionHash, intents: [] });
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
        loansRead += 1;
        if (!current(id)) return;
        patch({
          flow: { name: 'submitted', transactionHash: result.transactionHash, outcome: result.outcome },
          loans: { status: 'unrequested' },
          notice: result.outcome === 'reverted' ? null : { tone: 'info', text: COPY.borrow.loans.changed },
          collateralText: '',
          amountText: '',
          all: false,
        });
        trace('submitted');
      } catch (error) {
        if (signingBatch === batch) signingBatch = null;
        // A refusal at confirm (a review past its two minutes) asked the wallet
        // nothing: say so and offer a fresh review, without reporting a failure.
        const refusal = refusalOf(error);
        if (refusal !== null) {
          if (!current(id)) return;
          discardPrepared();
          patch({ flow: { name: 'failed', kind: 'unknown', message: COPY.borrow.refusals[refusal], recovery: 'prepare-again' } });
          trace('failed');
          return;
        }
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
      const state = store.getState();
      patch({ flow: { name: 'composing' }, notice: null, pair: pairFor(state, state.pair) });
    },
  });
}

function initialState(register: readonly RouteGrade[], tokens: readonly BorrowTokenView[]): BorrowState {
  return {
    mode: 'borrow',
    door: routeDoor(VAULT_BORROW_ROUTE, register),
    disclosure: routeDisclosure(VAULT_BORROW_ROUTE, register),
    capability: { status: 'checking' },
    tokens,
    pair: null,
    market: { status: 'unrequested' },
    loans: { status: 'unrequested' },
    collateralText: '',
    amountText: '',
    all: false,
    notice: null,
    flow: { name: 'idle' },
  };
}

function freezeBorrowState(state: BorrowState): BorrowState {
  const flow = state.flow.name === 'review' || state.flow.name === 'submitting'
    ? Object.freeze({
        ...state.flow,
        summary: Object.freeze({
          ...state.flow.summary,
          action: Object.freeze({ ...state.flow.summary.action }) as BorrowAction,
          after: Object.freeze({ ...state.flow.summary.after }),
          collateral: Object.freeze({ ...state.flow.summary.collateral }),
          debt: Object.freeze({ ...state.flow.summary.debt }),
          disclosures: Object.freeze([...state.flow.summary.disclosures]),
        }),
      })
    : Object.freeze({ ...state.flow });
  return Object.freeze({
    ...state,
    door: Object.freeze({ ...state.door }),
    capability: Object.freeze({ ...state.capability }) as BorrowCapabilityView,
    tokens: Object.isFrozen(state.tokens) ? state.tokens : Object.freeze([...state.tokens]),
    pair: state.pair === null ? null : Object.freeze({ collateral: state.pair.collateral, debt: state.pair.debt }),
    market: Object.freeze({ ...state.market }) as BorrowMarketView,
    loans: state.loans.status === 'loaded'
      ? Object.freeze({ ...state.loans, positions: Object.freeze([...state.loans.positions]) })
      : Object.freeze({ ...state.loans }) as BorrowLoansView,
    notice: state.notice === null ? null : Object.freeze({ ...state.notice }),
    flow,
  });
}
