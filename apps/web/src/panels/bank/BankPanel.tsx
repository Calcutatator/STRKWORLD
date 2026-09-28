import { useEffect, useMemo } from 'react';
import type { Intent } from '@strkworld/privacy';
import type { BuildingId } from '@strkworld/shared';
import { COPY } from '../../copy.js';
import { formatStrk, formatStrkExact, shortenAddress } from '../../format.js';
import { usePrivacy } from '../../privacy/PrivacyProvider.js';
import { useStore } from '../../store/use-store.js';
import { ConfirmGate } from '../ConfirmGate.js';
import { LockedNotice } from '../LockedRoom.js';
import { PanelFrame } from '../PanelFrame.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import { routeDoor } from '../routes.js';
import {
  createBankPanel,
  modeNeedsRecipient,
  reviewedStake,
  ROUTE_BY_MODE,
  type BankMode,
  type BankPanel as BankPanelMachine,
  type BankState,
} from './bank-machine.js';
import { describeIntent, describeWarnings } from './summary-copy.js';
import { WalletAttentionCue, walletOperationAttention } from '../../wallet/WalletAttentionCue.js';
import { createPendingHudOwner } from '../pending-hud.js';
import { BankJourneyNotice } from '../JourneyNotice.js';
import { GlossaryTerm } from '../Glossary.js';

const BANK_MENU_MODES: readonly BankMode[] = ['shield', 'unshield', 'transfer', 'stake'];
const BANK_STATION_MODES: readonly BankMode[] = ['shield', 'unshield'];

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
 * The Bank.
 *
 * A thin view over `bank-machine.ts`. Every rule that matters — no polled
 * balance, no invented maximum, no prompt counting, no mixing a shield with a
 * spend, no second confirm — lives in the machine, where it is tested without a
 * renderer. This file decides what the room looks like, and enforces two things
 * that are purely about rendering: a locked route shows a locked door rather
 * than a form nobody can submit, and the confirm button only exists inside
 * `ConfirmGate`, which cannot render without the batch's approved disclosures.
 */
export function BankPanel({
  onClose,
  panel: injected,
  experience = 'menu',
  allowedModes,
  initialMode,
  title = COPY.bank.title,
  building = 'bank',
  preConfirmGuard,
  register = PRIVACY_REGISTER,
  intro,
}: {
  onClose: () => void;
  /** Supply a driven machine to render a specific state. Tests use this. */
  panel?: BankPanelMachine;
  /** Menu Mode batches a visit; the first Game Mode station admits one action. */
  experience?: 'menu' | 'station';
  /** Fixed stations can expose a strict subset of the Bank controls. */
  allowedModes?: readonly BankMode[];
  /** Fixed stations can open on their one meaningful control. */
  initialMode?: BankMode;
  /** The existing machine can render a different building title. */
  title?: string;
  /** Receipt ownership; also picks the window's theme (presentation only). */
  building?: BuildingId;
  preConfirmGuard?: () => Promise<boolean>;
  /** Route authority used for every mode tab and the owned machine. */
  register?: readonly RouteGrade[];
  /** One short line explaining what this window does — the Post Office's own identity narrowed onto this machine. */
  intro?: string;
}) {
  const { operations, receipts, noteOperationError, shellBus, submissionUncertainty } = usePrivacy();
  const modes = allowedModes ?? (experience === 'station' ? BANK_STATION_MODES : BANK_MENU_MODES);

  const owned = useMemo(
    () =>
      injected
        ? null
        : createBankPanel({
            operations,
            receipts,
            allowedModes: modes,
            initialMode,
            building,
            register,
            maxIntents: experience === 'station' ? 1 : undefined,
            onError: noteOperationError,
            preConfirmGuard,
            canStartFinancialAction: () => {
              const current = submissionUncertainty.store.getState();
              return !current.active || current.acknowledged;
            },
          }),
    [injected, operations, receipts, noteOperationError, experience, modes, initialMode, building, preConfirmGuard, register, submissionUncertainty],
  );
  const panel = injected ?? owned!;
  const state = useStore(panel.store);
  const uncertaintyState = useStore(submissionUncertainty.store);
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

  // The header disclosure previews the mode being composed. At the commit
  // point it is withdrawn, so ConfirmGate's batch-derived set is the only
  // disclosure on screen — otherwise a shield tab with a transfer queued
  // shows public-deposit copy over a private transfer.
  return (
    <div className="bank-experience" data-experience={experience}>
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
      >
        {intro ? <p className="panel-intro">{intro}</p> : null}
        <BankJourneyNotice
          building={building}
          flow={state.flow}
          register={register}
          // The Bridge nudge says "shield it here", so only a window that can shield carries it.
          bridgeNudge={modes.includes('shield')}
        />
        <ModeTabs
          mode={state.mode}
          activeDoor={state.door}
          modes={modes}
          register={register}
          onSelect={(mode) => panel.setMode(mode)}
        />

        {!state.door.open ? (
          <LockedNotice reason={state.door.reason ?? 'unknown-route'} message={state.door.message} />
        ) : (
          <>
            {state.mode === 'stake' && !committing && state.flow.name !== 'submitted' ? <StakeIntro /> : null}
            <BalanceBlock state={state} onRefresh={() => void panel.refreshBalance()} />

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
                <button type="button" onClick={() => panel.acknowledge()}>
                  {COPY.flow.back}
                </button>
              </div>
            ) : blocked || gateBlocked ? null : (
              <ComposeBlock state={state} panel={panel} experience={experience} />
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

function ModeTabs({
  mode,
  activeDoor,
  modes,
  register,
  onSelect,
}: {
  mode: BankMode;
  activeDoor: BankState['door'];
  modes: readonly BankMode[];
  register: readonly RouteGrade[];
  onSelect: (mode: BankMode) => void;
}) {
  const labels: Record<BankMode, string> = {
    shield: COPY.bank.shield,
    unshield: COPY.bank.unshield,
    transfer: COPY.bank.transfer,
    stake: COPY.bank.stake,
  };
  return (
    <nav className="panel-modes" role="tablist">
      {modes.map((value) => {
        // Each tab reports its own door, so a route that loses its approval is
        // visibly shut rather than looking available until it is clicked.
        const door = value === mode ? activeDoor : routeDoor(ROUTE_BY_MODE[value], register);
        return (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            data-locked={door.open ? undefined : 'true'}
            onClick={() => onSelect(value)}
          >
            {labels[value]}
          </button>
        );
      })}
    </nav>
  );
}

function BalanceBlock({ state, onRefresh }: { state: BankState; onRefresh: () => void }) {
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
  experience,
}: {
  state: BankState;
  panel: BankPanelMachine;
  experience: 'menu' | 'station';
}) {
  const busy = state.flow.name === 'preparing' || state.adding;
  const needsRecipient = modeNeedsRecipient(state.mode);
  const max = panel.maxSpendable();
  // A stake settles on its own (D-063), and a transfer pays one recipient per
  // send (D-065), so even Menu Mode composes either as one action: batch
  // vocabulary would promise a shared fee that cannot happen.
  const stake = state.mode === 'stake';
  const transfer = state.mode === 'transfer';
  const singleAction = experience === 'station' || stake || transfer;

  return (
    <form
      className="panel-compose"
      onSubmit={(event) => {
        event.preventDefault();
        void panel.addToBatch();
      }}
    >
      <label>
        {COPY.bank.amount}
        <input
          name="amount"
          inputMode="decimal"
          autoComplete="off"
          value={state.amountText}
          onChange={(event) => panel.setAmount(event.target.value)}
        />
      </label>
      {max !== null ? (
        <button type="button" onClick={() => panel.applyMax()}>
          {COPY.bank.max}
        </button>
      ) : null}

      {needsRecipient ? (
        <label>
          {COPY.bank.recipient}
          <input
            name="recipient"
            autoComplete="off"
            spellCheck={false}
            value={state.recipientText}
            onChange={(event) => panel.setRecipient(event.target.value)}
          />
        </label>
      ) : null}

      <button
        type="submit"
        disabled={busy || (experience === 'station' && state.batch.length > 0)}
      >
        {singleAction ? COPY.gameMode.reviewAction : COPY.batch.add}
      </button>

      {experience === 'station' ? (
        state.batch.length > 0 ? <StationAction state={state} /> : null
      ) : singleAction ? (
        // Menu Mode keeps Remove and Clear for whatever is queued, but the
        // stake and transfer tabs never invite the player to fill a visit.
        state.batch.length > 0 ? <BatchList state={state} panel={panel} /> : null
      ) : (
        <BatchList state={state} panel={panel} />
      )}

      <p className="panel-hint">
        {stake
          ? COPY.stake.oneAtATime
          : experience === 'station'
            ? COPY.gameMode.singleAction
            : transfer
              ? COPY.postOffice.oneAtATime
              : COPY.batch.why}
      </p>
      <button
        type="button"
        className="review"
        disabled={state.batch.length === 0 || busy}
        onClick={() => void panel.prepare()}
      >
        {state.flow.name === 'preparing' ? COPY.flow.preparing : COPY.flow.review}
      </button>
    </form>
  );
}

/**
 * Game Mode has one action per station window. It still uses the same typed
 * batch machine so the route, disclosure and receipt invariants stay shared,
 * but it must not present Menu Mode's multi-action visit vocabulary.
 */
function StationAction({ state }: { state: BankState }) {
  const intent = state.batch[0];
  if (!intent) return null;
  return (
    <p className="station-action" role="status">
      {describeIntent(intent)}
    </p>
  );
}

function BatchList({ state, panel }: { state: BankState; panel: BankPanelMachine }) {
  if (state.batch.length === 0) {
    return <p className="batch-empty">{COPY.batch.empty}</p>;
  }
  return (
    <>
      <ul className="batch-list" aria-label={COPY.batch.title}>
        {state.batch.map((intent, index) => (
          <li key={`${intent.kind}-${index}`}>
            {describeIntent(intent)}
            <button type="button" onClick={() => panel.removeFromBatch(index)}>
              {COPY.batch.remove}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => panel.clearBatch()}>
        {COPY.batch.clear}
      </button>
    </>
  );
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
      <dl className="review-costs">
        <dt><GlossaryTerm term={COPY.bank.poolFee} definition={COPY.glossary.poolFee} /></dt>
        <dd title={COPY.bank.poolFeeNote}>{formatStrkExact(summary.poolFee)}</dd>
        <dt><GlossaryTerm term={COPY.bank.networkCost} definition={COPY.glossary.networkCost} /></dt>
        <dd>{formatStrkExact(summary.gasEstimate)}</dd>
        <dt>{COPY.bank.total}</dt>
        <dd>{formatStrkExact(summary.totalCost)}</dd>
      </dl>

      {/* How the product works, said at the moment it matters. Not a privacy disclosure (D-064). */}
      {stake ? <p className="stake-note">{COPY.stake.unstaking}</p> : null}

      {summary.warnings.length > 0 ? (
        <ul className="review-warnings">
          {describeWarnings(summary.warnings, summary.intents).map((text, index) => (
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
