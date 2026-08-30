import { useEffect, useMemo } from 'react';
import { COPY } from '../../copy.js';
import { usePrivacy } from '../../privacy/PrivacyProvider.js';
import { useStore } from '../../store/use-store.js';
import { ConfirmGate } from '../ConfirmGate.js';
import { LockedNotice } from '../LockedRoom.js';
import { PanelFrame } from '../PanelFrame.js';
import { EXCHANGE_CATALOG } from './catalog.js';
import { createExchangePanel, type ExchangePanel as ExchangeMachine, type ExchangeState } from './exchange-machine.js';
import { WalletAttentionCue, walletOperationAttention } from '../../wallet/WalletAttentionCue.js';
import { createPendingHudOwner } from '../pending-hud.js';

/** Dedicated one-swap view; this deliberately has no batch/add vocabulary. */
export function ExchangePanel({ onClose, panel: injected, experience = 'menu' }: { onClose: () => void; panel?: ExchangeMachine; experience?: 'menu' | 'station' }) {
  const { operations, receipts, noteOperationError, shellBus, submissionUncertainty } = usePrivacy();
  const owned = useMemo(() => injected ? null : createExchangePanel({
    operations, receipts, onError: noteOperationError,
    canStartFinancialAction: () => { const state = submissionUncertainty.store.getState(); return !state.active || state.acknowledged; },
  }), [injected, operations, receipts, noteOperationError, submissionUncertainty]);
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
  return <div className="exchange-experience" data-experience={experience}>
    <WalletAttentionCue active={walletAttention !== null} kind={walletAttention ?? 'confirm'} />
    <PanelFrame title={COPY.buildings.exchange} disclosure={null} closingNote={state.flow.name === 'submitting' ? COPY.flow.closingWillNotCancel : null} onClose={onClose}>
      <p className="panel-hint">{COPY.exchange.oneSwap}</p>
      {!state.door.open ? <LockedNotice reason={state.door.reason ?? 'unknown-route'} message={state.door.message} /> :
        state.flow.name === 'submitted' ? <div className="flow-done"><p>{COPY.flow.submitted} <code>{state.flow.transactionHash}</code></p><button type="button" onClick={() => panel.acknowledge()}>{COPY.flow.back}</button></div> :
        blocked ? null : committing ? <Review state={state} onConfirm={() => void panel.confirm()} onCancel={() => panel.cancelPrepared()} /> :
        state.flow.name === 'failed' && state.flow.recovery === 'close' ? <p role="alert">{state.flow.message}</p> :
        <Compose state={state} onBalance={() => void panel.refreshBalances()} onSell={(token) => panel.setSell(token)} onBuy={(token) => panel.setBuy(token)} onAmount={(value) => panel.setAmount(value)} onReview={() => void panel.prepare()} />}
      {state.notice ? <p className="panel-notice" role="status">{state.notice}</p> : null}
      {state.flow.name === 'failed' && state.flow.recovery === 'prepare-again' ? <div role="alert"><p>{state.flow.message}</p><button type="button" onClick={() => panel.cancelPrepared()}>{COPY.flow.back}</button></div> : null}
    </PanelFrame>
  </div>;
}

function Compose({ state, onBalance, onSell, onBuy, onAmount, onReview }: { state: ExchangeState; onBalance: () => void; onSell: (token: string) => void; onBuy: (token: string) => void; onAmount: (value: string) => void; onReview: () => void }) {
  if (state.balances !== 'loaded') return <div className="panel-balance"><p>{state.balances === 'loading' ? COPY.balance.loading : COPY.balance.unrequested}</p><button type="button" onClick={onBalance}>{state.balances === 'failed' ? COPY.balance.refreshAgain : COPY.balance.refresh}</button></div>;
  return <form className="panel-compose" onSubmit={(event) => { event.preventDefault(); onReview(); }}>
    <label>{COPY.exchange.sell}<select value={state.sell?.token ?? ''} onChange={(event) => onSell(event.target.value)}><option value="">{COPY.exchange.chooseAsset}</option>{state.sellChoices.map((asset) => <option key={asset.token} value={asset.token}>{asset.symbol}</option>)}</select></label>
    <label>{COPY.exchange.buy}<select value={state.buy?.token ?? ''} onChange={(event) => onBuy(event.target.value)}>{EXCHANGE_CATALOG.filter((asset) => !state.sell || asset.token !== state.sell.token).map((asset) => <option key={asset.token} value={asset.token}>{asset.symbol}</option>)}</select></label>
    <label>{COPY.bank.amount}<input name="amount" inputMode="decimal" autoComplete="off" value={state.amountText} onChange={(event) => onAmount(event.target.value)} /></label>
    <button type="submit" disabled={!state.sell || !state.buy || state.flow.name === 'preparing'}>{state.flow.name === 'preparing' ? COPY.flow.preparing : COPY.flow.review}</button>
  </form>;
}

function Review({ state, onConfirm, onCancel }: { state: ExchangeState; onConfirm: () => void; onCancel: () => void }) {
  const flow = state.flow; if (flow.name !== 'review' && flow.name !== 'submitting') return null;
  const review = flow.summary;
  return <div className="exchange-review">{flow.name === 'submitting' ? <p aria-live="polite">{flow.message}</p> : null}<ConfirmGate disclosures={review.disclosures} requiresDisclosure busy={flow.name === 'submitting'} onConfirm={onConfirm} onCancel={onCancel}><dl><dt>{COPY.exchange.sell}</dt><dd>{review.sell}</dd><dt>{COPY.exchange.expectedBuy}</dt><dd>{review.expectedBuy}</dd><dt>{COPY.exchange.protectedMinimum}</dt><dd>{review.protectedMinimum}</dd><dt>{COPY.exchange.slippage}</dt><dd>{review.slippage}</dd><dt>{COPY.exchange.expiresAt}</dt><dd>{review.expiresAt}</dd><dt>{COPY.bank.poolFee}</dt><dd>{review.poolFee}</dd><dt>{COPY.bank.networkCost}</dt><dd>{review.networkCost}</dd><dt>{COPY.bank.total}</dt><dd>{review.total}</dd></dl></ConfirmGate></div>;
}
