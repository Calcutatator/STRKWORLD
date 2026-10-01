import type { Intent, OperationStage, PreparedBatch, PrivacyErrorKind, PrivacyOperations, PrivateBalance } from '@strkworld/privacy';
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
  /** D-084: the quote's implied rate, "1 STRK ≈ 0.0431 USDC". */
  readonly rate: string;
  /** D-090: the same rate the other way up, "1 USDC ≈ 23.2 STRK", for the rate line's invert. */
  readonly inverseRate: string;
  /** D-084: the oracle's USD value of each side, where the oracle prices it. */
  readonly sellUsd: string | null;
  readonly expectedBuyUsd: string | null;
  /** D-084: whether an independent oracle price vouches for this quote. */
  readonly priceCheck: 'checked' | 'unchecked';
  readonly priceCheckNote: string;
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

/**
 * D-090: the compose view's live quote, the figure the Buy field shows while
 * the player types. A live quote is a prepared batch like a Review press
 * makes, held until the player presses Review (which takes it as is, with no
 * second request) or edits the swap (which discards it).
 *
 * `paused`: live quoting has stopped asking, because the counter's own budget
 * for this minute is spent or the last live quote failed; Review still asks.
 */
export type LiveQuote =
  | { readonly status: 'idle' | 'quoting' | 'paused' }
  | { readonly status: 'failed'; readonly message: string }
  | {
      readonly status: 'ready';
      /** Which swap this answers: sell, buy, amount and slippage. */
      readonly key: string;
      readonly summary: ExchangeReview;
      readonly expectedAmountOut: bigint;
      readonly minimumAmountOut: bigint;
      /**
       * How far the expected output sits below the input's value at Pragma's
       * price, in bps (avnu's fee and the route's impact together); `null`
       * when Pragma prices only one side or neither.
       */
      readonly priceImpactBps: number | null;
      /** The quote ran out: the figures stay on show, dimmed, and Review asks again. */
      readonly stale: boolean;
    };

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
  /** D-084: the player ticked "I understand" for a review with no independent price check. */
  readonly priceAcknowledged: boolean;
  /** The pool balance of each sellable asset, as the last read returned it. */
  readonly holdings: readonly PrivateBalance[];
  /** The pool's fee and fee token from `open()`, for a Max that leaves the fee behind. */
  readonly pool: { readonly feeAmount: bigint; readonly feeToken: string } | null;
  /** D-090: the slippage cog's text, a percentage ("0.5"). */
  readonly slippageText: string;
  /** D-090: the widest slippage this build lets the player choose, in bps. */
  readonly slippageCeilingBps: number;
  /** D-090: the Buy field's live quote. */
  readonly live: LiveQuote;
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
  /** D-090: the slippage cog's value, a percentage as typed. */
  setSlippage(text: string): void;
  /** D-090: swap the two sides, carrying the live output into the Sell field. */
  flip(): void;
  prepare(signal?: AbortSignal): Promise<void>;
  confirm(signal?: AbortSignal): Promise<void>;
  cancelPrepared(): void;
  acknowledge(): void;
  /** D-084: the player's acknowledgement that the reviewed swap has no independent price check. */
  acknowledgeUncheckedPrice(acknowledged: boolean): void;
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
  /**
   * D-090: quote while the player types, this long after the last edit
   * (`LIVE_QUOTE_DELAY_MS` in the panel). Absent, there is no live quote and
   * only a Review press asks, as before.
   */
  liveQuoteDelayMs?: number;
  /**
   * D-090: the widest slippage the cog offers, in bps: the build's own
   * (`WalletRoutePolicy.swap.slippageBps`), at most `SLIPPAGE_CAP_BPS`.
   */
  slippageCeilingBps?: number;
}): ExchangePanel {
  const { operations, receipts, onError } = options;
  const feeTolerance = options.feeTolerance ?? 0n;
  const now = options.now ?? Date.now;
  const register = options.register ?? PRIVACY_REGISTER;
  const catalogPort = options.catalog;
  const quoteSpacingMs = options.quoteSpacingMs ?? QUOTE_SPACING_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  let lastQuoteAt: number | null = null;
  const liveDelayMs = options.liveQuoteDelayMs ?? null;
  const slippageCeilingBps = ownSlippageCeiling(options.slippageCeilingBps);
  const fresh = () => initialState(register, catalogPort !== undefined, slippageCeilingBps);
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
    } else if (store.getState().flow.name === 'review') {
      start();
      discard();
      patch({ ...next, flow: { name: 'composing' } });
    } else {
      patch(next);
    }
    scheduleLive();
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
  const quote = async (sell: ExchangeAsset, buy: ExchangeAsset, amountIn: bigint, slippageBps: number, signal?: AbortSignal): Promise<{ batch: PreparedBatch; summary: ExchangeReview } | null> => {
    // 1 is a request sentinel only. It never reaches the player-facing review.
    const batch = await operations.prepare([{ kind: 'swap', tokenIn: sell.token, tokenOut: buy.token, amountIn, minAmountOut: 1n, slippageBps }], signal);
    const intent = batch.intents.length === 1 ? batch.intents[0] : undefined;
    const review = batch.swapReview;
    // D-090: the floor must be the one for the slippage the player chose.
    if (!validReview(intent, review, sell, buy, amountIn, now()) || review!.slippageBps !== slippageBps) {
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
      rate: `1 ${sell.symbol} ≈ ${formatRate((safeReview.expectedAmountOut * 10n ** BigInt(sell.decimals)) / intent.amountIn, buy.decimals)} ${buy.symbol}`,
      inverseRate: `1 ${buy.symbol} ≈ ${formatRate((intent.amountIn * 10n ** BigInt(buy.decimals)) / safeReview.expectedAmountOut, sell.decimals)} ${sell.symbol}`,
      sellUsd: formatUsd(safeReview.priceCheck.sellUsd),
      expectedBuyUsd: formatUsd(safeReview.priceCheck.expectedBuyUsd),
      priceCheck: safeReview.priceCheck.status,
      priceCheckNote: safeReview.priceCheck.status === 'checked'
        ? priceCheckedNote(safeReview.priceCheck.shortfallBps ?? 0, safeReview.priceCheck.boundBps)
        : COPY.exchange.priceUnchecked,
    };
    return { batch, summary };
  };

  // -- D-090: the live quote ----------------------------------------------
  //
  // One quote at a time, `liveDelayMs` after the last edit and never inside
  // the 1.5 s spacing a Review press keeps, from a budget that mirrors the
  // backend's per-client bucket (`LIVE_QUOTE_BUDGET`), so typing can never
  // spend what a Review press needs. A failure pauses live quoting until the
  // next Review press, so a refusal in the wallet is not asked again on every
  // keystroke.
  let livePrepared: PreparedBatch | null = null;
  let liveRun = 0;
  let livePending: { readonly run: number; readonly key: string; requesting: boolean; readonly done: Promise<void> } | null = null;
  let liveHalted = false;
  let liveTokens: number = LIVE_QUOTE_BUDGET.capacity;
  let liveTokensAt = now();
  const takeLiveToken = () => {
    const elapsed = now() - liveTokensAt;
    const refilled = Math.floor(elapsed / LIVE_QUOTE_BUDGET.refillMs);
    if (refilled > 0) {
      liveTokens = Math.min(LIVE_QUOTE_BUDGET.capacity, liveTokens + refilled);
      liveTokensAt = liveTokens === LIVE_QUOTE_BUDGET.capacity ? now() : liveTokensAt + refilled * LIVE_QUOTE_BUDGET.refillMs;
    }
    if (liveTokens <= 0) return false;
    liveTokens -= 1;
    return true;
  };
  const dropLive = () => {
    ++liveRun;
    livePending = null;
    livePrepared?.discard();
    livePrepared = null;
  };
  const scheduleLive = () => {
    if (liveDelayMs === null) return;
    dropLive();
    const state = store.getState();
    // Nothing is quoted while an earlier submission is unaccounted for: Review is gated then too.
    const request = state.flow.name === 'composing' && options.canStartFinancialAction() ? swapRequest(state) : null;
    if (request === null) {
      if (state.live.status !== 'idle') patch({ live: { status: 'idle' } });
      return;
    }
    if (liveHalted) {
      patch({ live: { status: 'paused' } });
      return;
    }
    const run = liveRun;
    let settle!: () => void;
    const done = new Promise<void>((resolve) => { settle = resolve; });
    const pending = { run, key: request.key, requesting: false, done };
    livePending = pending;
    patch({ live: { status: 'quoting' } });
    void (async () => {
      try {
        await sleep(liveDelayMs);
        if (run !== liveRun) return;
        const wait = lastQuoteAt === null ? 0 : lastQuoteAt + quoteSpacingMs - now();
        if (wait > 0) {
          await sleep(Math.min(wait, quoteSpacingMs));
          if (run !== liveRun) return;
        }
        if (!takeLiveToken()) {
          patch({ live: { status: 'paused' } });
          return;
        }
        pending.requesting = true;
        lastQuoteAt = now();
        let quoted: Awaited<ReturnType<typeof quote>>;
        try {
          quoted = await quote(request.sell, request.buy, request.amountIn, request.slippageBps);
        } catch (error) {
          if (run !== liveRun) return;
          liveHalted = true;
          patch({ live: { status: 'failed', message: COPY.errors[toFailure(error).kind] } });
          return;
        }
        if (run !== liveRun) { quoted?.batch.discard(); return; }
        if (!quoted) {
          liveHalted = true;
          patch({ live: { status: 'failed', message: COPY.errors.unknown } });
          return;
        }
        livePrepared = quoted.batch;
        const review = quoted.batch.swapReview!;
        const check = review.priceCheck;
        patch({ live: {
          status: 'ready',
          key: request.key,
          summary: quoted.summary,
          expectedAmountOut: review.expectedAmountOut,
          minimumAmountOut: review.minimumAmountOut,
          priceImpactBps: check.status === 'checked' ? Math.max(0, check.shortfallBps ?? 0) : null,
          stale: false,
        } });
        // The figures dim when the quote runs out; nothing re-asks on its own.
        void sleep(Math.min(MAX_TIMER_MS, Math.max(0, review.expiresAt - now()))).then(() => {
          const live = store.getState().live;
          if (run === liveRun && live.status === 'ready' && !live.stale) patch({ live: { ...live, stale: true } });
        });
      } finally {
        if (livePending === pending) livePending = null;
        settle();
      }
    })();
  };
  /** A live quote for exactly this swap already being asked, to wait for rather than ask twice. */
  const liveInFlight = (key: string): Promise<void> | null => {
    const pending = livePending;
    return pending && pending.key === key && pending.requesting ? pending.done : null;
  };
  /** Take the live quote for exactly this swap, or null when there is none fresh to take. */
  const takeLive = (key: string): { batch: PreparedBatch; summary: ExchangeReview } | null => {
    const current = store.getState().live;
    const batch = livePrepared;
    if (
      current.status === 'ready' && current.key === key && !current.stale
      && batch !== null && batch.swapReview !== undefined && batch.swapReview.expiresAt > now()
    ) {
      livePrepared = null;
      ++liveRun;
      livePending = null;
      return { batch, summary: current.summary };
    }
    return null;
  };

  return Object.freeze<ExchangePanel>({
    store,
    async open(signal) {
      const id = start(); patch({ flow: { name: 'loading-pool' } });
      // The list loads beside the pool read; the flow does not wait for it.
      void loadCatalog(signal);
      try {
        const config = await operations.poolConfig(signal);
        if (!live(id)) return;
        const receipt = receipts.pending('exchange')[0];
        patch({ pool: { feeAmount: config.feeAmount, feeToken: config.feeToken }, flow: receipt ? { name: 'submitted', transactionHash: receipt.transactionHash, restored: true } : { name: 'composing' } });
      } catch (error) { fail(error, id, 'close'); }
    },
    close() { start(); ++session; ++balanceRead; ++catalogRead; discard(); dropLive(); liveHalted = false; stateStore.setState(freezeExchangeState(fresh())); },
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
        const holdings = balances.filter((entry) => sellChoices.some((asset) => sameAddress(asset.token, entry.token)));
        patch({ balances: 'loaded', sellChoices, sell, buy, holdings });
        scheduleLive();
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
    setSlippage(slippageText) { editComposition({ slippageText, notice: null }); },
    flip() {
      const state = store.getState();
      if (!canFlip(state)) return;
      const sell = state.sell!; const buy = state.buy!;
      const nextSell = state.sellChoices.find((asset) => sameAddress(asset.token, buy.token))!;
      // Carry the output across, as swap apps do; a stale or missing one carries nothing.
      const request = swapRequest(state);
      const carried = state.live.status === 'ready' && !state.live.stale && request !== null && state.live.key === request.key
        ? formatTokenAmountExact(state.live.expectedAmountOut, buy.decimals)
        : '';
      editComposition({ sell: nextSell, buy: sell, amountText: carried, notice: null });
    },
    async prepare(signal) {
      if (!gate()) return;
      const state = store.getState();
      if (!state.door.open || !state.sell || !state.buy || sameAddress(state.sell.token, state.buy.token)) { patch({ notice: state.door.message || COPY.locked.unknownRoute }); return; }
      // A display-only token is listed, never swapped (D-067).
      if (!isListedSwappable(state, state.sell) || !isListedSwappable(state, state.buy)) { patch({ notice: COPY.degen.displayOnlyNotice }); return; }
      const amountIn = parseTokenAmount(state.amountText, state.sell.decimals);
      if (amountIn === null || amountIn <= 0n) { patch({ notice: COPY.notices.badAmount }); return; }
      const slippage = parseSlippage(state.slippageText, state.slippageCeilingBps);
      if (slippage.status !== 'ok') { patch({ notice: COPY.exchange.slippageFix }); return; }
      const id = start(); discard(); patch({ flow: { name: 'preparing' }, notice: null });
      try {
        // D-090: the live quote for exactly this swap, if fresh, is the
        // review; one being asked is waited for rather than asked twice.
        const key = swapKey(state.sell, state.buy, amountIn, slippage.bps);
        const inFlight = liveInFlight(key);
        if (inFlight) {
          await inFlight;
          if (!live(id)) return;
        }
        const taken = takeLive(key);
        // A Review press is the player asking, so live quoting may ask again after it.
        liveHalted = false;
        if (taken) {
          prepared = taken.batch;
          patch({ flow: { name: 'review', summary: taken.summary }, priceAcknowledged: false });
          return;
        }
        dropLive();
        // D-084: at most one quote per spacing window. A press inside it
        // waits out the rest; a newer press replaces this one meanwhile.
        const wait = lastQuoteAt === null ? 0 : lastQuoteAt + quoteSpacingMs - now();
        if (wait > 0) {
          await sleep(Math.min(wait, quoteSpacingMs));
          if (!live(id)) return;
        }
        lastQuoteAt = now();
        const quoted = await quote(state.sell, state.buy, amountIn, slippage.bps, signal);
        if (!live(id)) { quoted?.batch.discard(); return; }
        if (!quoted) {
          patch({ flow: { name: 'failed', kind: 'unknown', message: COPY.errors.unknown, recovery: 'prepare-again' } });
          return;
        }
        prepared = quoted.batch;
        patch({ flow: { name: 'review', summary: quoted.summary }, priceAcknowledged: false });
      } catch (error) { fail(error, id); }
    },
    async confirm(signal) {
      if (!gate()) return;
      const state = store.getState(); let batch = prepared;
      if (state.flow.name !== 'review' || !batch) return;
      if (state.flow.summary.priceCheck === 'unchecked' && !state.priceAcknowledged) {
        patch({ notice: COPY.exchange.acknowledgeFirst });
        return;
      }
      const acknowledgeUncheckedPrice = state.flow.summary.priceCheck === 'unchecked' && state.priceAcknowledged;
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
          const fresh = reviewedPair ? await quote(sell!, buy!, intent.amountIn, batch.swapReview.slippageBps, signal) : null;
          if (!live(id)) { fresh?.batch.discard(); return; }
          if (!fresh) {
            discard(); patch({ flow: { name: 'failed', kind: 'unknown', message: COPY.errors.unknown, recovery: 'prepare-again' } }); return;
          }
          discard();
          prepared = fresh.batch;
          if (fresh.batch.swapReview!.minimumAmountOut < reviewedFloor) {
            patch({ flow: { name: 'review', summary: fresh.summary }, notice: COPY.exchange.requoted, priceAcknowledged: false });
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
        const result = await batch.confirm({ feeCeiling: reviewedTotal + feeTolerance, ...(acknowledgeUncheckedPrice ? { acknowledgeUncheckedPrice: true } : {}), signal, onProgress: ({ stage }) => { if (live(id)) patch({ flow: { name: 'submitting', stage, message: stageCopy(stage), summary } }); } });
        if (signingOwner === id) {
          signingOwner = null;
          signingBatch = null;
        }
        if (prepared === batch) prepared = null;
        receipts.record({ building: 'exchange', transactionHash: result.transactionHash, intents: batch.intents });
        ++balanceRead;
        if (!live(id)) return;
        patch({ balances: 'unrequested', holdings: [], flow: { name: 'submitted', transactionHash: result.transactionHash }, notice: COPY.balance.changed });
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
    cancelPrepared() { start(); discard(); patch({ flow: { name: 'composing' }, notice: null }); scheduleLive(); },
    acknowledgeUncheckedPrice(acknowledged) {
      const flow = store.getState().flow;
      if (flow.name !== 'review' || flow.summary.priceCheck !== 'unchecked') return;
      patch({ priceAcknowledged: acknowledged === true, notice: null });
    },
    acknowledge() { const flow = store.getState().flow; if (flow.name === 'submitted') { receipts.acknowledge(flow.transactionHash); patch({ flow: { name: 'composing' }, notice: null }); scheduleLive(); } },
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

function initialState(register: readonly RouteGrade[], loaded: boolean, slippageCeilingBps: number): ExchangeState {
  return {
    door: routeDoor('exchange.swap', register), catalog: loaded ? { status: 'idle' } : FIXED_CATALOG, balances: 'unrequested', sellChoices: [], sell: null, buy: null, amountText: '', notice: null, flow: { name: 'idle' }, priceAcknowledged: false, holdings: [], pool: null,
    slippageText: bpsText(Math.min(DEFAULT_SLIPPAGE_BPS, slippageCeilingBps)), slippageCeilingBps, live: { status: 'idle' },
  };
}

/**
 * D-090: the slippage cog. Presets as swap apps offer them (1inch's 0.1%,
 * 0.5% and 1%; Uniswap's default 0.5%), a custom value up to the build's
 * ceiling, never above `SLIPPAGE_CAP_BPS` (3%: with D-084's 3% oracle bound no
 * checked swap settles more than 6% under Pragma's price), and a warning
 * above `SLIPPAGE_WARN_BPS`.
 */
export const SLIPPAGE_PRESETS_BPS: readonly number[] = Object.freeze([10, 50, 100]);
export const DEFAULT_SLIPPAGE_BPS = 50;
export const SLIPPAGE_CAP_BPS = 300;
export const SLIPPAGE_WARN_BPS = 100;
/** D-090: a price impact above this is shown as a warning. */
export const PRICE_IMPACT_WARN_BPS = 300;
/** The longest a timer can wait: a later expiry would fire at once instead. */
const MAX_TIMER_MS = 2_147_483_647;
/** D-090: how long after the last edit the counter quotes live. */
export const LIVE_QUOTE_DELAY_MS = 800;
/**
 * D-090: the live quote's own budget, below the backend's per-client bucket
 * (10 at once, one more every 6 s, D-084), so typing leaves room for the
 * Review press and the confirm-time re-quote.
 */
export const LIVE_QUOTE_BUDGET = Object.freeze({ capacity: 7, refillMs: 6_000 });

export type SlippageCheck =
  | { readonly status: 'ok'; readonly bps: number }
  | { readonly status: 'empty' | 'zero' | 'invalid' }
  | { readonly status: 'over'; readonly ceilingBps: number };

/** "0.5" as 50 bps; at most two decimal places, more than 0, at most the ceiling. */
export function parseSlippage(text: string, ceilingBps: number): SlippageCheck {
  const trimmed = text.trim().replace(/%$/, '').trim();
  if (trimmed === '') return { status: 'empty' };
  if (!/^\d{0,3}(\.\d{0,2})?$/.test(trimmed) || trimmed === '.') return { status: 'invalid' };
  const [whole = '', fraction = ''] = trimmed.split('.');
  const bps = Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0'));
  if (bps === 0) return { status: 'zero' };
  if (bps > ceilingBps) return { status: 'over', ceilingBps };
  return { status: 'ok', bps };
}

/** 50 bps as "0.5". */
export function bpsText(bps: number): string {
  return (bps / 100).toString();
}

function ownSlippageCeiling(value: number | undefined): number {
  if (value === undefined) return SLIPPAGE_CAP_BPS;
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('The slippage ceiling must be a positive whole number of bps.');
  return Math.min(value, SLIPPAGE_CAP_BPS);
}

function swapKey(sell: ExchangeAsset, buy: ExchangeAsset, amountIn: bigint, slippageBps: number): string {
  return `${BigInt(sell.token).toString(16)}|${BigInt(buy.token).toString(16)}|${amountIn}|${slippageBps}`;
}

/**
 * D-090: the swap the compose view describes, if it is one worth a live
 * quote: the door open, both sides listed and swappable, an amount within the
 * pool balance, a valid slippage. Anything else gets no quote.
 */
export function swapRequest(state: ExchangeState): { sell: ExchangeAsset; buy: ExchangeAsset; amountIn: bigint; slippageBps: number; key: string } | null {
  const { sell, buy } = state;
  if (!state.door.open || state.balances !== 'loaded' || !sell || !buy || sameAddress(sell.token, buy.token)) return null;
  if (!isListedSwappable(state, sell) || !isListedSwappable(state, buy)) return null;
  const amountIn = parseTokenAmount(state.amountText, sell.decimals);
  if (amountIn === null || amountIn <= 0n) return null;
  const holding = holdingOf(state, sell.token);
  if (holding !== null && amountIn > holding.total) return null;
  const slippage = parseSlippage(state.slippageText, state.slippageCeilingBps);
  if (slippage.status !== 'ok') return null;
  return { sell, buy, amountIn, slippageBps: slippage.bps, key: swapKey(sell, buy, amountIn, slippage.bps) };
}

/** D-090: the flip arrow works when the asset being bought can be sold: the pool holds some. */
export function canFlip(state: ExchangeState): boolean {
  const { sell, buy } = state;
  if (!sell || !buy || state.balances !== 'loaded') return false;
  return state.sellChoices.some((asset) => sameAddress(asset.token, buy.token));
}

/** The listed assets, or none until a loaded list is ready. */
export function listedAssets(state: ExchangeState): readonly ExchangeAsset[] {
  return state.catalog.status === 'ready' ? state.catalog.assets : [];
}

/** The pool balance of `token` from the last read, or null before one. */
export function holdingOf(state: ExchangeState, token: string): PrivateBalance | null {
  return state.holdings.find((entry) => sameAddress(entry.token, token)) ?? null;
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
    holdings: Object.isFrozen(state.holdings) ? state.holdings : Object.freeze(state.holdings.map((entry) => Object.freeze({ ...entry }))),
    pool: state.pool === null ? null : Object.freeze({ ...state.pool }),
    live: Object.isFrozen(state.live) ? state.live : Object.freeze(state.live.status === 'ready'
      ? { ...state.live, summary: Object.freeze({ ...state.live.summary, disclosures: Object.freeze([...state.live.summary.disclosures]) }) }
      : { ...state.live }),
    sell: freezeOptional(state.sell),
    buy: freezeOptional(state.buy),
    flow,
  });
}

function validReview(intent: Intent | undefined, review: PreparedBatch['swapReview'], sell: ExchangeAsset, buy: ExchangeAsset, amountIn: bigint, now: number): intent is Extract<Intent, { kind: 'swap' }> {
  return !!intent && intent.kind === 'swap' && !!review && sameAddress(intent.tokenIn, sell.token) && sameAddress(intent.tokenOut, buy.token) && intent.amountIn === amountIn && review.minimumAmountOut === intent.minAmountOut && intent.minAmountOut > 0n && typeof review.expectedAmountOut === 'bigint' && review.expectedAmountOut > 0n && review.minimumAmountOut <= review.expectedAmountOut && Number.isSafeInteger(review.slippageBps) && review.slippageBps > 0 && review.slippageBps <= 10_000 && Number.isSafeInteger(review.expiresAt) && review.expiresAt > now && validPriceCheck(review.priceCheck);
}

/** D-084: a well-formed price check; a `checked` one sits within its own bound. */
function validPriceCheck(check: unknown): boolean {
  if (!check || typeof check !== 'object') return false;
  const { status, boundBps, shortfallBps, sellUsd, expectedBuyUsd } = check as Record<string, unknown>;
  const usd = (value: unknown) => value === undefined || (typeof value === 'bigint' && value >= 0n);
  if (!Number.isSafeInteger(boundBps) || (boundBps as number) <= 0 || !usd(sellUsd) || !usd(expectedBuyUsd)) return false;
  if (status === 'unchecked') return true;
  return status === 'checked' && Number.isSafeInteger(shortfallBps) && (shortfallBps as number) <= (boundBps as number);
}

function priceCheckedNote(shortfallBps: number, boundBps: number): string {
  if (shortfallBps <= 0) return COPY.exchange.priceCheckedAbove;
  return COPY.exchange.priceCheckedBelow
    .replace('{shortfall}', (shortfallBps / 100).toFixed(2))
    .replace('{bound}', String(boundBps / 100));
}

/** At most eight decimal places of a rate, trailing zeros dropped. */
function formatRate(value: bigint, decimals: number): string {
  const exact = formatTokenAmountExact(value, decimals);
  const [whole, fraction] = exact.split('.');
  if (!fraction) return exact;
  const trimmed = fraction.slice(0, 8).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole!;
}

/** An 8-decimal USD value as "≈ $1,234.56", "< $0.01", or null when the oracle gave none. */
function formatUsd(value: bigint | undefined): string | null {
  if (value === undefined || value <= 0n) return null;
  const cents = (value + 500_000n) / 1_000_000n;
  if (cents === 0n) return '< $0.01';
  const dollars = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `≈ $${dollars}.${(cents % 100n).toString().padStart(2, '0')}`;
}
