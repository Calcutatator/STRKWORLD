import { useEffect, useMemo, type ReactNode } from 'react';
import type { BorrowHealth, BorrowPosition } from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import {
  formatRatePercent,
  formatStrk,
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
import { AmountField, AmountSummary, BeforeAfter, checkAmount, primaryAction, totalAcross, type AmountCheck, type AmountSummaryProps, type DetailRow, type DetailTone } from '../kit/index.js';
import { usePoolFee } from '../pool-fee.js';
import { feeReserve, maxAfterReserve, maxBasis } from '../kit/amount-math.js';
import { createPendingHudOwner } from '../pending-hud.js';
import { voyagerContractUrl } from '../vault/vault-machine.js';
import {
  BORROW_MODES,
  borrowPairChoices,
  createBorrowPanel,
  loanFor,
  maxLtvFor,
  poolBalanceFor,
  takesEverything,
  tidyBorrowAmount,
  type BorrowMode,
  type BorrowPairChoice,
  type BorrowPanel as BorrowPanelMachine,
  type BorrowState,
  type BorrowTokenView,
} from './borrow-machine.js';
import { borrowCapacity, maxWithdraw, pairAssets, previewHealth, type BorrowLimitReason, type PreviewHealth, type PreviewLoan } from './borrow-preview.js';

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
  experience = 'station',
  modes = BORROW_MODES,
  counters = null,
}: {
  onClose: () => void;
  /** Supply a driven machine to render a specific state. Tests use this. */
  panel?: BorrowPanelMachine;
  register?: readonly RouteGrade[];
  /**
   * The counter's actions (D-103): BORROW's borrow and add collateral, or
   * REPAY's repay and withdraw collateral. Its tabs name only these.
   */
  modes?: readonly BorrowMode[];
  /** Presentation only: the counter and Menu Mode (D-088) render the same window. */
  experience?: 'menu' | 'station';
  /** Menu Mode's counter tabs (D-088); presentation only. */
  counters?: ReactNode;
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
            modes,
            onError: noteOperationError,
            canStartFinancialAction: () => {
              const current = submissionUncertainty.store.getState();
              return !current.active || current.acknowledged;
            },
          }),
    [injected, operations, receipts, register, modes, noteOperationError, submissionUncertainty],
  );
  const panel = injected ?? owned!;
  const state = useStore(panel.store);
  // D-103: the pool fee for the amounts under the form; the review shows the prepared one.
  const poolFee = usePoolFee(operations);
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
  const attention = state.loans.status === 'loading' || state.balances.status === 'loading'
    ? 'connect'
    : state.flow.name === 'submitting' && state.flow.stage === 'awaiting-approval'
      ? 'confirm'
      : null;

  return (
    <div className="vault-experience borrow-experience" data-experience={experience} data-mode={state.mode}>
      <WalletAttentionCue active={attention !== null} kind={attention ?? 'confirm'} />
      <PanelFrame
        title={COPY.buildings.vault}
        building="vault"
        disclosure={committing ? null : state.disclosure}
        closingNote={state.flow.name === 'submitting' ? COPY.flow.closingWillNotCancel : null}
        onClose={onClose}
        counters={counters}
      >
        <BorrowIntro state={state} />
        <ModeTabs state={state} modes={modes} onSelect={(mode) => panel.setMode(mode)} />

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
              <ComposeBlock state={state} panel={panel} poolFee={state.balances.status === 'loaded' && state.balances.fee ? state.balances.fee.feeAmount : poolFee} />
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

function ModeTabs({ state, modes, onSelect }: { state: BorrowState; modes: readonly BorrowMode[]; onSelect: (mode: BorrowMode) => void }) {
  return (
    <nav className="panel-modes borrow-modes" role="tablist">
      {modes.map((mode) => (
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
 * The loans, read when the counter opens (D-102) or again on request: each with its collateral and debt,
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
 * change a loan: the loan, then the amount.
 *
 * D-089, the lending touches (Aave's, nothing from a swap): once the loans
 * are read, "Available to borrow" with a Max that stops at a health factor of
 * 1.25, the health factor before → after and the price the loan turns
 * liquidatable at; a repay's Max is the debt and repays everything, a
 * withdrawal's is the most that keeps health at 1.25 (everything when nothing
 * is owed). The button says what is missing, and "Health factor too low"
 * where the seam would refuse an amount for D-083's 1.05 floor. The seam
 * still re-reads and decides; these figures only say it early.
 */
function ComposeBlock({ state, panel, poolFee }: { state: BorrowState; panel: BorrowPanelMachine; poolFee: bigint | null }) {
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
  const collaterals = state.tokens.filter((token) => choices.some((choice) => sameAddress(choice.collateral, token.token)));
  const debts = choices.filter((choice) => sameAddress(choice.collateral, pair.collateral));
  const amountToken = state.mode === 'borrow' || state.mode === 'repay' ? debt : collateral;
  const preview = previewFor(state, pair, collateral, debt);
  const action = preview.tooLow
    ? { label: COPY.borrow.form.tooLow, disabled: true }
    : preview.collateralCheck.status === 'invalid' || preview.collateralCheck.status === 'exceeds-balance'
      ? primaryAction({ check: preview.collateralCheck, symbol: collateral.symbol, ready: '' })
      : primaryAction({
          check: preview.check,
          symbol: amountToken.symbol,
          ready: COPY.gameMode.reviewAction,
          busy: preparing ? COPY.flow.preparing : null,
          ...(preview.exceeds ? { exceeds: preview.exceeds } : {}),
        });
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
      {state.mode === 'borrow' ? (
        <>
          <CollateralHeld state={state} pair={pair} collateral={collateral} />
          <AmountField
            label={COPY.borrow.collateralAmount}
            name="collateral-amount"
            value={state.collateralText}
            onChange={(text) => panel.setCollateralAmount(text)}
            decimals={collateral.decimals}
            symbol={collateral.symbol}
            balance={preview.pool.balance}
            {...(preview.pool.limit !== null ? { limit: preview.pool.limit, exceedsMessage: COPY.kit.exceedsWithFee } : {})}
            {...(preview.pool.max ? { max: preview.pool.max } : {})}
            hint={preview.pool.hint(state.collateralText)}
            disabled={preparing}
          />
          <PoolBalanceRead state={state} onRead={() => void panel.refreshBalances()} />
        </>
      ) : null}
      <AmountField
        label={state.mode === 'borrow' ? COPY.borrow.borrowAmount : COPY.borrow.amount}
        value={state.amountText}
        onChange={(text) => panel.setAmount(text)}
        decimals={amountToken.decimals}
        symbol={amountToken.symbol}
        balance={preview.balance}
        {...(preview.limit !== null ? { limit: preview.limit } : {})}
        {...(preview.balanceLabel ? { balanceLabel: preview.balanceLabel } : {})}
        {...(preview.exceeds ? { exceedsMessage: preview.exceeds } : {})}
        {...(preview.max ? { max: preview.max } : {})}
        hint={preview.hint === 'add-collateral'
          ? <AddCollateralFirst max={preview.pool.max} disabled={preparing} onFill={(amount) => panel.setCollateralAmount(formatTokenAmountExact(amount, collateral.decimals))} />
          : preview.hint}
        disabled={preparing}
      />
      {state.mode === 'add-collateral' ? <PoolBalanceRead state={state} onRead={() => void panel.refreshBalances()} /> : null}
      {state.mode === 'borrow' && (state.loans.status === 'unrequested' || state.loans.status === 'failed') ? <p className="borrow-read-loans">{COPY.borrow.form.readLoans}</p> : null}
      <AmountSummary {...composeSummary(state.mode, collateral, debt, preview, poolFee, preview.rows)} label={COPY.kit.amountsLabel} />
      <button type="submit" className="review" disabled={action.disabled}>
        {action.label}
      </button>
      <p className="panel-hint">{COPY.gameMode.singleAction}</p>
    </form>
  );
}

/**
 * What this pair already holds as collateral (D-102), "0 STRK" when nothing,
 * and the one line that says where collateral comes from: the pool balance,
 * here, never the Vault's supply, which sits on another stand-in by design.
 */
function CollateralHeld({ state, pair, collateral }: { state: BorrowState; pair: BorrowPairChoice; collateral: BorrowTokenView }) {
  const loan = loanFor(state, pair);
  const figure = state.loans.status === 'loaded'
    ? formatHolding(loan?.collateralAmount ?? 0n, collateral)
    : state.loans.status === 'loading' ? COPY.borrow.form.collateralReading : COPY.borrow.form.collateralUnread;
  return (
    <div className="borrow-collateral-held">
      <p>
        {`${COPY.borrow.form.yourCollateral}: `}
        <strong className="ui-figure">{figure}</strong>
      </p>
      <p className="vault-note borrow-collateral-source">{COPY.borrow.form.collateralSource}</p>
    </div>
  );
}

/** The pool balance collateral is added from, read on opening; a chip when it was declined or failed. */
function PoolBalanceRead({ state, onRead }: { state: BorrowState; onRead: () => void }) {
  const { balances } = state;
  if (balances.status === 'loaded') return null;
  return (
    <p className="vault-balance-read" data-status={balances.status}>
      {balances.status === 'loading' ? (
        <span aria-busy="true">{COPY.vault.form.balanceLoading}</span>
      ) : balances.status === 'failed' ? (
        <>
          <span role="alert">{COPY.vault.form.balanceUnavailable}</span>{' '}
          <button type="button" className="ui-chip" onClick={onRead}>{COPY.vault.form.balanceAgain}</button>
        </>
      ) : (
        <button type="button" className="ui-chip" onClick={onRead}>{COPY.vault.form.showBalance}</button>
      )}
    </p>
  );
}

/** With no collateral to borrow against: say so, and offer to fill the collateral from the pool balance. */
function AddCollateralFirst({ max, disabled, onFill }: { max: (() => bigint | null) | null; disabled: boolean; onFill: (amount: bigint) => void }) {
  const amount = max ? max() : null;
  return (
    <>
      {`${COPY.borrow.form.addCollateralFirst} `}
      {max ? (
        <button type="button" className="ui-chip borrow-max-collateral" disabled={disabled || amount === null} onClick={() => { if (amount !== null) onFill(amount); }}>
          {COPY.borrow.form.maxCollateral}
        </button>
      ) : null}
    </>
  );
}

function healthText(health: PreviewHealth): string {
  return health.status === 'priced' ? formatHealth(health.healthFactor) : COPY.borrow.form.noDebt;
}

function ltvText(health: PreviewHealth): string {
  return health.status === 'priced' && health.ltv !== null ? formatLtv(health.ltv) : '—';
}

function liquidationText(health: PreviewHealth): string {
  return health.status === 'priced' && health.liquidationPrice !== null ? formatUsd(health.liquidationPrice) : '—';
}

/** A figure now and after, or only now while nothing is typed. */
function figure(before: string, after: string | null): ReactNode {
  return after === null ? <span className="ui-figure">{before}</span> : <BeforeAfter before={before} after={after} />;
}

/** The after figure's tone, written out in words too (the kit's rule). */
function healthTone(health: PreviewHealth): { tone: DetailTone; note: string | null } {
  if (health.status !== 'priced') return { tone: 'default', note: null };
  switch (health.band) {
    case 'liquidatable':
      return { tone: 'danger', note: COPY.borrow.bands.liquidatable };
    case 'too-close':
      return { tone: 'danger', note: COPY.borrow.form.tooLow };
    case 'warning':
      return { tone: 'warning', note: COPY.borrow.bands.warning };
    default:
      return { tone: 'default', note: null };
  }
}

/**
 * The pool balance collateral is added from (D-102), and its Max: the
 * spendable figure where the wallet splits it, else the per-token total
 * (D-089's rule), less the pool fee when the collateral is STRK, tidied.
 */
function poolFieldFor(state: BorrowState, collateral: BorrowTokenView): {
  balance: bigint | null;
  /** D-103: the balance less the pool fee when the collateral is the fee token, so amount + fee fits. */
  limit: bigint | null;
  max: (() => bigint | null) | null;
  hint: (text: string) => string | null;
} {
  const held = poolBalanceFor(state, collateral.token);
  if (!held) return { balance: null, limit: null, max: null, hint: () => null };
  const fee = state.balances.status === 'loaded' ? state.balances.fee : null;
  const reserve = feeReserve(collateral.token, fee);
  const maximum = tidied(maxAfterReserve(maxBasis(held), reserve), collateral);
  return {
    balance: held.total,
    limit: reserve !== null && reserve > 0n ? held.total - reserve : null,
    max: () => maximum,
    hint: (text) => maximum !== null && reserve !== null && reserve > 0n && text === formatTokenAmountExact(maximum, collateral.decimals)
      ? COPY.balance.feeReserved
      : null,
  };
}

/**
 * The compose surface's figures (D-089, D-102), from the last loans, market
 * and pool-balance reads. With the loans unread there is no "before", so no
 * preview and no Max: an existing loan would change them all, and "Available
 * to borrow" says why instead of a figure.
 */
function previewFor(state: BorrowState, pair: BorrowPairChoice, collateral: BorrowTokenView, debt: BorrowTokenView): {
  check: AmountCheck;
  collateralCheck: AmountCheck;
  pool: ReturnType<typeof poolFieldFor>;
  balance: bigint | null;
  balanceLabel: string | null;
  exceeds: string | null;
  max: (() => bigint | null) | null;
  /** 'add-collateral' asks for collateral first, with a Max-collateral chip. */
  hint: string | 'add-collateral' | null;
  rows: DetailRow[];
  tooLow: boolean;
  limit: bigint | null;
  typed: bigint | null;
  added: bigint;
  everything: boolean;
} {
  const mode = state.mode;
  const loan = loanFor(state, pair);
  const known = state.loans.status === 'loaded';
  const market = state.market.status === 'loaded' ? state.market.market : null;
  const held: PreviewLoan | null = known ? { collateralAmount: loan?.collateralAmount ?? 0n, debtAmount: loan?.debtAmount ?? 0n } : null;
  const amountToken = mode === 'borrow' || mode === 'repay' ? debt : collateral;
  const pool = poolFieldFor(state, collateral);
  const collateralCheck = mode === 'borrow' ? checkAmount(state.collateralText, { decimals: collateral.decimals, balance: pool.limit ?? pool.balance }) : { status: 'empty' as const, amount: null };
  const added = collateralCheck.status === 'ok' ? collateralCheck.amount : 0n;
  let balance: bigint | null = null;
  let limit: bigint | null = null;
  let balanceLabel: string | null = null;
  let exceeds: string | null = null;
  let max: (() => bigint | null) | null = null;
  let maximum: bigint | null = null;
  // Why nothing can be borrowed, when nothing can (D-102).
  let why: BorrowLimitReason | 'loans-loading' | 'loans-unread' | null = null;
  if (mode === 'borrow' && !held) why = state.loans.status === 'loading' ? 'loans-loading' : 'loans-unread';
  if (mode === 'add-collateral') {
    balance = pool.balance;
    limit = pool.limit;
    max = pool.max;
  }
  if (held && market) {
    if (mode === 'borrow') {
      // Max on what is held plus what is being added: with the field empty, the collateral already held.
      const capacity = borrowCapacity(market, pair, { collateralAmount: held.collateralAmount + added, debtAmount: held.debtAmount });
      maximum = capacity.status === 'ok' ? tidied(capacity.amount, debt) : null;
      why = capacity.status === 'none' ? capacity.reason : maximum === null ? 'at-limit' : null;
      max = () => maximum;
    } else if (mode === 'withdraw-collateral' && loan) {
      maximum = tidied(maxWithdraw(market, pair, held, loan.health.maxLtv), collateral);
      max = () => maximum;
    }
  }
  if (held && loan && mode === 'repay') {
    balance = loan.debtAmount;
    balanceLabel = COPY.borrow.form.owed;
    exceeds = COPY.borrow.form.overDebt;
    const whole = tidied(loan.debtAmount, debt);
    // D-103: Max leaves the pool fee aside. When the pool balance of the debt
    // token, less the fee if it is the fee token, cannot cover the whole debt,
    // Max is what it can cover: a part repayment.
    const inPool = poolBalanceFor(state, debt.token);
    const reserve = feeReserve(debt.token, state.balances.status === 'loaded' ? state.balances.fee : null);
    const covers = inPool ? maxAfterReserve(maxBasis(inPool), reserve) : null;
    const repayMax = covers !== null && whole !== null && covers < whole ? tidied(covers, debt) : whole;
    max = () => repayMax;
  }
  if (held && loan && mode === 'withdraw-collateral') {
    balance = loan.collateralAmount;
    balanceLabel = COPY.borrow.form.held;
    exceeds = COPY.borrow.form.overCollateral;
  }
  const check = checkAmount(state.amountText, { decimals: amountToken.decimals, balance: limit ?? balance });
  const typed = check.status === 'ok' ? check.amount : null;
  const everything = takesEverything(state, pair, typed);
  const rows: DetailRow[] = [];
  if (mode === 'borrow') {
    rows.push({
      id: 'available',
      label: COPY.borrow.form.available,
      value: maximum !== null ? formatExact(maximum, debt) : COPY.borrow.form.availableWhy[why ?? 'at-limit'],
    });
  }
  let tooLow = false;
  const assets = market ? pairAssets(market, pair, loan?.health.maxLtv) : null;
  const acting = typed !== null || (mode === 'borrow' && added > 0n);
  // One set of figures for the loan (D-089): now → after, or only now while
  // nothing is typed. The loans list above keeps its warnings.
  if (held && assets && (acting || held.debtAmount > 0n)) {
    const after = afterOf(mode, held, typed ?? 0n, added, everything);
    const before = previewHealth(held, assets);
    const next = acting ? previewHealth(after, assets) : null;
    if (before.status !== 'stale' && next?.status !== 'stale') {
      const { tone, note } = next ? healthTone(next) : healthTone(before);
      rows.push({ id: 'ltv', label: COPY.borrow.loans.ltv, value: figure(ltvText(before), next ? ltvText(next) : null) });
      rows.push({
        id: 'health',
        label: COPY.borrow.form.health,
        value: figure(healthText(before), next ? healthText(next) : null),
        tone,
        ...(note ? { note } : {}),
      });
      rows.push({
        id: 'liquidation',
        label: `${COPY.borrow.loans.liquidation} (${collateral.symbol})`,
        value: figure(liquidationText(before), next ? liquidationText(next) : null),
      });
      if (mode === 'repay' && acting) rows.push({ id: 'remaining', label: COPY.borrow.form.remaining, value: formatExact(after.debtAmount, debt) });
      // Only an action that adds risk is held to the floor; repaying and adding collateral never are (D-083).
      tooLow = (mode === 'borrow' || mode === 'withdraw-collateral') && next?.status === 'priced'
        && (next.band === 'too-close' || next.band === 'liquidatable');
    }
  }
  const hint = mode === 'borrow'
    ? why === 'no-collateral'
      ? 'add-collateral' as const
      : why === 'below-floor'
        ? COPY.borrow.form.belowFloorHint
        : max !== null ? COPY.borrow.form.maxHint : null
    : everything && mode === 'repay'
      ? COPY.borrow.form.repayAllLine
      : everything && mode === 'withdraw-collateral'
        ? COPY.borrow.form.withdrawAllLine
        : null;
  const exceedsAfterFee = limit !== null ? COPY.kit.exceedsWithFee : exceeds;
  return { check, collateralCheck, pool, balance, limit, balanceLabel, exceeds: exceedsAfterFee, max, hint, rows, tooLow, typed, added, everything };
}

/**
 * The amounts in the owner's order (D-103) for the form: what is typed (a
 * borrow's collateral, then the loan), what comes out directly, the pool fee
 * on top, and what leaves the pool, in each token. The loan's figures (what
 * can be borrowed, LTV, health) follow as details.
 */
function composeSummary(
  mode: BorrowMode,
  collateral: BorrowTokenView,
  debt: BorrowTokenView,
  figures: { typed: bigint | null; added: bigint; everything: boolean },
  fee: bigint | null,
  details: readonly DetailRow[],
): AmountSummaryProps {
  const typed = figures.typed ?? 0n;
  const fees = fee === null ? [] : [poolFeeRow(formatStrk(fee))];
  const total = (amount: bigint, token: BorrowTokenView) => fee === null
    ? null
    : { label: COPY.kit.totalFromPool, value: borrowTotal(amount, token, fee, false) };
  switch (mode) {
    case 'borrow':
      return {
        entered: [
          ...(figures.added > 0n ? [{ label: COPY.borrow.review.collateral, value: formatHolding(figures.added, collateral) }] : []),
          { label: COPY.borrow.review.borrow, value: formatHolding(typed, debt) },
        ],
        receive: { label: COPY.kit.youReceive, value: formatHolding(typed, debt) },
        fees,
        total: total(figures.added, collateral),
        details,
      };
    case 'add-collateral':
      return {
        entered: { label: COPY.borrow.review.collateral, value: formatHolding(typed, collateral) },
        receive: { label: COPY.borrow.form.addedToLoan, value: formatHolding(typed, collateral) },
        fees,
        total: total(typed, collateral),
        details,
      };
    case 'repay':
      return {
        entered: { label: figures.everything ? COPY.borrow.review.repayAll : COPY.borrow.review.repay, value: formatHolding(typed, debt) },
        receive: { label: COPY.borrow.form.paidOff, value: formatHolding(typed, debt) },
        fees,
        total: total(typed, debt),
        details,
      };
    case 'withdraw-collateral':
      return {
        entered: { label: figures.everything ? COPY.borrow.review.withdrawAll : COPY.borrow.review.withdraw, value: formatHolding(typed, collateral) },
        receive: { label: COPY.kit.youReceive, value: formatHolding(typed, collateral) },
        fees,
        total: total(0n, collateral),
        details,
      };
  }
}

/** The pool fee, glossed; at the review its exact figure carries the "read live" note. */
function poolFeeRow(value: string, note?: string): DetailRow {
  return {
    id: 'fee',
    label: <GlossaryTerm term={COPY.bank.poolFee} definition={COPY.glossary.poolFee} />,
    value: note ? <span title={note}>{value}</span> : value,
  };
}

/** What leaves the pool: an amount in its token plus the pool fee in STRK, one figure when both are STRK. */
function borrowTotal(amount: bigint, token: BorrowTokenView, fee: bigint, exact: boolean): string {
  return totalAcross([
    { token: token.token, amount, format: (value) => (exact ? formatExact(value, token) : formatHolding(value, token)) },
    { token: STRK_TOKEN, amount: fee, format: exact ? formatStrkExact : formatStrk },
  ]);
}

/** A Max figure floored to a tidy precision (D-089); nothing when that leaves nothing. */
function tidied(amount: bigint | null, token: BorrowTokenView): bigint | null {
  if (amount === null) return null;
  const tidy = tidyBorrowAmount(amount, token);
  return tidy > 0n ? tidy : null;
}

/** The loan after the typed action, in the seam's conservative rounding. */
function afterOf(mode: BorrowMode, held: PreviewLoan, amount: bigint, added: bigint, everything: boolean): PreviewLoan {
  switch (mode) {
    case 'borrow':
      return { collateralAmount: held.collateralAmount + added, debtAmount: held.debtAmount + (amount > 0n ? amount + 1n : 0n) };
    case 'add-collateral':
      return { collateralAmount: held.collateralAmount + amount, debtAmount: held.debtAmount };
    case 'repay':
      return { collateralAmount: held.collateralAmount, debtAmount: everything || amount >= held.debtAmount ? 0n : held.debtAmount - amount };
    case 'withdraw-collateral': {
      if (everything) return { collateralAmount: 0n, debtAmount: 0n };
      const left = held.collateralAmount - amount;
      return { collateralAmount: left > 0n ? left - 1n : 0n, debtAmount: held.debtAmount };
    }
  }
}

function CommitBlock({ state, onConfirm, onCancel }: { state: BorrowState; onConfirm: () => void; onCancel: () => void }) {
  const flow = state.flow;
  if (flow.name !== 'review' && flow.name !== 'submitting') return null;
  const { summary } = flow;
  const { action, collateral, debt } = summary;
  let note: string | null = null;
  let landsIn: BorrowTokenView | null = null;
  // D-103: what is typed, what comes out, the fees on top and what leaves the pool, exactly.
  const fees: DetailRow[] = [
    poolFeeRow(formatStrkExact(summary.poolFee), COPY.bank.poolFeeNote),
    { id: 'network', label: <GlossaryTerm term={COPY.bank.networkCost} definition={COPY.glossary.networkCost} />, value: COPY.borrow.review.networkByWallet },
  ];
  const total = (amount: bigint, token: BorrowTokenView) => ({ label: COPY.kit.totalFromPool, value: borrowTotal(amount, token, summary.poolFee, true) });
  let amounts: AmountSummaryProps;
  switch (action.kind) {
    case 'borrow':
      amounts = {
        entered: [
          ...(action.collateralAmount > 0n ? [{ label: COPY.borrow.review.collateral, value: formatExact(action.collateralAmount, collateral) }] : []),
          { label: COPY.borrow.review.borrow, value: formatExact(action.borrowAmount, debt) },
        ],
        receive: { label: COPY.kit.youReceive, value: formatExact(action.borrowAmount, debt) },
        fees,
        total: total(action.collateralAmount, collateral),
      };
      landsIn = debt;
      break;
    case 'add-collateral':
      amounts = {
        entered: { label: COPY.borrow.review.collateral, value: formatExact(action.amount, collateral) },
        receive: { label: COPY.borrow.form.addedToLoan, value: formatExact(action.amount, collateral) },
        fees,
        total: total(action.amount, collateral),
      };
      break;
    case 'repay':
      amounts = {
        entered: { label: action.all ? COPY.borrow.review.repayAll : COPY.borrow.review.repay, value: formatExact(action.amount, debt) },
        receive: { label: COPY.borrow.form.paidOff, value: formatExact(action.amount, debt) },
        fees,
        total: total(action.amount, debt),
      };
      if (action.all) note = COPY.borrow.review.bufferNote;
      break;
    case 'withdraw-collateral':
      amounts = {
        entered: { label: action.all ? COPY.borrow.review.withdrawAll : COPY.borrow.review.withdraw, value: formatExact(action.amount, collateral) },
        receive: { label: COPY.kit.youReceive, value: formatExact(action.amount, collateral) },
        fees,
        total: total(0n, collateral),
      };
      if (action.all) note = COPY.borrow.review.withdrawAllNote;
      landsIn = collateral;
      break;
  }
  const moved = action.kind === 'borrow' || action.kind === 'repay' ? debt : collateral;
  return (
    <div className="panel-review borrow-review">
      <h3>{COPY.flow.review}</h3>
      <AmountSummary {...amounts} label={COPY.flow.review} />
      {note || landsIn ? (
        <p className="vault-review-note">
          {note ? `${note} ` : ''}
          {landsIn ? `${COPY.borrow.review.landsInLead} ${landsIn.symbol} ${COPY.borrow.review.landsInTail}` : ''}
        </p>
      ) : null}
      <h4 className="borrow-after-title">{COPY.borrow.review.after}</h4>
      <HealthFigures health={summary.after} collateral={collateral} debt={debt} />
      {!sameAddress(moved.token, STRK_TOKEN) ? <p className="vault-review-note vault-fee-token">{COPY.borrow.review.feeTokenByWallet}</p> : null}
      {flow.name === 'submitting' ? (
        <p className="flow-pending" aria-live="polite" data-stage={flow.stage}>{flow.message}</p>
      ) : null}
      <ConfirmGate
        disclosures={summary.disclosures}
        requiresDisclosure={summary.requiresDisclosure}
        busy={flow.name === 'submitting'}
        countsTowardPlacement={summary.countsTowardPlacement === true}
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
