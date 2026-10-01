import { useEffect, useId, useMemo, type ReactNode } from 'react';
import { COPY } from '../../copy.js';
import { usePrivacy } from '../../privacy/PrivacyProvider.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import { detectRoutePolicy } from '../../production/config.js';
import { useStore } from '../../store/use-store.js';
import { ConfirmGate } from '../ConfirmGate.js';
import { LockedNotice } from '../LockedRoom.js';
import { PanelFrame } from '../PanelFrame.js';
import { isSwappable, type ExchangeAsset } from './catalog.js';
import { degenExchangeCatalog, policyAdmitsSwapToken } from './degen-catalog.js';
import { useDegenCatalog } from './DegenCatalogProvider.js';
import {
  AmountField, DetailRows, FlipButton, InvertibleRate, SettingsPopover, TokenSelect,
  checkAmount, feeReserve, maxAfterReserve, maxBasis, primaryAction,
  type DetailRow, type TokenOption,
} from '../kit/index.js';
import { formatTokenAmountExact } from '../../format.js';
import {
  LIVE_QUOTE_DELAY_MS, PRICE_IMPACT_WARN_BPS, SLIPPAGE_PRESETS_BPS, SLIPPAGE_WARN_BPS,
  bpsText, buyChoices, canFlip, createExchangePanel, holdingOf, parseSlippage, swapRequest,
  type ExchangePanel as ExchangeMachine, type ExchangeState, type LiveQuote,
} from './exchange-machine.js';
import { WalletAttentionCue, walletOperationAttention } from '../../wallet/WalletAttentionCue.js';
import { createPendingHudOwner } from '../pending-hud.js';
import { ReceiptNextStep } from '../JourneyNotice.js';
import { GlossaryTerm } from '../Glossary.js';

/**
 * Which counter this is: the ground floor's six-asset swap (D-042), or the
 * degen floor's swap over its own list (D-067). Both run the same machine,
 * flow, review and route; only the list and the look differ.
 */
export type ExchangeMode = 'ground' | 'degen';

/** Dedicated one-swap view; this deliberately has no batch/add vocabulary. */
export function ExchangePanel({ onClose, panel: injected, experience = 'menu', mode = 'ground', register = PRIVACY_REGISTER }: { onClose: () => void; panel?: ExchangeMachine; experience?: 'menu' | 'station'; mode?: ExchangeMode; register?: readonly RouteGrade[] }) {
  const { operations, receipts, noteOperationError, shellBus, submissionUncertainty } = usePrivacy();
  const degen = mode === 'degen';
  const degenSource = useDegenCatalog();
  // A listed degen token is swappable only if this build's wallet policy
  // admits it for swap; anything else is shown as display only.
  const catalog = useMemo(
    () => degen ? degenExchangeCatalog(degenSource, (token) => policyAdmitsSwapToken(detectRoutePolicy(), token)) : undefined,
    [degen, degenSource],
  );
  const owned = useMemo(() => injected ? null : createExchangePanel({
    operations, receipts, onError: noteOperationError,
    register,
    canStartFinancialAction: () => { const state = submissionUncertainty.store.getState(); return !state.active || state.acknowledged; },
    ...(catalog ? { catalog } : {}),
    // D-089: quote while the player types, and offer slippage up to the build's own ceiling.
    liveQuoteDelayMs: LIVE_QUOTE_DELAY_MS,
    ...slippageCeiling(),
  }), [injected, operations, receipts, noteOperationError, submissionUncertainty, register, catalog]);
  const panel = injected ?? owned!;
  const state = useStore(panel.store);
  const uncertainty = useStore(submissionUncertainty.store);
  const pendingHud = useMemo(() => createPendingHudOwner(shellBus), [shellBus]);
  useEffect(() => { if (!owned) return; void owned.open(); return () => owned.close(); }, [owned]);
  const pending = state.flow.name === 'preparing' || state.flow.name === 'submitting';
  useEffect(() => {
    pendingHud.setBusy(pending);
  }, [pendingHud, pending]);
  useEffect(() => () => pendingHud.release(), [pendingHud]);
  const committing = state.flow.name === 'review' || state.flow.name === 'submitting';
  const blocked = uncertainty.active && !uncertainty.acknowledged;
  const walletAttention = walletOperationAttention(
    state.balances === 'loading',
    state.flow.name === 'submitting' ? state.flow.stage : null,
  );
  const compose = <Compose state={state} panel={panel} />;
  return <div className="exchange-experience" data-experience={experience} data-mode={mode}>
    <WalletAttentionCue active={walletAttention !== null} kind={walletAttention ?? 'confirm'} />
    <PanelFrame title={COPY.buildings.exchange} building="exchange" brand={degen ? 'degen' : undefined} disclosure={null} closingNote={state.flow.name === 'submitting' ? COPY.flow.closingWillNotCancel : null} onClose={onClose}>
      {degen ? <p className="degen-eyebrow">{COPY.degen.eyebrow}</p> : null}
      <ReceiptNextStep building="exchange" transactionHash={state.flow.name === 'submitted' ? state.flow.transactionHash : null} register={register} />
      <p className="panel-hint">{COPY.exchange.oneSwap}</p>
      {!state.door.open ? <LockedNotice reason={state.door.reason ?? 'unknown-route'} message={state.door.message} /> :
        state.flow.name === 'submitted' ? <div className="flow-done"><p>{state.flow.restored ? COPY.flow.receiptWaiting : COPY.flow.submitted} <code>{state.flow.transactionHash}</code></p><button type="button" onClick={() => panel.acknowledge()}>{COPY.flow.back}</button></div> :
        blocked ? null : committing ? <Review state={state} onConfirm={() => void panel.confirm()} onCancel={() => panel.cancelPrepared()} onAcknowledge={(value) => panel.acknowledgeUncheckedPrice(value)} /> :
        state.flow.name === 'failed' && state.flow.recovery === 'close' ? <p role="alert">{state.flow.message}</p> :
        degen ? <DegenCompose state={state} onRetry={() => void panel.reloadCatalog()}>{compose}</DegenCompose> :
        compose}
      {state.notice ? <p className="panel-notice" role="status">{state.notice}</p> : null}
      {state.flow.name === 'failed' && state.flow.recovery === 'prepare-again' ? <div role="alert"><p>{state.flow.message}</p><button type="button" onClick={() => panel.cancelPrepared()}>{COPY.flow.back}</button></div> : null}
    </PanelFrame>
  </div>;
}

/** The build's own slippage ceiling (D-089), where this build has a swap policy. */
function slippageCeiling(): { slippageCeilingBps?: number } {
  const ceiling = detectRoutePolicy()?.swap?.slippageBps;
  return ceiling === undefined ? {} : { slippageCeilingBps: ceiling };
}

/** A token choice: the ticker, the name where the list gives one, the pool balance where read. */
function tokenOption(state: ExchangeState, asset: ExchangeAsset): TokenOption {
  return {
    token: asset.token,
    symbol: asset.symbol,
    decimals: asset.decimals,
    ...(asset.name ? { name: asset.name } : {}),
    balance: holdingOf(state, asset.token)?.total ?? null,
  };
}

/**
 * The swap, laid out as swap apps lay it out (D-089): Sell with its pool
 * balance, 50% and Max; the flip arrow; Buy, read-only, filled from the live
 * quote; the rate; four rows; one button. Slippage is behind the cog. The
 * review and its confirm are unchanged: this view only composes.
 */
function Compose({ state, panel }: { state: ExchangeState; panel: ExchangeMachine }) {
  if (state.balances !== 'loaded') return <div className="panel-balance"><p>{state.balances === 'loading' ? COPY.balance.loading : COPY.balance.unrequested}</p><button type="button" onClick={() => void panel.refreshBalances()}>{state.balances === 'failed' ? COPY.balance.refreshAgain : COPY.balance.refresh}</button></div>;
  const { sell, buy } = state;
  const preparing = state.flow.name === 'preparing';
  const holding = sell ? holdingOf(state, sell.token) : null;
  // Max leaves the pool fee behind only when the sell asset is the fee's own
  // token (a swap's whole cost is the pool fee, D-084); the wallet may pay the
  // fee from another token, so a typed amount above it is still allowed.
  const reserve = sell ? feeReserve(sell.token, state.pool) : null;
  const max = () => maxAfterReserve(maxBasis(holding), reserve);
  const maximum = max();
  const reserved = maximum !== null && reserve !== null && reserve > 0n && sell !== null
    && state.amountText === formatTokenAmountExact(maximum, sell.decimals);
  const request = swapRequest(state);
  const quote = currentQuote(state.live, request?.key ?? null);
  const check = checkAmount(state.amountText, { decimals: sell?.decimals ?? 18, balance: holding?.total ?? null });
  const slippage = parseSlippage(state.slippageText, state.slippageCeilingBps);
  const action = check.status === 'ok' && slippage.status !== 'ok'
    ? { label: COPY.exchange.slippageFix, disabled: true }
    : primaryAction({ check, symbol: sell?.symbol ?? null, ready: COPY.exchange.review, busy: preparing ? COPY.flow.preparing : null });
  return <form className="panel-compose exchange-swap" onSubmit={(event) => { event.preventDefault(); void panel.prepare(); }}>
    <div className="exchange-swap-bar"><SlippageCog state={state} onChange={(value) => panel.setSlippage(value)} /></div>
    <AmountField
      label={COPY.exchange.sell}
      value={state.amountText}
      onChange={(value) => panel.setAmount(value)}
      decimals={sell?.decimals ?? 18}
      symbol={sell?.symbol ?? ''}
      token={<TokenSelect label={COPY.exchange.sellToken} labelHidden value={sell?.token ?? ''} placeholder={COPY.exchange.chooseAsset} options={state.sellChoices.map((asset) => tokenOption(state, asset))} onChange={(token) => panel.setSell(token)} />}
      balance={holding?.total ?? null}
      {...(sell ? { max, half: true } : {})}
      usd={quote?.summary.sellUsd ?? null}
      hint={reserved ? COPY.balance.feeReserved : null}
    />
    <FlipButton onFlip={() => panel.flip()} disabled={preparing || !canFlip(state)} />
    <AmountField
      label={COPY.exchange.buy}
      name="buy-amount"
      readOnly
      value={quote && buy ? formatOutput(quote.expectedAmountOut, buy.decimals) : ''}
      onChange={() => {}}
      decimals={buy?.decimals ?? 18}
      symbol={buy?.symbol ?? ''}
      token={<TokenSelect label={COPY.exchange.buyToken} labelHidden value={buy?.token ?? ''} options={buyChoices(state).map((asset) => tokenOption(state, asset))} onChange={(token) => panel.setBuy(token)} />}
      usd={quote?.summary.expectedBuyUsd ?? null}
      busy={request !== null && state.live.status === 'quoting'}
      stale={quote?.stale ?? false}
      hint={request === null ? null : liveNote(state.live, quote)}
    />
    {quote && sell ? <QuoteDetails quote={quote} feeInSellToken={reserve !== null && reserve > 0n} /> : null}
    <button type="submit" disabled={action.disabled || !buy}>{action.label}</button>
  </form>;
}

type ReadyQuote = Extract<LiveQuote, { status: 'ready' }>;

/** The live quote, if it answers the swap on show now. */
function currentQuote(live: LiveQuote, key: string | null): ReadyQuote | null {
  return live.status === 'ready' && key !== null && live.key === key ? live : null;
}

/** The Buy field's line under the figure: why there is none, or that it ran out. */
function liveNote(live: LiveQuote, quote: ReadyQuote | null): string | null {
  if (quote?.stale) return COPY.exchange.quoteStale;
  if (live.status === 'quoting') return COPY.exchange.quoting;
  if (live.status === 'paused') return COPY.exchange.quotePaused;
  if (live.status === 'failed') return live.message;
  return null;
}

/** At most eight decimal places of the quoted output, truncated: never more than avnu said. */
function formatOutput(amount: bigint, decimals: number): string {
  const exact = formatTokenAmountExact(amount, decimals);
  const [whole, fraction] = exact.split('.');
  const trimmed = fraction ? fraction.slice(0, 8).replace(/0+$/, '') : '';
  return trimmed ? `${whole}.${trimmed}` : whole!;
}

/** The rate, invertible, and the four rows a swap app shows under it. */
function QuoteDetails({ quote, feeInSellToken }: { quote: ReadyQuote; feeInSellToken: boolean }) {
  const impact = quote.priceImpactBps;
  const highImpact = impact !== null && impact > PRICE_IMPACT_WARN_BPS;
  const rows: DetailRow[] = [
    { id: 'minimum', label: COPY.exchange.receiveAtLeast, value: quote.summary.protectedMinimum, tone: 'emphasis' },
    {
      id: 'impact',
      label: COPY.exchange.priceImpact,
      value: impact === null ? COPY.exchange.priceImpactUnknown : `${(impact / 100).toFixed(2)}%`,
      ...(highImpact ? { tone: 'warning' as const, note: COPY.exchange.priceImpactHigh } : {}),
    },
    {
      id: 'fee',
      label: COPY.bank.poolFee,
      value: quote.summary.poolFee,
      ...(feeInSellToken ? {} : { note: COPY.exchange.poolFeeToken }),
    },
    { id: 'route', label: COPY.exchange.route, value: COPY.exchange.routeAvnu },
  ];
  return <div className="exchange-quote" data-stale={quote.stale ? 'true' : undefined}>
    <p className="exchange-rate"><span className="ui-visually-hidden">{COPY.exchange.rate}: </span><InvertibleRate forward={quote.summary.rate} inverse={quote.summary.inverseRate} /></p>
    <DetailRows rows={rows} />
  </div>;
}

/** The slippage cog (D-089): 0.1%, 0.5%, 1% and a custom value, up to the build's ceiling. */
function SlippageCog({ state, onChange }: { state: ExchangeState; onChange: (value: string) => void }) {
  const presets = SLIPPAGE_PRESETS_BPS
    .filter((bps) => bps <= state.slippageCeilingBps)
    .map((bps) => ({ value: bpsText(bps), label: `${bpsText(bps)}%` }));
  const check = parseSlippage(state.slippageText, state.slippageCeilingBps);
  const warning = check.status === 'over' ? COPY.exchange.slippageOver.replace('{cap}', bpsText(check.ceilingBps))
    : check.status === 'zero' || check.status === 'empty' ? COPY.exchange.slippageZero
      : check.status === 'invalid' ? COPY.exchange.slippageInvalid
        : check.status === 'ok' && check.bps > SLIPPAGE_WARN_BPS ? COPY.exchange.slippageHigh
          : null;
  return <SettingsPopover
    title={COPY.exchange.slippageTitle}
    presets={presets}
    value={state.slippageText}
    onChange={onChange}
    custom={{ label: COPY.exchange.slippageCustom, unit: '%' }}
    hint={COPY.exchange.slippageHint}
    warning={warning}
  />;
}

/**
 * The degen floor's compose surface (D-067): its list's state, the honest
 * intro, the same compose form as downstairs over the degen list, and every
 * listed token with avnu's tags.
 */
function DegenCompose({ state, onRetry, children }: { state: ExchangeState; onRetry: () => void; children: ReactNode }) {
  const catalog = state.catalog;
  if (catalog.status === 'failed') {
    return <div role="alert"><p>{COPY.degen.unavailable}</p><button type="button" onClick={onRetry}>{COPY.degen.retry}</button></div>;
  }
  if (catalog.status !== 'ready') return <p className="flow-pending" role="status">{COPY.degen.loading}</p>;
  return <>
    <p className="panel-intro degen-intro">{COPY.degen.intro}</p>
    {catalog.origin === 'curated' ? <p className="panel-notice" role="note">{COPY.degen.curatedOnly}</p> : null}
    {catalog.origin === 'demo' ? <p className="panel-notice degen-demo-note" role="note">{COPY.degen.demo}</p> : null}
    {children}
    <DegenBoard assets={catalog.assets} />
  </>;
}

/** Every listed token, with avnu's tags as chips and display-only tokens marked. */
function DegenBoard({ assets }: { assets: readonly ExchangeAsset[] }) {
  const heading = useId();
  const displayOnly = assets.some((asset) => !isSwappable(asset));
  return <section className="degen-board" aria-labelledby={heading}>
    <h3 id={heading}>{COPY.degen.listTitle}</h3>
    <p className="degen-board-note">{COPY.degen.tags}</p>
    {/* Scrolls on its own, so it is focusable for keyboard scrolling. */}
    <div className="degen-board-scroll" role="region" aria-labelledby={heading} tabIndex={0}>
      <ul className="degen-token-list">
        {assets.map((asset) => {
          const swappable = isSwappable(asset);
          const tags = asset.tags ?? [];
          return <li key={asset.token} className="degen-token" data-display-only={swappable ? undefined : 'true'}>
            <span className="degen-token-symbol">{asset.symbol}</span>
            {asset.name ? <span className="degen-token-name">{asset.name}</span> : null}
            {tags.length > 0 || !swappable ? <span className="degen-chips">
              {tags.map((tag) => <span key={tag} className="degen-chip" data-tag={tag.toLowerCase()}>{tag}</span>)}
              {swappable ? null : <span className="degen-chip" data-tag="display-only">{COPY.degen.displayOnly}</span>}
            </span> : null}
          </li>;
        })}
      </ul>
    </div>
    {displayOnly ? <p className="degen-board-note">{COPY.degen.displayOnlyNote}</p> : null}
  </section>;
}

function Review({ state, onConfirm, onCancel, onAcknowledge }: { state: ExchangeState; onConfirm: () => void; onCancel: () => void; onAcknowledge: (value: boolean) => void }) {
  const flow = state.flow; if (flow.name !== 'review' && flow.name !== 'submitting') return null;
  const review = flow.summary;
  const unchecked = review.priceCheck === 'unchecked';
  return <div className="exchange-review">{flow.name === 'submitting' ? <p aria-live="polite">{flow.message}</p> : null}<ConfirmGate disclosures={review.disclosures} requiresDisclosure busy={flow.name === 'submitting'} onConfirm={onConfirm} onCancel={onCancel}><dl>
    <dt>{COPY.exchange.sell}</dt><dd>{review.sell}{review.sellUsd ? <span className="exchange-usd"> {review.sellUsd}</span> : null}</dd>
    <dt>{COPY.exchange.expectedBuy}</dt><dd>{review.expectedBuy}{review.expectedBuyUsd ? <span className="exchange-usd"> {review.expectedBuyUsd}</span> : null}</dd>
    <dt>{COPY.exchange.rate}</dt><dd>{review.rate}</dd>
    <dt>{COPY.exchange.priceCheck}</dt><dd className="exchange-price-check" data-status={review.priceCheck}>{review.priceCheckNote}</dd>
    <dt><GlossaryTerm term={COPY.exchange.protectedMinimum} definition={COPY.glossary.protectedMinimum} /></dt><dd>{review.protectedMinimum}</dd>
    <dt><GlossaryTerm term={COPY.exchange.slippage} definition={<>{COPY.glossary.slippageFixedAt} {review.slippage} {COPY.glossary.slippageReason}</>} /></dt><dd>{review.slippage}</dd>
    <dt><GlossaryTerm term={COPY.exchange.expiresAt} definition={COPY.glossary.quoteExpiry} /></dt><dd>{review.expiresAt}</dd>
    <dt><GlossaryTerm term={COPY.bank.poolFee} definition={COPY.glossary.poolFee} /></dt><dd>{review.poolFee}</dd>
    <dt><GlossaryTerm term={COPY.bank.networkCost} definition={COPY.glossary.networkCost} /></dt><dd>{review.networkCost}</dd>
    <dt>{COPY.bank.total}</dt><dd>{review.total}</dd>
  </dl>{unchecked ? <label className="exchange-acknowledge" role="alert"><input type="checkbox" checked={state.priceAcknowledged} disabled={flow.name === 'submitting'} onChange={(event) => onAcknowledge(event.target.checked)} /> {COPY.exchange.acknowledgeUnchecked}</label> : null}</ConfirmGate></div>;
}
