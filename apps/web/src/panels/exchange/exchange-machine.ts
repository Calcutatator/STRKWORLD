import type { Intent, OperationStage, PreparedBatch, PrivacyErrorKind, PrivacyOperations } from '@strkworld/privacy';
import type { ReceiptLedger } from '../../receipts/receipt-ledger.js';
import { createStore, type Store } from '../../store/store.js';
import { formatTokenAmountExact, parseTokenAmount, sameAddress } from '../../format.js';
import { COPY } from '../../copy.js';
import { toFailure, type ShellFailure } from '../../privacy/errors.js';
import { disclosuresForIntents, routeDoor, type DoorState } from '../routes.js';
import { PRIVACY_REGISTER } from '../../privacy/register.js';
import type { RouteGrade } from '../../privacy/register.js';
import { catalogAsset, EXCHANGE_CATALOG, type ExchangeAsset } from './catalog.js';

export interface ExchangeReview {
  sell: string;
  expectedBuy: string;
  protectedMinimum: string;
  slippage: string;
  expiresAt: string;
  poolFee: string;
  networkCost: string;
  total: string;
  disclosures: readonly string[];
}

export type ExchangeFlow =
  | { name: 'idle' | 'loading-pool' | 'composing' | 'preparing' }
  | { name: 'review'; summary: ExchangeReview }
  | { name: 'submitting'; stage: OperationStage; message: string; summary: ExchangeReview }
  | { name: 'submitted'; transactionHash: string }
  | { name: 'failed'; kind: PrivacyErrorKind; message: string; recovery: 'prepare-again' | 'close' };

export interface ExchangeState {
  door: DoorState;
  balances: 'unrequested' | 'loading' | 'loaded' | 'failed';
  sellChoices: readonly ExchangeAsset[];
  sell: ExchangeAsset | null;
  buy: ExchangeAsset | null;
  amountText: string;
  notice: string | null;
  flow: ExchangeFlow;
}

export interface ExchangePanel {
  readonly store: Store<ExchangeState>;
  open(signal?: AbortSignal): Promise<void>;
  close(): void;
  refreshBalances(signal?: AbortSignal): Promise<void>;
  setSell(token: string): void;
  setBuy(token: string): void;
  setAmount(text: string): void;
  prepare(signal?: AbortSignal): Promise<void>;
  confirm(signal?: AbortSignal): Promise<void>;
  cancelPrepared(): void;
  acknowledge(): void;
}

export function createExchangePanel(options: {
  operations: PrivacyOperations;
  receipts: ReceiptLedger;
  canStartFinancialAction: () => boolean;
  onError?: (failure: ShellFailure) => void;
  feeTolerance?: bigint;
  now?: () => number;
  register?: readonly RouteGrade[];
}): ExchangePanel {
  const { operations, receipts, onError } = options;
  const feeTolerance = options.feeTolerance ?? 0n;
  const now = options.now ?? Date.now;
  const register = options.register ?? PRIVACY_REGISTER;
  const store = createStore<ExchangeState>(initialState(register));
  let prepared: PreparedBatch | null = null;
  let signingOwner: number | null = null;
  let signingBatch: PreparedBatch | null = null;
  let attempt = 0;
  let session = 0;
  let balanceRead = 0;
  const patch = (next: Partial<ExchangeState>) => store.setState((state) => ({ ...state, ...next }));
  const start = () => ++attempt;
  const live = (id: number) => attempt === id;
  const editComposition = (next: Partial<ExchangeState>) => {
    if (store.getState().flow.name === 'preparing') {
      start();
      patch({ ...next, flow: { name: 'composing' } });
      return;
    }
    if (store.getState().flow.name === 'review') {
      start();
      discard();
      patch({ ...next, flow: { name: 'composing' } });
      return;
    }
    patch(next);
  };
  const stageCopy = (stage: OperationStage) => ({ composing: COPY.flow.handingOver, 'awaiting-approval': COPY.flow.awaitingApproval, proving: COPY.flow.proving, submitting: COPY.flow.submitting, confirming: COPY.flow.confirming, done: COPY.flow.done, failed: COPY.errors.unknown }[stage]);
  const discard = () => {
    // A batch the wallet is already signing is not ours to release. The
    // owner token and batch identity matter because a stale confirmation may
    // settle after a newer batch has been prepared or entered the handoff.
    if (prepared !== null && prepared === signingBatch) {
      prepared = null;
      return;
    }
    prepared?.discard();
    prepared = null;
  };
  const gate = () => {
    if (options.canStartFinancialAction()) return true;
    patch({ notice: COPY.errors['submission-uncertain'] });
    return false;
  };
  const fail = (error: unknown, id: number, recovery: 'prepare-again' | 'close' = 'prepare-again') => {
    const failure = toFailure(error);
    if (failure.kind === 'submission-uncertain') onError?.(failure);
    if (!live(id)) return;
    if (failure.kind !== 'submission-uncertain') onError?.(failure);
    discard();
    patch({ flow: { name: 'failed', kind: failure.kind, message: COPY.errors[failure.kind], recovery: failure.kind === 'submission-uncertain' ? 'close' : recovery } });
  };

  return {
    store,
    async open(signal) {
      const id = start(); patch({ flow: { name: 'loading-pool' } });
      try {
        await operations.poolConfig(signal);
        if (!live(id)) return;
        const receipt = receipts.pending('exchange')[0];
        patch({ flow: receipt ? { name: 'submitted', transactionHash: receipt.transactionHash } : { name: 'composing' } });
      } catch (error) { fail(error, id, 'close'); }
    },
    close() { start(); ++session; ++balanceRead; discard(); store.setState(initialState(register)); },
    async refreshBalances(signal) {
      const id = ++balanceRead; const currentSession = session;
      patch({ balances: 'loading', notice: null });
      try {
        const balances = await operations.balances(EXCHANGE_CATALOG.map((asset) => asset.token), signal);
        if (id !== balanceRead || currentSession !== session) return;
        const sellChoices = EXCHANGE_CATALOG.filter((asset) => (balances.find((b) => sameAddress(b.token, asset.token))?.total ?? 0n) > 0n);
        const sell = sellChoices[0] ?? null;
        const buy = EXCHANGE_CATALOG.find((asset) => sell && !sameAddress(asset.token, sell.token)) ?? null;
        patch({ balances: 'loaded', sellChoices, sell, buy });
      } catch (error) {
        if (id !== balanceRead || currentSession !== session) return;
        const failure = toFailure(error); onError?.(failure); patch({ balances: 'failed', notice: COPY.errors[failure.kind] });
      }
    },
    setSell(token) {
      const sell = store.getState().sellChoices.find((asset) => sameAddress(asset.token, token)) ?? null;
      const buy = EXCHANGE_CATALOG.find((asset) => sell && !sameAddress(asset.token, sell.token)) ?? null;
      editComposition({ sell, buy, amountText: '', notice: null });
    },
    setBuy(token) {
      const asset = catalogAsset(token); const sell = store.getState().sell;
      if (!asset || !sell || sameAddress(asset.token, sell.token)) return;
      editComposition({ buy: asset, notice: null });
    },
    setAmount(amountText) { editComposition({ amountText, notice: null }); },
    async prepare(signal) {
      if (!gate()) return;
      const state = store.getState();
      if (!state.door.open || !state.sell || !state.buy || sameAddress(state.sell.token, state.buy.token)) { patch({ notice: state.door.message || COPY.locked.unknownRoute }); return; }
      const amountIn = parseTokenAmount(state.amountText, state.sell.decimals);
      if (amountIn === null || amountIn <= 0n) { patch({ notice: COPY.notices.badAmount }); return; }
      const id = start(); discard(); patch({ flow: { name: 'preparing' }, notice: null });
      try {
        // 1 is a request sentinel only. It never reaches the player-facing review.
        const batch = await operations.prepare([{ kind: 'swap', tokenIn: state.sell.token, tokenOut: state.buy.token, amountIn, minAmountOut: 1n }], signal);
        if (!live(id)) { batch.discard(); return; }
        const intent = batch.intents.length === 1 ? batch.intents[0] : undefined;
        const review = batch.swapReview;
        if (!validReview(intent, review, state.sell, state.buy, amountIn, now())) {
          batch.discard();
          patch({ flow: { name: 'failed', kind: 'unknown', message: COPY.errors.unknown, recovery: 'prepare-again' } });
          return;
        }
        const safeReview = review!;
        prepared = batch;
        const fee = (amount: bigint) => formatTokenAmountExact(amount, 18) + ' STRK';
        const summary: ExchangeReview = {
          sell: `${formatTokenAmountExact(intent.amountIn, state.sell.decimals)} ${state.sell.symbol}`,
          expectedBuy: `${formatTokenAmountExact(safeReview.expectedAmountOut, state.buy.decimals)} ${state.buy.symbol}`,
          protectedMinimum: `${formatTokenAmountExact(safeReview.minimumAmountOut, state.buy.decimals)} ${state.buy.symbol}`,
          slippage: `${(safeReview.slippageBps / 100).toFixed(2)}%`,
          expiresAt: new Date(safeReview.expiresAt).toISOString(),
          poolFee: fee(batch.poolFee), networkCost: fee(batch.gasEstimate), total: fee(batch.totalCost),
          disclosures: disclosuresForIntents(batch.intents, PRIVACY_REGISTER),
        };
        patch({ flow: { name: 'review', summary } });
      } catch (error) { fail(error, id); }
    },
    async confirm(signal) {
      if (!gate()) return;
      const state = store.getState(); const batch = prepared;
      if (state.flow.name !== 'review' || !batch) return;
      const id = start(); const summary = state.flow.summary;
      if (!batch.swapReview || !Number.isSafeInteger(batch.swapReview.expiresAt) || batch.swapReview.expiresAt <= now()) {
        discard(); patch({ flow: { name: 'failed', kind: 'unknown', message: COPY.errors.unknown, recovery: 'prepare-again' } }); return;
      }
      patch({ flow: { name: 'submitting', stage: 'composing', message: COPY.flow.handingOver, summary } });
      try {
        const pool = await operations.poolConfig(signal);
        if (!live(id)) return;
        if (!options.canStartFinancialAction()) {
          patch({ flow: { name: 'review', summary }, notice: COPY.errors['submission-uncertain'] });
          return;
        }
        if (pool.feeAmount + batch.gasEstimate > batch.totalCost + feeTolerance) { discard(); patch({ flow: { name: 'failed', kind: 'unknown', message: COPY.notices.feeMoved, recovery: 'prepare-again' } }); return; }
        if (!options.canStartFinancialAction()) {
          patch({ flow: { name: 'review', summary }, notice: COPY.errors['submission-uncertain'] });
          return;
        }
        signingOwner = id;
        signingBatch = batch;
        const result = await batch.confirm({ feeCeiling: batch.totalCost + feeTolerance, signal, onProgress: ({ stage }) => { if (live(id)) patch({ flow: { name: 'submitting', stage, message: stageCopy(stage), summary } }); } });
        if (signingOwner === id) {
          signingOwner = null;
          signingBatch = null;
        }
        if (prepared === batch) prepared = null;
        receipts.record({ building: 'exchange', transactionHash: result.transactionHash, intents: batch.intents });
        ++balanceRead;
        if (!live(id)) return;
        patch({ balances: 'unrequested', flow: { name: 'submitted', transactionHash: result.transactionHash }, notice: COPY.balance.changed });
      } catch (error) {
        if (signingOwner === id) {
          signingOwner = null;
          signingBatch = null;
        }
        // A stale attempt has no visible state left to classify. In particular,
        // closing the panel must not start a new pool read after wallet handoff.
        if (
          toFailure(error).kind === 'unknown' &&
          live(id) &&
          (await feeMovedPast(batch, signal))
        ) {
          if (!live(id)) return;
          discard(); patch({ flow: { name: 'failed', kind: 'unknown', message: COPY.notices.feeMoved, recovery: 'prepare-again' } }); return;
        }
        fail(error, id);
      }
    },
    cancelPrepared() { start(); discard(); patch({ flow: { name: 'composing' }, notice: null }); },
    acknowledge() { const flow = store.getState().flow; if (flow.name === 'submitted') { receipts.acknowledge(flow.transactionHash); patch({ flow: { name: 'composing' }, notice: null }); } },
  };

  async function feeMovedPast(batch: PreparedBatch, signal?: AbortSignal): Promise<boolean> {
    try { const pool = await operations.poolConfig(signal); return pool.feeAmount + batch.gasEstimate > batch.totalCost + feeTolerance; }
    catch { return false; }
  }
}

function initialState(register: readonly RouteGrade[]): ExchangeState {
  return { door: routeDoor('exchange.swap', register), balances: 'unrequested', sellChoices: [], sell: null, buy: null, amountText: '', notice: null, flow: { name: 'idle' } };
}

function validReview(intent: Intent | undefined, review: PreparedBatch['swapReview'], sell: ExchangeAsset, buy: ExchangeAsset, amountIn: bigint, now: number): intent is Extract<Intent, { kind: 'swap' }> {
  return !!intent && intent.kind === 'swap' && !!review && sameAddress(intent.tokenIn, sell.token) && sameAddress(intent.tokenOut, buy.token) && intent.amountIn === amountIn && review.minimumAmountOut === intent.minAmountOut && intent.minAmountOut > 0n && typeof review.expectedAmountOut === 'bigint' && review.expectedAmountOut > 0n && review.minimumAmountOut <= review.expectedAmountOut && Number.isSafeInteger(review.slippageBps) && review.slippageBps > 0 && review.slippageBps <= 10_000 && Number.isSafeInteger(review.expiresAt) && review.expiresAt > now;
}
