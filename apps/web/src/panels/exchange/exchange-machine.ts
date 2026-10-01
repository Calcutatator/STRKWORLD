import type { Intent, OperationStage, PreparedBatch, PrivacyErrorKind, PrivacyOperations } from '@strkworld/privacy';
import type { ReceiptLedger } from '../../receipts/receipt-ledger.js';
import { createStore, type ReadableStore } from '../../store/store.js';
import { formatTokenAmountExact, parseTokenAmount, sameAddress } from '../../format.js';
import { COPY } from '../../copy.js';
import { toFailure, type ShellFailure } from '../../privacy/errors.js';
import { disclosuresForIntents, routeDoor, type DoorState } from '../routes.js';
import { PRIVACY_REGISTER } from '../../privacy/register.js';
import type { RouteGrade } from '../../privacy/register.js';
import {
  EXCHANGE_CATALOG,
  isSwappable,
  type AvnuTag,
  type ExchangeAsset,
  type ExchangeCatalogOrigin,
  type ExchangeCatalogPort,
} from './catalog.js';

export interface ExchangeReview {
  readonly sell: string;
  readonly expectedBuy: string;
  readonly protectedMinimum: string;
  readonly slippage: string;
  readonly expiresAt: string;
  readonly poolFee: string;
  readonly networkCost: string;
  readonly total: string;
  readonly disclosures: readonly string[];
}

export type ExchangeFlow =
  | { name: 'idle' | 'loading-pool' | 'composing' | 'preparing' }
  | { name: 'review'; summary: ExchangeReview }
  | { name: 'submitting'; stage: OperationStage; message: string; summary: ExchangeReview }
  /** `restored` is set when this receipt was found outstanding on `open()`, not confirmed this session. */
  | { name: 'submitted'; transactionHash: string; restored?: boolean }
  | { name: 'failed'; kind: PrivacyErrorKind; message: string; recovery: 'prepare-again' | 'close' };

/**
 * The floor's listed assets. The ground floor's fixed six are always ready
 * (D-042); the degen floor's list loads when the counter opens (D-067).
 */
export type ExchangeCatalogState =
  | {
      readonly status: 'ready';
      readonly origin: ExchangeCatalogOrigin;
      readonly assets: readonly ExchangeAsset[];
    }
  | { readonly status: 'idle' | 'loading' | 'failed' };

export interface ExchangeState {
  readonly door: DoorState;
  readonly catalog: ExchangeCatalogState;
  readonly balances: 'unrequested' | 'loading' | 'loaded' | 'failed';
  readonly sellChoices: readonly ExchangeAsset[];
  readonly sell: ExchangeAsset | null;
  readonly buy: ExchangeAsset | null;
  readonly amountText: string;
  readonly notice: string | null;
  readonly flow: ExchangeFlow;
}

export interface ExchangePanel {
  /** Read-only view; panel methods own every financial state transition. */
  readonly store: ReadableStore<ExchangeState>;
  open(signal?: AbortSignal): Promise<void>;
  close(): void;
  /** Load a loaded floor's list again after it failed. The ground floor's fixed six never need it. */
  reloadCatalog(signal?: AbortSignal): Promise<void>;
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
  /**
   * A list that loads on open: the degen floor's (D-067). Absent, the floor
   * lists the ground floor's fixed six. Either way the flow, the review and
   * every check below are the same.
   */
  catalog?: ExchangeCatalogPort;
  /**
   * D-084: the least time between two quote requests from this counter, so
   * repeated Review presses never hammer avnu's rate-limited public API. A
   * press inside the window waits out the rest of it, and a newer press
   * replaces a waiting one. `QUOTE_SPACING_MS` by default.
   */
  quoteSpacingMs?: number;
  /** How the counter waits out the quote spacing; a test passes its own. */
  sleep?: (ms: number) => Promise<void>;
}): ExchangePanel {
  const { operations, receipts, onError } = options;
  const feeTolerance = options.feeTolerance ?? 0n;
  const now = options.now ?? Date.now;
  const register = options.register ?? PRIVACY_REGISTER;
  const catalogPort = options.catalog;
  const quoteSpacingMs = options.quoteSpacingMs ?? QUOTE_SPACING_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  let lastQuoteAt: number | null = null;
  const fresh = () => initialState(register, catalogPort !== undefined);
  const stateStore = createStore<ExchangeState>(freezeExchangeState(fresh()));
  const store: ReadableStore<ExchangeState> = Object.freeze({
    getState: stateStore.getState,
    getServerSnapshot: stateStore.getServerSnapshot,
    subscribe: stateStore.subscribe,
  });
  let prepared: PreparedBatch | null = null;
  let signingOwner: number | null = null;
  let signingBatch: PreparedBatch | null = null;
  let attempt = 0;
  let session = 0;
  let balanceRead = 0;
  let catalogRead = 0;
  const patch = (next: Partial<ExchangeState>) => stateStore.setState((state) => freezeExchangeState({ ...state, ...next }));
  const loadCatalog = async (signal?: AbortSignal) => {
    if (!catalogPort) return;
    const id = ++catalogRead; const currentSession = session;
    patch({ catalog: { status: 'loading' } });
    try {
      const result = await catalogPort.load(signal);
      if (id !== catalogRead || currentSession !== session) return;
      patch({ catalog: ownCatalog(result) });
    } catch {
      if (id !== catalogRead || currentSession !== session) return;
      patch({ catalog: { status: 'failed' } });
    }
  };
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

  /**
   * Ask for one swap's quote and own its review, or null for a review that
   * does not describe what was asked. The batch is the caller's to keep or
   * discard.
   */
  const quote = async (sell: ExchangeAsset, buy: ExchangeAsset, amountIn: bigint, signal?: AbortSignal): Promise<{ batch: PreparedBatch; summary: ExchangeReview } | null> => {
    // 1 is a request sentinel only. It never reaches the player-facing review.
    const batch = await operations.prepare([{ kind: 'swap', tokenIn: sell.token, tokenOut: buy.token, amountIn, minAmountOut: 1n }], signal);
    const intent = batch.intents.length === 1 ? batch.intents[0] : undefined;
    const review = batch.swapReview;
    if (!validReview(intent, review, sell, buy, amountIn, now())) {
      batch.discard();
      return null;
    }
    const safeReview = review!;
    const fee = (amount: bigint) => formatTokenAmountExact(amount, 18) + ' STRK';
    const summary: ExchangeReview = {
      sell: `${formatTokenAmountExact(intent.amountIn, sell.decimals)} ${sell.symbol}`,
      expectedBuy: `${formatTokenAmountExact(safeReview.expectedAmountOut, buy.decimals)} ${buy.symbol}`,
      protectedMinimum: `${formatTokenAmountExact(safeReview.minimumAmountOut, buy.decimals)} ${buy.symbol}`,
      slippage: `${(safeReview.slippageBps / 100).toFixed(2)}%`,
      expiresAt: new Date(safeReview.expiresAt).toISOString(),
      poolFee: fee(batch.poolFee), networkCost: fee(batch.gasEstimate), total: fee(batch.totalCost),
      disclosures: disclosuresForIntents(batch.intents, register),
    };
    return { batch, summary };
  };

  return Object.freeze<ExchangePanel>({
    store,
    async open(signal) {
      const id = start(); patch({ flow: { name: 'loading-pool' } });
      // The list loads beside the pool read; the flow does not wait for it.
      void loadCatalog(signal);
      try {
        await operations.poolConfig(signal);
        if (!live(id)) return;
        const receipt = receipts.pending('exchange')[0];
        patch({ flow: receipt ? { name: 'submitted', transactionHash: receipt.transactionHash, restored: true } : { name: 'composing' } });
      } catch (error) { fail(error, id, 'close'); }
    },
    close() { start(); ++session; ++balanceRead; ++catalogRead; discard(); stateStore.setState(freezeExchangeState(fresh())); },
    async reloadCatalog(signal) {
      if (store.getState().catalog.status !== 'failed') return;
      await loadCatalog(signal);
    },
    async refreshBalances(signal) {
      const listing = store.getState().catalog;
      if (listing.status !== 'ready') { patch({ notice: COPY.degen.notReady }); return; }
      // Display-only assets cannot be sold, so their balances are never asked for.
      const tradable = listing.assets.filter(isSwappable);
      const id = ++balanceRead; const currentSession = session;
      patch({ balances: 'loading', notice: null });
      try {
        const balances = tradable.length === 0 ? [] : await operations.balances(tradable.map((asset) => asset.token), signal);
        if (id !== balanceRead || currentSession !== session) return;
        const sellChoices = tradable.filter((asset) => (balances.find((b) => sameAddress(b.token, asset.token))?.total ?? 0n) > 0n);
        const sell = sellChoices[0] ?? null;
        const buy = tradable.find((asset) => sell && !sameAddress(asset.token, sell.token)) ?? null;
        patch({ balances: 'loaded', sellChoices, sell, buy });
      } catch (error) {
        if (id !== balanceRead || currentSession !== session) return;
        const failure = toFailure(error); onError?.(failure); patch({ balances: 'failed', notice: COPY.errors[failure.kind] });
      }
    },
    setSell(token) {
      const sell = store.getState().sellChoices.find((asset) => sameAddress(asset.token, token)) ?? null;
      const buy = listedAssets(store.getState()).find((asset) => sell && isSwappable(asset) && !sameAddress(asset.token, sell.token)) ?? null;
      editComposition({ sell, buy, amountText: '', notice: null });
    },
    setBuy(token) {
      const asset = listedAssets(store.getState()).find((candidate) => sameAddress(candidate.token, token));
      const sell = store.getState().sell;
      if (!asset || !isSwappable(asset) || !sell || sameAddress(asset.token, sell.token)) return;
      editComposition({ buy: asset, notice: null });
    },
    setAmount(amountText) { editComposition({ amountText, notice: null }); },
    async prepare(signal) {
      if (!gate()) return;
      const state = store.getState();
      if (!state.door.open || !state.sell || !state.buy || sameAddress(state.sell.token, state.buy.token)) { patch({ notice: state.door.message || COPY.locked.unknownRoute }); return; }
      // A display-only token is listed, never swapped (D-067).
      if (!isListedSwappable(state, state.sell) || !isListedSwappable(state, state.buy)) { patch({ notice: COPY.degen.displayOnlyNotice }); return; }
      const amountIn = parseTokenAmount(state.amountText, state.sell.decimals);
      if (amountIn === null || amountIn <= 0n) { patch({ notice: COPY.notices.badAmount }); return; }
      const id = start(); discard(); patch({ flow: { name: 'preparing' }, notice: null });
      try {
        // D-084: at most one quote per spacing window. A press inside it
        // waits out the rest; a newer press replaces this one meanwhile.
        const wait = lastQuoteAt === null ? 0 : lastQuoteAt + quoteSpacingMs - now();
        if (wait > 0) {
          await sleep(Math.min(wait, quoteSpacingMs));
          if (!live(id)) return;
        }
        lastQuoteAt = now();
        const quoted = await quote(state.sell, state.buy, amountIn, signal);
        if (!live(id)) { quoted?.batch.discard(); return; }
        if (!quoted) {
          patch({ flow: { name: 'failed', kind: 'unknown', message: COPY.errors.unknown, recovery: 'prepare-again' } });
          return;
        }
        prepared = quoted.batch;
        patch({ flow: { name: 'review', summary: quoted.summary } });
      } catch (error) { fail(error, id); }
    },
    async confirm(signal) {
      if (!gate()) return;
      const state = store.getState(); let batch = prepared;
      if (state.flow.name !== 'review' || !batch) return;
      const id = start(); let summary = state.flow.summary;
      // The fee the player reviewed stays the ceiling, even after a re-quote.
      const reviewedTotal = batch.totalCost;
      if (!batch.swapReview || !Number.isSafeInteger(batch.swapReview.expiresAt)) {
        discard(); patch({ flow: { name: 'failed', kind: 'unknown', message: COPY.errors.unknown, recovery: 'prepare-again' } }); return;
      }
      patch({ flow: { name: 'submitting', stage: 'composing', message: COPY.flow.handingOver, summary } });
      try {
        if (batch.swapReview.expiresAt <= now()) {
          // D-084: a quote that ran out is asked for again before the wallet
          // is. A fresh floor at or above the reviewed one goes ahead; a lower
          // one goes back to review with the new figures.
          const reviewedFloor = batch.swapReview.minimumAmountOut;
          const sell = store.getState().sell; const buy = store.getState().buy;
          const intent = batch.intents[0];
          // The pair is the reviewed batch's, never whatever the counter shows now.
          const reviewedPair = intent?.kind === 'swap' && sell && buy
            && sameAddress(sell.token, intent.tokenIn) && sameAddress(buy.token, intent.tokenOut);
          lastQuoteAt = now();
          const fresh = reviewedPair ? await quote(sell!, buy!, intent.amountIn, signal) : null;
          if (!live(id)) { fresh?.batch.discard(); return; }
          if (!fresh) {
            discard(); patch({ flow: { name: 'failed', kind: 'unknown', message: COPY.errors.unknown, recovery: 'prepare-again' } }); return;
          }
          discard();
          prepared = fresh.batch;
          if (fresh.batch.swapReview!.minimumAmountOut < reviewedFloor) {
            patch({ flow: { name: 'review', summary: fresh.summary }, notice: COPY.exchange.requoted });
            return;
          }
          batch = fresh.batch; summary = fresh.summary;
          patch({ flow: { name: 'submitting', stage: 'composing', message: COPY.flow.handingOver, summary } });
        }
        const pool = await operations.poolConfig(signal);
        if (!live(id)) return;
        if (!options.canStartFinancialAction()) {
          patch({ flow: { name: 'review', summary }, notice: COPY.errors['submission-uncertain'] });
          return;
        }
        if (pool.feeAmount + batch.gasEstimate > reviewedTotal + feeTolerance) { discard(); patch({ flow: { name: 'failed', kind: 'unknown', message: COPY.notices.feeMoved, recovery: 'prepare-again' } }); return; }
        if (!options.canStartFinancialAction()) {
          patch({ flow: { name: 'review', summary }, notice: COPY.errors['submission-uncertain'] });
          return;
        }
        signingOwner = id;
        signingBatch = batch;
        const result = await batch.confirm({ feeCeiling: reviewedTotal + feeTolerance, signal, onProgress: ({ stage }) => { if (live(id)) patch({ flow: { name: 'submitting', stage, message: stageCopy(stage), summary } }); } });
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
  });

  async function feeMovedPast(batch: PreparedBatch, signal?: AbortSignal): Promise<boolean> {
    try { const pool = await operations.poolConfig(signal); return pool.feeAmount + batch.gasEstimate > batch.totalCost + feeTolerance; }
    catch { return false; }
  }
}

/**
 * D-084: the least time between two quote requests from one counter. avnu's
 * public API rate-limits by caller, and the backend asks it for every player,
 * so the counter never asks faster than this however often Review is pressed.
 */
export const QUOTE_SPACING_MS = 1_500;

/** The ground floor's fixed six (D-042): always ready, never loaded. */
const FIXED_CATALOG: ExchangeCatalogState = Object.freeze({ status: 'ready', origin: 'fixed', assets: EXCHANGE_CATALOG });

function initialState(register: readonly RouteGrade[], loaded: boolean): ExchangeState {
  return { door: routeDoor('exchange.swap', register), catalog: loaded ? { status: 'idle' } : FIXED_CATALOG, balances: 'unrequested', sellChoices: [], sell: null, buy: null, amountText: '', notice: null, flow: { name: 'idle' } };
}

/** The listed assets, or none until a loaded list is ready. */
export function listedAssets(state: ExchangeState): readonly ExchangeAsset[] {
  return state.catalog.status === 'ready' ? state.catalog.assets : [];
}

/** What the buy side may choose: listed, swappable in this build, and not the asset being sold. */
export function buyChoices(state: ExchangeState): readonly ExchangeAsset[] {
  return listedAssets(state).filter((asset) => isSwappable(asset) && (!state.sell || !sameAddress(asset.token, state.sell.token)));
}

function isListedSwappable(state: ExchangeState, asset: ExchangeAsset): boolean {
  const listed = listedAssets(state).find((candidate) => sameAddress(candidate.token, asset.token));
  return listed !== undefined && isSwappable(listed) && isSwappable(asset);
}

const MAX_LISTED_ASSETS = 160;
const AVNU_TAGS: readonly AvnuTag[] = ['Unknown', 'Verified', 'Community', 'Unruggable', 'AVNU'];

/** Own a loaded list before it is shown: well-formed assets, each token once, or the whole list fails. */
function ownCatalog(result: unknown): ExchangeCatalogState {
  const invalid = () => new Error('The Exchange list is malformed.');
  if (!result || typeof result !== 'object') throw invalid();
  const origin = Object.getOwnPropertyDescriptor(result, 'origin')?.value as unknown;
  const assets = Object.getOwnPropertyDescriptor(result, 'assets')?.value as unknown;
  if ((origin !== 'live' && origin !== 'curated' && origin !== 'demo') || !Array.isArray(assets)) throw invalid();
  if (assets.length === 0 || assets.length > MAX_LISTED_ASSETS) throw invalid();
  const owned: ExchangeAsset[] = [];
  for (const asset of assets as unknown[]) {
    if (!asset || typeof asset !== 'object') throw invalid();
    const read = (key: string) => {
      const descriptor = Object.getOwnPropertyDescriptor(asset, key);
      if (descriptor && !('value' in descriptor)) throw invalid();
      return descriptor?.value as unknown;
    };
    const symbol = read('symbol'); const decimals = read('decimals'); const token = read('token');
    const name = read('name'); const tags = read('tags'); const swappable = read('swappable');
    if (
      typeof symbol !== 'string' || symbol.length === 0 ||
      typeof decimals !== 'number' || !Number.isSafeInteger(decimals) || decimals < 0 ||
      typeof token !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(token) || BigInt(token) === 0n ||
      (name !== undefined && typeof name !== 'string') ||
      (swappable !== undefined && typeof swappable !== 'boolean') ||
      (tags !== undefined && (!Array.isArray(tags) || tags.some((tag: unknown) => !(AVNU_TAGS as readonly unknown[]).includes(tag))))
    ) {
      throw invalid();
    }
    if (owned.some((known) => sameAddress(known.token, token))) throw invalid();
    owned.push({
      symbol,
      decimals,
      token,
      ...(name !== undefined ? { name } : {}),
      ...(tags !== undefined ? { tags: [...(tags as AvnuTag[])] } : {}),
      ...(swappable !== undefined ? { swappable } : {}),
    });
  }
  return { status: 'ready', origin, assets: owned };
}

function freezeAsset(asset: ExchangeAsset): ExchangeAsset {
  if (Object.isFrozen(asset) && (asset.tags === undefined || Object.isFrozen(asset.tags))) return asset;
  return Object.freeze({ ...asset, ...(asset.tags ? { tags: Object.freeze([...asset.tags]) } : {}) });
}

/** Freeze a ready list entry by entry, keeping the same objects when they already are. */
function freezeCatalog(catalog: Extract<ExchangeCatalogState, { status: 'ready' }>): ExchangeCatalogState {
  const assets = catalog.assets.map(freezeAsset);
  const unchanged = Object.isFrozen(catalog)
    && Object.isFrozen(catalog.assets)
    && assets.every((asset, index) => asset === catalog.assets[index]);
  return unchanged ? catalog : Object.freeze({ ...catalog, assets: Object.freeze(assets) });
}

function freezeExchangeState(state: ExchangeState): ExchangeState {
  const freezeOptional = (asset: ExchangeAsset | null): ExchangeAsset | null =>
    asset === null ? null : freezeAsset(asset);
  const flow = state.flow.name === 'review' || state.flow.name === 'submitting'
    ? Object.freeze({
        ...state.flow,
        summary: Object.freeze({
          ...state.flow.summary,
          disclosures: Object.freeze([...state.flow.summary.disclosures]),
        }),
      })
    : Object.freeze({ ...state.flow });
  const catalog = state.catalog.status === 'ready'
    ? freezeCatalog(state.catalog)
    : Object.freeze({ ...state.catalog });
  return Object.freeze({
    ...state,
    door: Object.freeze({ ...state.door }),
    catalog,
    sellChoices: Object.freeze(state.sellChoices.map(freezeAsset)),
    sell: freezeOptional(state.sell),
    buy: freezeOptional(state.buy),
    flow,
  });
}

function validReview(intent: Intent | undefined, review: PreparedBatch['swapReview'], sell: ExchangeAsset, buy: ExchangeAsset, amountIn: bigint, now: number): intent is Extract<Intent, { kind: 'swap' }> {
  return !!intent && intent.kind === 'swap' && !!review && sameAddress(intent.tokenIn, sell.token) && sameAddress(intent.tokenOut, buy.token) && intent.amountIn === amountIn && review.minimumAmountOut === intent.minAmountOut && intent.minAmountOut > 0n && typeof review.expectedAmountOut === 'bigint' && review.expectedAmountOut > 0n && review.minimumAmountOut <= review.expectedAmountOut && Number.isSafeInteger(review.slippageBps) && review.slippageBps > 0 && review.slippageBps <= 10_000 && Number.isSafeInteger(review.expiresAt) && review.expiresAt > now;
}
