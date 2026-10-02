import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Intent } from '@strkworld/privacy';
import type { BuildingId } from '@strkworld/shared';
import { COPY } from '../../copy.js';
import { formatStrk, formatStrkExact, formatTokenAmountExact, looksLikeAddress, shortenAddress } from '../../format.js';
import { usePrivacy } from '../../privacy/PrivacyProvider.js';
import { useStore } from '../../store/use-store.js';
import { ConfirmGate } from '../ConfirmGate.js';
import { LockedNotice } from '../LockedRoom.js';
import { PanelFrame } from '../PanelFrame.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import {
  createBankPanel,
  modeNeedsRecipient,
  reviewedStake,
  shieldFigures,
  type BankMode,
  type BankPanel as BankPanelMachine,
  type BankState,
} from './bank-machine.js';
import { describeIntent, describeWarnings } from './summary-copy.js';
import { shieldDeposits } from './shield-deposits.js';
import { WalletAttentionCue, walletOperationAttention } from '../../wallet/WalletAttentionCue.js';
import { createPendingHudOwner } from '../pending-hud.js';
import { BankJourneyNotice } from '../JourneyNotice.js';
import { GlossaryTerm } from '../Glossary.js';
import { AmountField, DetailRows, RecipientField, checkAmount, primaryAction, type DetailRow } from '../kit/index.js';
import { estimateText, rateRow, useEndurRate, xstrkForStrk, type EndurRateView } from './endur-rate.js';

/** What each counter does, in the words its window names it by. */
const ACTION_LABELS: Readonly<Record<BankMode, string>> = Object.freeze({
  shield: COPY.bank.shield,
  unshield: COPY.bank.unshield,
  transfer: COPY.bank.transfer,
  stake: COPY.bank.stake,
});

/**
 * Whether the window wears Endur's look (D-063). Presentation only.
 *
 * The staking counter is themed while it is the control being composed, and
 * at the commit point the look follows the batch rather than the tab — the
 * same rule the disclosures follow — so a stake is always reviewed in Endur's
 * palette and nothing else ever is.
 */
function wearsEndur(state: BankState): boolean {
  const { flow } = state;
  if (flow.name === 'review' || flow.name === 'submitting') {
    return reviewedStake(flow.summary.intents) !== null;
  }
  return state.mode === 'stake';
}

/**
 * One Bank-machine counter (D-103): SHIELD, UNSHIELD or STAKE in the Bank,
 * or the Post Office's TRANSFER (D-040).
 *
 * A thin view over `bank-machine.ts`. Every rule that matters — no polled
 * balance, no invented maximum, no prompt counting, no mixing a shield with a
 * spend, no second confirm — lives in the machine, where it is tested without a
 * renderer. This file decides what the counter looks like, and enforces two
 * things that are purely about rendering: a locked route shows a locked door
 * rather than a form nobody can submit, and the confirm button only exists
 * inside `ConfirmGate`, which cannot render without the prepared action's
 * approved disclosures. Each counter does one action and confirms it; the
 * Game Mode counter and Menu Mode's tab render the same window.
 */
export function BankPanel({
  onClose,
  panel: injected,
  experience = 'menu',
  mode = 'shield',
  title = COPY.bank.title,
  building = 'bank',
  preConfirmGuard,
  register = PRIVACY_REGISTER,
  intro,
  counters = null,
}: {
  onClose: () => void;
  /** Supply a driven machine to render a specific state. Tests use this. */
  panel?: BankPanelMachine;
  /** Presentation only: the counter and Menu Mode render the same window (D-103). */
  experience?: 'menu' | 'station';
  /** The counter's one control (D-103). */
  mode?: BankMode;
  /** The existing machine can render a different building title. */
  title?: string;
  /** Receipt ownership; also picks the window's theme (presentation only). */
  building?: BuildingId;
  preConfirmGuard?: () => Promise<boolean>;
  /** Route authority used for the counter's control and the owned machine. */
  register?: readonly RouteGrade[];
  /** One short line explaining what this window does — the Post Office's own identity narrowed onto this machine. */
  intro?: string;
  /** Menu Mode's counter tabs (D-088, D-103); presentation only. */
  counters?: ReactNode;
}) {
  const { operations, receipts, noteOperationError, shellBus, submissionUncertainty } = usePrivacy();
  const modes = useMemo(() => [mode] as const, [mode]);

  const owned = useMemo(
    () =>
      injected
        ? null
        : createBankPanel({
            operations,
            receipts,
            allowedModes: modes,
            initialMode: mode,
            building,
            register,
            onError: noteOperationError,
            preConfirmGuard,
            canStartFinancialAction: () => {
              const current = submissionUncertainty.store.getState();
              return !current.active || current.acknowledged;
            },
          }),
    [injected, operations, receipts, noteOperationError, modes, mode, building, preConfirmGuard, register, submissionUncertainty],
  );
  const panel = injected ?? owned!;
  const state = useStore(panel.store);
  const uncertaintyState = useStore(submissionUncertainty.store);
  const recipientChoice = useState(false);
  // D-091: xSTRK's live rate, one public read while the staking counter is open.
  const rate = useEndurRate(operations, state.mode === 'stake');
  const pendingHud = useMemo(() => createPendingHudOwner(shellBus), [shellBus]);

  useEffect(() => {
    // An injected machine belongs to whoever injected it, including its
    // lifecycle. Opening it here would fight them for it.
    if (!owned) return;
    void owned.open();
    return () => owned.close();
  }, [owned]);

  // Push presentation data into the world. Pre-formatted strings only: the
  // world never receives a bigint or a token address.
  useEffect(() => {
    const display = state.balance.status === 'loaded' ? formatStrk(state.balance.total) : null;
    shellBus?.emit('hud:balance', { display });
  }, [shellBus, state.balance]);

  const pending = state.flow.name === 'preparing' || state.flow.name === 'submitting';
  useEffect(() => {
    // The ambient pending indicator is derived from the operation's own state,
    // never from an expected number of wallet prompts (SPEC §5 rule 5, D-028).
    pendingHud.setBusy(pending);
  }, [pendingHud, pending]);
  useEffect(() => () => pendingHud.release(), [pendingHud]);

  const committing = state.flow.name === 'review' || state.flow.name === 'submitting';
  const gateBlocked = uncertaintyState.active && !uncertaintyState.acknowledged;
  // A submission-uncertain failure is closed only while the session gate is
  // closed. Once the player acknowledges their balance check, the same Bank
  // machine can compose a new action without recreating the room.
  const blocked =
    state.flow.name === 'failed' &&
    state.flow.recovery === 'close' &&
    (state.flow.kind !== 'submission-uncertain' || !uncertaintyState.acknowledged);
  const walletAttention = walletOperationAttention(
    state.balance.status === 'loading',
    state.flow.name === 'submitting' ? state.flow.stage : null,
  );

  // The header disclosure previews the counter's route. At the commit point it
  // is withdrawn, so ConfirmGate's prepared set is the only disclosure on screen.
  return (
    <div className="bank-experience" data-experience={experience} data-mode={state.mode}>
      <WalletAttentionCue
        active={walletAttention !== null}
        kind={walletAttention ?? 'confirm'}
      />
      <PanelFrame
        title={title}
        building={building}
        brand={wearsEndur(state) ? 'endur' : undefined}
        disclosure={committing ? null : state.disclosure}
        closingNote={state.flow.name === 'submitting' ? COPY.flow.closingWillNotCancel : null}
        onClose={onClose}
        counters={counters}
      >
        {intro ? <p className="panel-intro">{intro}</p> : null}
        <BankJourneyNotice
          building={building}
          flow={state.flow}
          register={register}
          // The Bridge nudge says "shield it here", so only a window that can shield carries it.
          bridgeNudge={state.mode === 'shield'}
        />
        {/* D-103: a counter with no Menu Mode tabs above it names its one action. */}
        {counters ? null : <h3 className="counter-action">{ACTION_LABELS[state.mode]}</h3>}

        {!state.door.open ? (
          <LockedNotice reason={state.door.reason ?? 'unknown-route'} message={state.door.message} />
        ) : (
          <>
            {state.mode === 'stake' && !committing && state.flow.name !== 'submitted' ? <StakeIntro /> : null}
            {/* Once read, a spending mode's balance and its Refresh sit on the amount field. */}
            {/* While the session gate holds (D-035) the card is the private balance
                check it asks for, on every counter, Shield included. */}
            {balanceOnField(state) && !(blocked || gateBlocked) ? null : (
              <BalanceBlock
                state={state}
                privateCheck={blocked || gateBlocked}
                onRefresh={() => void (blocked || gateBlocked ? panel.refreshBalance() : refreshFor(state, panel))}
              />
            )}

            {gateBlocked && state.flow.name === 'review' ? null : committing ? (
              <CommitBlock
                state={state}
                onConfirm={() => void panel.confirm()}
                onCancel={() => panel.cancelPrepared()}
              />
            ) : state.flow.name === 'submitted' ? (
              <div className="flow-done" aria-live="polite">
                <p>
                  {state.flow.restored ? COPY.flow.receiptWaiting : COPY.flow.submitted}{' '}
                  <code>{shortenAddress(state.flow.transactionHash)}</code>
                </p>
                {/* D-094: a new note matures before the wallet's shielded view shows it. */}
                {state.flow.shielded ? <p className="shield-arrives">{COPY.bank.shieldArrives}</p> : null}
                <button type="button" onClick={() => panel.acknowledge()}>
                  {COPY.flow.back}
                </button>
              </div>
            ) : blocked || gateBlocked ? null : (
              <ComposeBlock
                state={state}
                panel={panel}
                rate={rate}
                onRefresh={() => void refreshFor(state, panel)}
                recipientChoice={recipientChoice}
              />
            )}

            {state.flow.name === 'failed' ? (
              <div className="flow-failed" role="alert">
                <p>{state.flow.message}</p>
                {state.flow.recovery === 'prepare-again' ? (
                  <button type="button" onClick={() => panel.cancelPrepared()}>
                    {COPY.flow.back}
                  </button>
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

/** D-094: Refresh re-reads what the control spends: the wallet's public balance on Shield, the pool's elsewhere. */
function refreshFor(state: BankState, panel: BankPanelMachine): Promise<void> {
  return state.mode === 'shield' ? panel.refreshPublicBalance() : panel.refreshBalance();
}

/**
 * Whether the balance figure sits on the amount field, wallet style, rather
 * than in the balance card, once it is read: the private pool balance in a
 * mode that spends it, and on Shield the wallet's public balance (D-094),
 * which is what a shield spends.
 */
function balanceOnField(state: BankState): boolean {
  return state.mode === 'shield' ? state.publicBalance.status === 'loaded' : state.balance.status === 'loaded';
}

/**
 * D-094: the Shield control's card before its wallet balance is on the
 * field: reading it, or why it could not. Never the private pool balance or
 * its settling note, which say nothing about what a shield can spend.
 */
function PublicBalanceBlock({ state, onRefresh }: { state: BankState; onRefresh: () => void }) {
  const view = state.publicBalance;
  return (
    <div className="panel-balance" data-balance="wallet">
      {view.status === 'failed' ? (
        <>
          <p role="alert">{view.message}</p>
          <button type="button" onClick={onRefresh}>
            {COPY.balance.refreshAgain}
          </button>
        </>
      ) : (
        <p aria-busy="true">{COPY.balance.publicLoading}</p>
      )}
    </div>
  );
}

function BalanceBlock({ state, privateCheck = false, onRefresh }: { state: BankState; privateCheck?: boolean; onRefresh: () => void }) {
  if (state.mode === 'shield' && !privateCheck) return <PublicBalanceBlock state={state} onRefresh={onRefresh} />;
  const { balance } = state;
  return (
    <div className="panel-balance">
      {balance.status === 'unrequested' ? (
        <>
          <p>{COPY.balance.unrequested}</p>
          <button type="button" onClick={onRefresh}>
            {COPY.balance.refresh}
          </button>
        </>
      ) : balance.status === 'loading' ? (
        <p aria-busy="true">{COPY.balance.loading}</p>
      ) : balance.status === 'failed' ? (
        <>
          <p role="alert">{balance.message}</p>
          <button type="button" onClick={onRefresh}>
            {COPY.balance.refreshAgain}
          </button>
        </>
      ) : (
        <>
          <p className="balance-total">{formatStrk(balance.total)}</p>
          {balance.maturityKnown ? (
            balance.maturing > 0n ? (
              <p className="balance-maturing">
                {COPY.balance.maturing} {formatStrk(balance.maturing)}
              </p>
            ) : null
          ) : (
            <p className="balance-aggregate">{COPY.balance.maturityUnknown}</p>
          )}
          <button type="button" onClick={onRefresh}>
            {COPY.balance.refreshAgain}
          </button>
        </>
      )}
    </div>
  );
}

function ComposeBlock({
  state,
  panel,
  rate,
  onRefresh,
  recipientChoice,
}: {
  state: BankState;
  panel: BankPanelMachine;
  rate: EndurRateView;
  onRefresh: () => void;
  /** Whether an unshield goes to another address rather than the wallet's own, owned by the window. */
  recipientChoice: readonly [boolean, (other: boolean) => void];
}) {
  const preparing = state.flow.name === 'preparing';
  const busy = preparing || state.adding;
  const needsRecipient = modeNeedsRecipient(state.mode);
  // An unshield goes to the connected wallet unless the player chooses
  // another address. The address is the session's own, already in the shell;
  // it is written into the machine's recipient and goes nowhere new. Without
  // a connected session (demo) there is no own address, so the field shows.
  // D-103: the choice outlives the form, which steps aside while an action is
  // reviewed, so backing out of a review to another address keeps that address.
  const { account } = usePrivacy();
  const [otherAddress, setOtherAddress] = recipientChoice;
  const toOwnWallet = state.mode === 'unshield' && account !== null && !otherAddress;
  useEffect(() => {
    if (toOwnWallet && state.recipientText !== account) panel.setRecipient(account);
  }, [toOwnWallet, account, state.recipientText, panel]);
  // D-022: a Max only where the spendable figure is known and costed. The
  // shipped wallet reports one total per token, so in production there is
  // none, and the button is not drawn rather than drawn dead.
  const max = panel.maxSpendable();
  const stake = state.mode === 'stake';
  const transfer = state.mode === 'transfer';
  const shield = state.mode === 'shield';
  // The balance the field checks against and shows: the private STRK total,
  // once read, in a mode that spends it. It is a total (D-022), so "more than
  // your pool balance" is certain; less is still the wallet's to accept.
  // D-094: on Shield it is the wallet's public balance, and the amount must
  // leave room for the pool fee on top.
  const wallet = shield && state.publicBalance.status === 'loaded' ? state.publicBalance.amount : null;
  const shieldLimit = wallet !== null && state.pool ? wallet - state.pool.feeAmount : null;
  const balance = shield
    ? wallet
    : balanceOnField(state) && state.balance.status === 'loaded' ? state.balance.total : null;
  const check = checkAmount(state.amountText, { decimals: 18, balance: shield ? shieldLimit : balance });
  const recipient = toOwnWallet ? account : state.recipientText.trim();
  const ready = COPY.gameMode.reviewAction;
  const action = needsRecipient && recipient === ''
    ? { label: COPY.bank.enterRecipient, disabled: true }
    : needsRecipient && !looksLikeAddress(recipient)
      ? { label: COPY.bank.checkRecipient, disabled: true }
      : primaryAction({ check, symbol: 'STRK', ready, busy: busy ? COPY.flow.preparing : null });
  const atMax = max !== null && state.amountText === formatTokenAmountExact(max);
  // The balance card's notes, when its figure is on the field instead. The
  // settling note is about the private balance, so Shield never shows it.
  const balanceNote = shield || state.balance.status !== 'loaded' || balance === null
    ? null
    : !state.balance.maturityKnown
      ? COPY.balance.maturityUnknown
      : state.balance.maturing > 0n ? `${COPY.balance.maturing} ${formatStrk(state.balance.maturing)}` : null;

  return (
    <form
      className="panel-compose"
      onSubmit={(event) => {
        event.preventDefault();
        // D-103: one action per counter, reviewed straight from the form.
        void panel.review();
      }}
    >
      {toOwnWallet ? (
        <div className="ui-recipient">
          <div className="ui-recipient-box ui-recipient-own">
            <span className="ui-recipient-own-text" data-testid="unshield-own-wallet">
              {COPY.bank.toYourWallet} ({shortenAddress(account)})
            </span>
            <button
              type="button"
              className="ui-chip"
              disabled={busy}
              onClick={() => {
                setOtherAddress(true);
                panel.setRecipient('');
              }}
            >
              {COPY.bank.sendToAnother}
            </button>
          </div>
        </div>
      ) : needsRecipient ? (
        <>
          <RecipientField
            label={COPY.bank.recipient}
            value={state.recipientText}
            onChange={(text) => panel.setRecipient(text)}
            validate={(text) => (looksLikeAddress(text) ? null : COPY.notices.badRecipient)}
            disabled={busy}
          />
          {state.mode === 'unshield' && account !== null ? (
            <button type="button" className="ui-link-button" disabled={busy} onClick={() => setOtherAddress(false)}>
              {COPY.bank.useMyWallet}
            </button>
          ) : null}
        </>
      ) : null}

      <AmountField
        label={COPY.bank.amount}
        value={state.amountText}
        onChange={(text) => panel.setAmount(text)}
        decimals={18}
        symbol="STRK"
        balance={balance}
        {...(shield ? { limit: shieldLimit, balanceLabel: COPY.kit.walletBalance, exceedsMessage: COPY.bank.exceedsWallet } : {})}
        max={max !== null || shield ? () => panel.maxSpendable() : undefined}
        balanceAction={
          <button type="button" className="ui-chip balance-refresh" aria-label={COPY.balance.refreshLabel} disabled={busy} onClick={onRefresh}>
            {COPY.balance.refreshShort}
          </button>
        }
        hint={shield ? shieldHint(state, check.amount, atMax) : atMax ? COPY.balance.feeReserved : balanceNote ?? undefined}
        disabled={busy}
      />

      <DetailRows rows={composeRows(state, check.amount, rate)} />

      <button type="submit" className="review" disabled={busy || action.disabled}>
        {action.label}
      </button>

      <p className="panel-hint">
        {stake ? COPY.stake.oneAtATime : transfer ? COPY.postOffice.oneAtATime : COPY.gameMode.singleAction}
      </p>
    </form>
  );
}

/**
 * The rows under the amount, as each category's apps show them, and no more:
 * a send, a shield and an unshield show the pool fee; a stake adds what it
 * receives and the rate it is estimated at (D-091). The fee is ambient here;
 * the exact figure being agreed to is the review's.
 */
function composeRows(state: BankState, amount: bigint | null, rate: EndurRateView): DetailRow[] {
  const rows: DetailRow[] = [];
  if (state.mode === 'shield' && state.pool) {
    // D-094: what reaches the pool, the fee on top, and what leaves the
    // wallet. D-103: every shield is its own action and pays its own fee.
    const figures = shieldFigures(amount ?? 0n, state.pool.feeAmount);
    rows.push({ id: 'shield', label: COPY.bank.youShield, value: formatStrk(figures.amount) });
    rows.push({
      id: 'fee',
      label: <GlossaryTerm term={COPY.bank.poolFee} definition={COPY.glossary.poolFee} />,
      value: formatStrk(figures.fee),
    });
    rows.push({ id: 'total', label: COPY.bank.totalFromWallet, value: formatStrk(figures.total), tone: 'emphasis' });
    return rows;
  }
  if (state.mode === 'stake') {
    const estimate = rate.status === 'loaded' && amount !== null
      ? estimateText(xstrkForStrk(amount, rate.strkPerXstrk), COPY.stake.outputToken)
      : null;
    rows.push({
      id: 'receive',
      label: COPY.stake.willReceive,
      value: estimate ?? '—',
      tone: 'emphasis',
    });
    rows.push(rateRow(rate));
  }
  if (state.pool) {
    rows.push({
      id: 'fee',
      label: <GlossaryTerm term={COPY.bank.poolFee} definition={COPY.glossary.poolFee} />,
      value: formatStrk(state.pool.feeAmount),
    });
  }
  return rows;
}

/**
 * D-094: the Shield field's one line: why Max left some behind, that the
 * fee is fixed when it is a large share of a small shield, or that it comes
 * on top.
 */
function shieldHint(state: BankState, amount: bigint | null, atMax: boolean): string {
  if (atMax) return COPY.bank.shieldMaxNote;
  const fee = state.pool?.feeAmount ?? null;
  if (fee !== null && amount !== null && amount > 0n && amount <= 2n * fee) return COPY.bank.shieldFeeNudge;
  return COPY.bank.shieldFeeOnTop;
}

/**
 * Review and submission are one surface.
 *
 * The disclosures and the figures stay on screen while the wallet works, and
 * the confirm button is disabled rather than removed — the panel must not
 * rearrange itself under the player's cursor at the moment of commitment.
 */
function CommitBlock({
  state,
  onConfirm,
  onCancel,
}: {
  state: BankState;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const flow = state.flow;
  if (flow.name !== 'review' && flow.name !== 'submitting') return null;
  const { summary } = flow;
  const busy = flow.name === 'submitting';
  const stake = reviewedStake(summary.intents);
  // D-094: a shield's amount reaches the pool and the fee goes on top, so
  // its review shows what leaves the wallet in the fee token.
  const shieldOnly = summary.intents.length > 0 && summary.intents.every((intent) => intent.kind === 'shield');
  const pool = state.token ? { feeToken: state.token, feeAmount: summary.poolFee } : undefined;
  const shielded = shieldOnly ? summary.intents.reduce((sum, intent) => sum + (intent.kind === 'shield' ? intent.amount : 0n), 0n) : 0n;
  const fromWallet = shieldOnly && pool ? shieldDeposits(summary.intents, pool).reduce((sum, deposit) => sum + deposit, 0n) : 0n;

  return (
    <div className="panel-review">
      <h3>{COPY.flow.review}</h3>
      {stake ? (
        <StakeFigures intent={stake} />
      ) : (
        <ul className="batch-list">
          {summary.intents.map((intent, index) => (
            <li key={`${intent.kind}-${index}`}>{describeIntent(intent)}</li>
          ))}
        </ul>
      )}

      {/* Exact figures: this is the number being agreed to, not an ambient one. */}
      {shieldOnly && pool ? (
        <dl className="review-costs" data-review="shield">
          <dt>{COPY.bank.youShield}</dt>
          <dd>{formatStrkExact(shielded)}</dd>
          <dt><GlossaryTerm term={COPY.bank.poolFee} definition={COPY.glossary.poolFee} /></dt>
          <dd title={COPY.bank.poolFeeNote}>{formatStrkExact(summary.poolFee)}</dd>
          <dt>{COPY.bank.totalFromWallet}</dt>
          <dd>{formatStrkExact(fromWallet)}</dd>
        </dl>
      ) : (
        <dl className="review-costs">
          <dt><GlossaryTerm term={COPY.bank.poolFee} definition={COPY.glossary.poolFee} /></dt>
          <dd title={COPY.bank.poolFeeNote}>{formatStrkExact(summary.poolFee)}</dd>
          <dt><GlossaryTerm term={COPY.bank.networkCost} definition={COPY.glossary.networkCost} /></dt>
          <dd>{formatStrkExact(summary.gasEstimate)}</dd>
          <dt>{COPY.bank.total}</dt>
          <dd>{formatStrkExact(summary.totalCost)}</dd>
        </dl>
      )}

      {/* How the product works, said at the moment it matters. Not a privacy disclosure (D-064). */}
      {stake ? <p className="stake-note">{COPY.stake.unstaking}</p> : null}

      {summary.warnings.length > 0 ? (
        <ul className="review-warnings">
          {describeWarnings(summary.warnings, summary.intents, pool).map((text, index) => (
            <li key={`${summary.warnings[index]!.kind}-${index}`}>
              {text}
              {summary.warnings[index]!.kind === 'funds-maturing' ? (
                <GlossaryTerm term={COPY.glossary.toggle} definition={COPY.glossary.maturingFunds} />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {flow.name === 'submitting' ? (
        <p className="flow-pending" aria-live="polite" data-stage={flow.stage}>
          {flow.message}
        </p>
      ) : null}

      <ConfirmGate
        disclosures={summary.disclosures}
        requiresDisclosure={summary.requiresDisclosure}
        busy={busy}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </div>
  );
}

/**
 * The staking counter's own header (D-063): where the STRK comes from, where
 * the xSTRK lands, and that there is no way back out in the game yet.
 *
 * D-064 waived the stake route's in-game disclosure, so nothing here is a
 * disclosure, and nothing here may claim the amounts are hidden. The unstaking
 * line is product information: how the exit works, not what an observer sees.
 */
function StakeIntro() {
  return (
    <div className="stake-intro">
      <p className="stake-eyebrow">{COPY.stake.eyebrow}</p>
      <p className="panel-intro">{COPY.stake.intro}</p>
      <p className="stake-note">{COPY.stake.unstaking}</p>
    </div>
  );
}

/**
 * STRK in and xSTRK out, at the commit point.
 *
 * STRK in is the exact amount being signed. xSTRK out is named and never
 * numbered: `PreparedBatch` carries no stake output figure, because the
 * ERC-4626 share amount is fixed only when the deposit executes (D-063), and
 * D-041/D-042 forbid reviewing a figure nothing enforces. Showing a rate here
 * would mean inventing one — the demo fake's fixed rate included.
 */
function StakeFigures({ intent }: { intent: Extract<Intent, { kind: 'stake' }> }) {
  return (
    <>
      <dl className="stake-review">
        <dt>{COPY.stake.youStake}</dt>
        <dd>{formatStrkExact(intent.amountIn)}</dd>
        <dt><GlossaryTerm term={COPY.stake.youReceive} definition={COPY.glossary.xstrk} /></dt>
        <dd><span className="stake-token">{COPY.stake.outputToken}</span></dd>
      </dl>
      <p className="stake-review-note">{COPY.stake.amountAtExecution}</p>
    </>
  );
}
