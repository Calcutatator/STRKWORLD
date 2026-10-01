import { useEffect, useMemo } from 'react';
import type { BorrowHealth, BorrowPosition } from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import {
  formatRatePercent,
  formatStrkExact,
  formatTokenAmount,
  formatTokenAmountExact,
  sameAddress,
  shortenAddress,
} from '../../format.js';
import { usePrivacy } from '../../privacy/PrivacyProvider.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import { STRK_TOKEN } from '../../production/config.js';
import { useStore } from '../../store/use-store.js';
import { WalletAttentionCue } from '../../wallet/WalletAttentionCue.js';
import { ConfirmGate } from '../ConfirmGate.js';
import { GlossaryTerm } from '../Glossary.js';
import { LockedNotice } from '../LockedRoom.js';
import { PanelFrame } from '../PanelFrame.js';
import { createPendingHudOwner } from '../pending-hud.js';
import { voyagerContractUrl } from '../vault/vault-machine.js';
import {
  BORROW_MODES,
  borrowPairChoices,
  createBorrowPanel,
  loanFor,
  maxLtvFor,
  type BorrowMode,
  type BorrowPairChoice,
  type BorrowPanel as BorrowPanelMachine,
  type BorrowState,
  type BorrowTokenView,
} from './borrow-machine.js';

/** Vesu's × 10^18 fraction as a percentage: "68.00%". */
export function formatLtv(value: bigint): string {
  return formatRatePercent(value, 18);
}

/** A health factor, × 10^18, to two places, truncated: "2.94". */
export function formatHealth(value: bigint): string {
  return formatTokenAmount(value, 18, 2);
}

/** A USD price, × 10^18: two places from $1 up, six below, truncated: "$83579.75", "$0.014704". */
export function formatUsd(value: bigint): string {
  return `$${formatTokenAmount(value, 18, value >= 10n ** 18n ? 2 : 6)}`;
}

function formatHolding(amount: bigint, token: BorrowTokenView): string {
  return `${formatTokenAmount(amount, token.decimals, Math.min(token.decimals, 8))} ${token.symbol}`;
}

function formatExact(amount: bigint, token: BorrowTokenView): string {
  return `${formatTokenAmountExact(amount, token.decimals)} ${token.symbol}`;
}

/**
 * The Borrow counter (D-083): Vesu loans in its Prime pool from the player's
 * second STRK20 shadow account, in the Vault's room and in Vesu's look.
 *
 * A thin view over `borrow-machine.ts`, like the Vault over its own. The
 * route's approved disclosure, which says the loan is public and can be
 * liquidated, is previewed while composing and carried by `ConfirmGate` at
 * the commit point; the risk lines say how liquidation works; each loan
 * shows its LTV against its max, its health and its liquidation price, and a
 * loan near liquidation is flagged plainly.
 */
export function BorrowPanel({
  onClose,
  panel: injected,
  register = PRIVACY_REGISTER,
}: {
  onClose: () => void;
  /** Supply a driven machine to render a specific state. Tests use this. */
  panel?: BorrowPanelMachine;
  register?: readonly RouteGrade[];
}) {
  const { operations, receipts, noteOperationError, shellBus, submissionUncertainty } = usePrivacy();
  const owned = useMemo(
    () =>
      injected
        ? null
        : createBorrowPanel({
            operations,
            receipts,
            register,
            onError: noteOperationError,
            canStartFinancialAction: () => {
              const current = submissionUncertainty.store.getState();
              return !current.active || current.acknowledged;
            },
          }),
    [injected, operations, receipts, register, noteOperationError, submissionUncertainty],
  );
  const panel = injected ?? owned!;
  const state = useStore(panel.store);
  const uncertaintyState = useStore(submissionUncertainty.store);
  const pendingHud = useMemo(() => createPendingHudOwner(shellBus), [shellBus]);

  useEffect(() => {
    if (!owned) return;
    void owned.open();
    return () => owned.close();
  }, [owned]);

  const pending = state.flow.name === 'preparing' || state.flow.name === 'submitting';
  useEffect(() => {
    pendingHud.setBusy(pending);
  }, [pendingHud, pending]);
  useEffect(() => () => pendingHud.release(), [pendingHud]);

  const committing = state.flow.name === 'review' || state.flow.name === 'submitting';
  const gateBlocked = uncertaintyState.active && !uncertaintyState.acknowledged;
  const attention = state.loans.status === 'loading'
    ? 'connect'
    : state.flow.name === 'submitting' && state.flow.stage === 'awaiting-approval'
      ? 'confirm'
      : null;

  return (
    <div className="vault-experience borrow-experience" data-experience="station">
      <WalletAttentionCue active={attention !== null} kind={attention ?? 'confirm'} />
      <PanelFrame
        title={COPY.buildings.vault}
        building="vault"
        disclosure={committing ? null : state.disclosure}
        closingNote={state.flow.name === 'submitting' ? COPY.flow.closingWillNotCancel : null}
        onClose={onClose}
      >
        <BorrowIntro state={state} />
        <ModeTabs state={state} onSelect={(mode) => panel.setMode(mode)} />

        {!state.door.open ? (
          <LockedNotice reason={state.door.reason ?? 'unknown-route'} message={state.door.message} />
        ) : state.tokens.length < 2 ? (
          <LockedNotice reason="not-enabled" message={COPY.borrow.noPair} />
        ) : state.capability.status === 'checking' ? (
          <p className="vault-checking" aria-busy="true">{COPY.borrow.checking}</p>
        ) : state.capability.status === 'unsupported' ? (
          <p className="vault-unsupported" role="alert">{COPY.errors['shadow-accounts-unsupported']}</p>
        ) : state.capability.status === 'failed' ? (
          <div className="flow-failed" role="alert">
            <p>{state.capability.message}</p>
            <button type="button" onClick={() => void panel.recheck()}>{COPY.borrow.recheck}</button>
          </div>
        ) : (
          <>
            <LoansBlock state={state} onRefresh={() => void panel.refreshLoans()} />
            <RiskBlock />
            {gateBlocked && state.flow.name === 'review' ? null : committing ? (
              <CommitBlock state={state} onConfirm={() => void panel.confirm()} onCancel={() => panel.cancelPrepared()} />
            ) : state.flow.name === 'submitted' ? (
              <SubmittedBlock state={state} onBack={() => panel.acknowledge()} />
            ) : gateBlocked || (state.flow.name === 'failed' && state.flow.recovery === 'close') ? null : (
              <ComposeBlock state={state} panel={panel} />
            )}
            {state.flow.name === 'failed' ? (
              <div className="flow-failed" role="alert">
                <p>{state.flow.message}</p>
                {state.flow.recovery === 'prepare-again' ? (
                  <button type="button" onClick={() => panel.cancelPrepared()}>{COPY.flow.back}</button>
                ) : null}
              </div>
            ) : null}
          </>
        )}

        {state.notice ? (
          <p className={`panel-notice notice-${state.notice.tone}`} role="status">
            {state.notice.text}
          </p>
        ) : null}
      </PanelFrame>
    </div>
  );
}

function BorrowIntro({ state }: { state: BorrowState }) {
  const moved = state.pair === null ? undefined : state.mode === 'repay' || state.mode === 'borrow' ? state.pair.debt : state.pair.collateral;
  const otherToken = moved !== undefined && !sameAddress(moved, STRK_TOKEN);
  return (
    <div className="vault-intro borrow-intro">
      <p className="vault-eyebrow">{COPY.borrow.eyebrow}</p>
      <p className="panel-intro">{COPY.borrow.intro}</p>
      <p className="vault-note">{COPY.borrow.feeNote}</p>
      {otherToken ? <p className="vault-note vault-fee-token">{COPY.borrow.feeInStrk}</p> : null}
    </div>
  );
}

function ModeTabs({ state, onSelect }: { state: BorrowState; onSelect: (mode: BorrowMode) => void }) {
  return (
    <nav className="panel-modes borrow-modes" role="tablist">
      {BORROW_MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          role="tab"
          aria-selected={state.mode === mode}
          data-locked={state.door.open ? undefined : 'true'}
          onClick={() => onSelect(mode)}
        >
          {COPY.borrow.modes[mode]}
        </button>
      ))}
    </nav>
  );
}

/** How Vesu liquidates a loan, in three plain lines, beside every form. */
function RiskBlock() {
  return (
    <section className="borrow-risk" aria-label={COPY.borrow.risk.title}>
      <h3>{COPY.borrow.risk.title}</h3>
      {COPY.borrow.risk.lines.map((line) => <p key={line}>{line}</p>)}
    </section>
  );
}

function tokenOf(state: BorrowState, token: string): BorrowTokenView | undefined {
  return state.tokens.find((entry) => sameAddress(entry.token, token));
}

/**
 * The loans, read when the player asks: each with its collateral and debt,
 * its LTV against the pair's max, its health and the price at which it turns
 * liquidatable, and the band it is in. The stand-in address is public, and
 * the line under the loans says so.
 */
function LoansBlock({ state, onRefresh }: { state: BorrowState; onRefresh: () => void }) {
  const { loans, market } = state;
  return (
    <div className="panel-balance vault-position borrow-loans">
      <h3>{COPY.borrow.loans.title}</h3>
      {market.status === 'loading' ? <p className="borrow-market-note" aria-busy="true">{COPY.borrow.market.loading}</p> : null}
      {market.status === 'failed' ? <p className="borrow-market-note" role="alert">{COPY.borrow.market.failed}</p> : null}
      {loans.status === 'unrequested' ? (
        <>
          <p>{COPY.borrow.loans.unrequested}</p>
          <button type="button" onClick={onRefresh}>{COPY.borrow.loans.show}</button>
        </>
      ) : loans.status === 'loading' ? (
        <p aria-busy="true">{COPY.borrow.loans.loading}</p>
      ) : loans.status === 'failed' ? (
        <>
          <p role="alert">{loans.message}</p>
          <button type="button" onClick={onRefresh}>{COPY.borrow.loans.again}</button>
        </>
      ) : (
        <>
          {loans.positions.length === 0 ? <p>{COPY.borrow.loans.empty}</p> : (
            <ul className="borrow-loan-list">
              {loans.positions.map((loan) => {
                const collateral = tokenOf(state, loan.collateral);
                const debt = tokenOf(state, loan.debt);
                if (!collateral || !debt) return null;
                return <LoanRow key={`${loan.collateral}:${loan.debt}`} loan={loan} collateral={collateral} debt={debt} />;
              })}
            </ul>
          )}
          <p className="vault-as-of">{COPY.borrow.loans.asOf}</p>
          <button type="button" onClick={onRefresh}>{COPY.borrow.loans.again}</button>
          <StandInLine address={loans.standIn} />
        </>
      )}
    </div>
  );
}

function LoanRow({ loan, collateral, debt }: { loan: BorrowPosition; collateral: BorrowTokenView; debt: BorrowTokenView }) {
  return (
    <li className="borrow-loan" data-band={loan.health.band}>
      <p className="vault-market-head">
        <strong className="vault-market-symbol">{`${collateral.symbol} → ${debt.symbol}`}</strong>
        <span className="borrow-band" data-band={loan.health.band}>{COPY.borrow.bands[loan.health.band]}</span>
      </p>
      <dl className="vault-figures">
        <dt>{COPY.borrow.loans.collateral}</dt>
        <dd>{formatHolding(loan.collateralAmount, collateral)}</dd>
        <dt>{COPY.borrow.loans.debt}</dt>
        <dd className="balance-total">{formatHolding(loan.debtAmount, debt)}</dd>
      </dl>
      <HealthFigures health={loan.health} collateral={collateral} debt={debt} />
    </li>
  );
}

/**
 * A health figure as the counter shows it: LTV against max with a bar, the
 * health factor, the liquidation price in words, and a plain warning in or
 * past the band near liquidation. A stale price shows no figure at all.
 */
export function HealthFigures({ health, collateral, debt }: { health: BorrowHealth; collateral: BorrowTokenView; debt: BorrowTokenView }) {
  if (health.status === 'stale-price') return <p className="borrow-stale" role="alert">{COPY.borrow.loans.stale}</p>;
  if (health.status === 'no-debt') {
    return <p className="borrow-health-none">{`${COPY.borrow.bands.none}. ${COPY.borrow.maxLtv} ${formatLtv(health.maxLtv)}`}</p>;
  }
  // The bar fills to the LTV's share of the max LTV, capped at full.
  const share = health.ltv !== null && health.maxLtv > 0n ? health.ltv * 1000n / health.maxLtv : 1000n;
  const width = `${Number(share > 1000n ? 1000n : share) / 10}%`;
  return (
    <div className="borrow-health" data-band={health.band}>
      <div className="borrow-ltv-bar" role="img" aria-label={`${COPY.borrow.loans.ltv} ${health.ltv === null ? '' : formatLtv(health.ltv)} / ${COPY.borrow.maxLtv} ${formatLtv(health.maxLtv)}`}>
        <span className="borrow-ltv-fill" style={{ width }} />
      </div>
      <dl className="vault-figures borrow-figures">
        <dt>{COPY.borrow.loans.ltv}</dt>
        <dd>{`${health.ltv === null ? '—' : formatLtv(health.ltv)} / ${COPY.borrow.maxLtv} ${formatLtv(health.maxLtv)}`}</dd>
        <dt>{COPY.borrow.loans.health}</dt>
        <dd>{health.healthFactor === null ? '—' : formatHealth(health.healthFactor)}</dd>
        {health.liquidationPrice !== null ? (
          <>
            <dt>{COPY.borrow.loans.liquidation}</dt>
            <dd>{formatUsd(health.liquidationPrice)}</dd>
          </>
        ) : null}
      </dl>
      {health.liquidationPrice !== null ? (
        <p className="borrow-liquidation-line">
          {`${COPY.borrow.loans.liquidationLead} ${collateral.symbol} ${COPY.borrow.loans.liquidationMid} ${formatUsd(health.liquidationPrice)} ${COPY.borrow.loans.liquidationAnd} ${debt.symbol} ${COPY.borrow.loans.liquidationTail}`}
        </p>
      ) : null}
      {health.band === 'warning' ? <p className="borrow-warning" role="alert">{COPY.borrow.warningNote}</p> : null}
      {health.band === 'liquidatable' ? <p className="borrow-warning borrow-danger" role="alert">{COPY.borrow.liquidatableNote}</p> : null}
    </div>
  );
}

function StandInLine({ address }: { address: string }) {
  const href = voyagerContractUrl(address);
  if (href === null) return null;
  return (
    <p className="vault-stand-in">
      {`${COPY.borrow.standIn.lead} `}
      <code>{shortenAddress(address)}</code>
      {`, ${COPY.borrow.standIn.tail} `}
      <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
        {COPY.borrow.standIn.voyager}
      </a>
      <span className="vault-stand-in-note">{COPY.borrow.standIn.voyagerNote}</span>
    </p>
  );
}

function pairLabel(state: BorrowState, pair: BorrowPairChoice): string {
  return `${tokenOf(state, pair.collateral)?.symbol ?? '?'} → ${tokenOf(state, pair.debt)?.symbol ?? '?'}`;
}

/**
 * The form. To borrow: the collateral and debt tokens of a pair Vesu offers
 * now, its max LTV, collateral to add (optional) and the amount to borrow. To
 * change a loan: the loan, then the amount or "everything".
 */
function ComposeBlock({ state, panel }: { state: BorrowState; panel: BorrowPanelMachine }) {
  const preparing = state.flow.name === 'preparing';
  const choices = borrowPairChoices(state);
  const pair = state.pair;
  if (state.mode === 'borrow' && state.market.status !== 'loaded') return null;
  if (!pair || choices.length === 0) {
    return <p className="vault-no-choice">{state.mode === 'borrow' ? COPY.borrow.noPair : COPY.borrow.noLoan}</p>;
  }
  const collateral = tokenOf(state, pair.collateral)!;
  const debt = tokenOf(state, pair.debt)!;
  const maxLtv = maxLtvFor(state, pair);
  const loan = loanFor(state, pair);
  const collaterals = state.tokens.filter((token) => choices.some((choice) => sameAddress(choice.collateral, token.token)));
  const debts = choices.filter((choice) => sameAddress(choice.collateral, pair.collateral));
  const amountToken = state.mode === 'borrow' || state.mode === 'repay' ? debt : collateral;
  const canAll = state.mode === 'repay' || state.mode === 'withdraw-collateral';
  return (
    <form
      className="panel-compose borrow-compose"
      onSubmit={(event) => {
        event.preventDefault();
        void panel.prepare();
      }}
    >
      {state.mode === 'borrow' ? (
        <div className="borrow-pair">
          <label>
            {COPY.borrow.collateral}
            <select
              name="collateral"
              value={collateral.token}
              disabled={preparing}
              onChange={(event) => {
                const next = choices.find((choice) => sameAddress(choice.collateral, event.target.value));
                if (next) panel.setPair(next.collateral, next.debt);
              }}
            >
              {collaterals.map((token) => <option key={token.token} value={token.token}>{token.symbol}</option>)}
            </select>
          </label>
          <label>
            {COPY.borrow.debt}
            <select name="debt" value={debt.token} disabled={preparing} onChange={(event) => panel.setPair(pair.collateral, event.target.value)}>
              {debts.map((choice) => <option key={choice.debt} value={choice.debt}>{tokenOf(state, choice.debt)?.symbol}</option>)}
            </select>
          </label>
        </div>
      ) : (
        <label>
          {COPY.borrow.loans.title}
          <select
            name="loan"
            value={`${pair.collateral}:${pair.debt}`}
            disabled={preparing}
            onChange={(event) => {
              const [c, d] = event.target.value.split(':');
              if (c && d) panel.setPair(c, d);
            }}
          >
            {choices.map((choice) => (
              <option key={`${choice.collateral}:${choice.debt}`} value={`${choice.collateral}:${choice.debt}`}>{pairLabel(state, choice)}</option>
            ))}
          </select>
        </label>
      )}
      {maxLtv !== undefined ? <p className="borrow-max-ltv">{`${COPY.borrow.maxLtv} ${formatLtv(maxLtv)}`}</p> : null}
      {loan ? <HealthFigures health={loan.health} collateral={collateral} debt={debt} /> : null}
      {state.mode === 'borrow' ? (
        <label>
          {`${COPY.borrow.collateralAmount} (${collateral.symbol})`}
          <input
            name="collateral-amount"
            inputMode="decimal"
            autoComplete="off"
            value={state.collateralText}
            onChange={(event) => panel.setCollateralAmount(event.target.value)}
          />
        </label>
      ) : null}
      {canAll ? (
        <label className="vault-all">
          <input type="checkbox" name="all" checked={state.all} onChange={(event) => panel.setAll(event.target.checked)} />
          {state.mode === 'repay' ? COPY.borrow.repayAll : COPY.borrow.withdrawAll}
        </label>
      ) : null}
      {canAll && state.all ? null : (
        <label>
          {`${state.mode === 'borrow' ? COPY.borrow.borrowAmount : COPY.borrow.amount} (${amountToken.symbol})`}
          <input
            name="amount"
            inputMode="decimal"
            autoComplete="off"
            value={state.amountText}
            onChange={(event) => panel.setAmount(event.target.value)}
          />
        </label>
      )}
      <button type="submit" className="review" disabled={preparing}>
        {preparing ? COPY.flow.preparing : COPY.gameMode.reviewAction}
      </button>
      <p className="panel-hint">{COPY.gameMode.singleAction}</p>
    </form>
  );
}

function CommitBlock({ state, onConfirm, onCancel }: { state: BorrowState; onConfirm: () => void; onCancel: () => void }) {
  const flow = state.flow;
  if (flow.name !== 'review' && flow.name !== 'submitting') return null;
  const { summary } = flow;
  const { action, collateral, debt } = summary;
  const rows: Array<[string, string]> = [];
  let note: string | null = null;
  let landsIn: BorrowTokenView | null = null;
  switch (action.kind) {
    case 'borrow':
      if (action.collateralAmount > 0n) rows.push([COPY.borrow.review.collateral, formatExact(action.collateralAmount, collateral)]);
      rows.push([COPY.borrow.review.borrow, formatExact(action.borrowAmount, debt)]);
      landsIn = debt;
      break;
    case 'add-collateral':
      rows.push([COPY.borrow.review.collateral, formatExact(action.amount, collateral)]);
      break;
    case 'repay':
      rows.push([action.all ? COPY.borrow.review.repayAll : COPY.borrow.review.repay, formatExact(action.amount, debt)]);
      if (action.all) note = COPY.borrow.review.bufferNote;
      break;
    case 'withdraw-collateral':
      rows.push([action.all ? COPY.borrow.review.withdrawAll : COPY.borrow.review.withdraw, formatExact(action.amount, collateral)]);
      if (action.all) note = COPY.borrow.review.withdrawAllNote;
      landsIn = collateral;
      break;
  }
  const moved = action.kind === 'borrow' || action.kind === 'repay' ? debt : collateral;
  return (
    <div className="panel-review borrow-review">
      <h3>{COPY.flow.review}</h3>
      <dl className="vault-review">
        {rows.map(([label, value]) => (
          <div key={label} className="borrow-review-row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {note || landsIn ? (
        <p className="vault-review-note">
          {note ? `${note} ` : ''}
          {landsIn ? `${COPY.borrow.review.landsInLead} ${landsIn.symbol} ${COPY.borrow.review.landsInTail}` : ''}
        </p>
      ) : null}
      <h4 className="borrow-after-title">{COPY.borrow.review.after}</h4>
      <HealthFigures health={summary.after} collateral={collateral} debt={debt} />
      <dl className="review-costs">
        <dt><GlossaryTerm term={COPY.bank.poolFee} definition={COPY.glossary.poolFee} /></dt>
        <dd title={COPY.bank.poolFeeNote}>{formatStrkExact(summary.poolFee)}</dd>
        <dt><GlossaryTerm term={COPY.bank.networkCost} definition={COPY.glossary.networkCost} /></dt>
        <dd>{COPY.borrow.review.networkByWallet}</dd>
      </dl>
      {!sameAddress(moved.token, STRK_TOKEN) ? <p className="vault-review-note vault-fee-token">{COPY.borrow.review.feeTokenByWallet}</p> : null}
      {flow.name === 'submitting' ? (
        <p className="flow-pending" aria-live="polite" data-stage={flow.stage}>{flow.message}</p>
      ) : null}
      <ConfirmGate
        disclosures={summary.disclosures}
        requiresDisclosure={summary.requiresDisclosure}
        busy={flow.name === 'submitting'}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </div>
  );
}

function SubmittedBlock({ state, onBack }: { state: BorrowState; onBack: () => void }) {
  const flow = state.flow;
  if (flow.name !== 'submitted') return null;
  const text = flow.restored ? COPY.borrow.submitted.pending : COPY.borrow.submitted[flow.outcome];
  return (
    <div className="flow-done" aria-live="polite" data-outcome={flow.restored ? 'pending' : flow.outcome}>
      <p>
        {text} <code>{shortenAddress(flow.transactionHash)}</code>
      </p>
      <button type="button" onClick={onBack}>{COPY.flow.back}</button>
    </div>
  );
}
