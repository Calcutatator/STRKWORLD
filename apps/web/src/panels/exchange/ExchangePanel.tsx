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
import { buyChoices, createExchangePanel, type ExchangePanel as ExchangeMachine, type ExchangeState } from './exchange-machine.js';
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
export function ExchangePanel({ onClose, panel: injected, experience = 'menu', mode = 'ground', register = PRIVACY_REGISTER, counters = null }: { onClose: () => void; panel?: ExchangeMachine; experience?: 'menu' | 'station'; mode?: ExchangeMode; register?: readonly RouteGrade[]; /** Menu Mode's counter tabs (D-088); presentation only. */ counters?: ReactNode }) {
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
  const compose = <Compose state={state} onBalance={() => void panel.refreshBalances()} onSell={(token) => panel.setSell(token)} onBuy={(token) => panel.setBuy(token)} onAmount={(value) => panel.setAmount(value)} onReview={() => void panel.prepare()} />;
  return <div className="exchange-experience" data-experience={experience} data-mode={mode}>
    <WalletAttentionCue active={walletAttention !== null} kind={walletAttention ?? 'confirm'} />
    <PanelFrame title={COPY.buildings.exchange} building="exchange" brand={degen ? 'degen' : undefined} disclosure={null} closingNote={state.flow.name === 'submitting' ? COPY.flow.closingWillNotCancel : null} onClose={onClose} counters={counters}>
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

/** An option's text: the ticker, and the name where the list gives one (the degen floor). */
function assetLabel(asset: ExchangeAsset): string {
  return asset.name ? `${asset.symbol} · ${asset.name}` : asset.symbol;
}

function Compose({ state, onBalance, onSell, onBuy, onAmount, onReview }: { state: ExchangeState; onBalance: () => void; onSell: (token: string) => void; onBuy: (token: string) => void; onAmount: (value: string) => void; onReview: () => void }) {
  if (state.balances !== 'loaded') return <div className="panel-balance"><p>{state.balances === 'loading' ? COPY.balance.loading : COPY.balance.unrequested}</p><button type="button" onClick={onBalance}>{state.balances === 'failed' ? COPY.balance.refreshAgain : COPY.balance.refresh}</button></div>;
  return <form className="panel-compose" onSubmit={(event) => { event.preventDefault(); onReview(); }}>
    <label>{COPY.exchange.sell}<select value={state.sell?.token ?? ''} onChange={(event) => onSell(event.target.value)}><option value="">{COPY.exchange.chooseAsset}</option>{state.sellChoices.map((asset) => <option key={asset.token} value={asset.token}>{assetLabel(asset)}</option>)}</select></label>
    <label>{COPY.exchange.buy}<select value={state.buy?.token ?? ''} onChange={(event) => onBuy(event.target.value)}>{buyChoices(state).map((asset) => <option key={asset.token} value={asset.token}>{assetLabel(asset)}</option>)}</select></label>
    <label>{COPY.bank.amount}<input name="amount" inputMode="decimal" autoComplete="off" value={state.amountText} onChange={(event) => onAmount(event.target.value)} /></label>
    <button type="submit" disabled={!state.sell || !state.buy || state.flow.name === 'preparing'}>{state.flow.name === 'preparing' ? COPY.flow.preparing : COPY.flow.review}</button>
  </form>;
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
