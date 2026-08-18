import { useEffect, useMemo } from 'react';
import { COPY } from '../../copy.js';
import { formatStrk, formatStrkExact, shortenAddress } from '../../format.js';
import { usePrivacy } from '../../privacy/PrivacyProvider.js';
import { useStore } from '../../store/use-store.js';
import { ConfirmGate } from '../ConfirmGate.js';
import { LockedNotice } from '../LockedRoom.js';
import { PanelFrame } from '../PanelFrame.js';
import { routeDoor } from '../routes.js';
import { createBankPanel, ROUTE_BY_MODE, type BankMode, type BankPanel as BankPanelMachine, type BankState } from './bank-machine.js';
import { describeIntent, describeWarning } from './summary-copy.js';

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
}: {
  onClose: () => void;
  /** Supply a driven machine to render a specific state. Tests use this. */
  panel?: BankPanelMachine;
  /** Menu Mode batches a visit; the first Game Mode station admits one action. */
  experience?: 'menu' | 'station';
}) {
  const { operations, receipts, noteOperationError, shellBus, submissionUncertainty } = usePrivacy();

  const owned = useMemo(
    () =>
      injected
        ? null
        : createBankPanel({
            operations,
            receipts,
            maxIntents: experience === 'station' ? 1 : undefined,
            onError: noteOperationError,
            canStartFinancialAction: () => {
              const current = submissionUncertainty.store.getState();
              return !current.active || current.acknowledged;
            },
          }),
    [injected, operations, receipts, noteOperationError, experience, submissionUncertainty],
  );
  const panel = injected ?? owned!;
  const state = useStore(panel.store);
  const uncertaintyState = useStore(submissionUncertainty.store);

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

  useEffect(() => {
    // The ambient pending indicator is derived from the operation's own state,
    // never from an expected number of wallet prompts (SPEC §5 rule 5, D-028).
    const busy = state.flow.name === 'preparing' || state.flow.name === 'submitting';
    shellBus?.emit('hud:pending', { count: busy ? 1 : 0 });
  }, [shellBus, state.flow]);

  const committing = state.flow.name === 'review' || state.flow.name === 'submitting';
  const gateBlocked = uncertaintyState.active && !uncertaintyState.acknowledged;
  // A submission-uncertain failure is closed only while the session gate is
  // closed. Once the player acknowledges their balance check, the same Bank
  // machine can compose a new action without recreating the room.
  const blocked =
    state.flow.name === 'failed' &&
    state.flow.recovery === 'close' &&
    (state.flow.kind !== 'submission-uncertain' || !uncertaintyState.acknowledged);

  const modes: readonly BankMode[] =
    experience === 'station' ? ['shield', 'unshield'] : ['shield', 'unshield', 'transfer'];

  // The header disclosure previews the mode being composed. At the commit
  // point it is withdrawn, so ConfirmGate's batch-derived set is the only
  // disclosure on screen — otherwise a shield tab with a transfer queued
  // shows public-deposit copy over a private transfer.
  return (
    <div className="bank-experience" data-experience={experience}>
      <PanelFrame
        title={COPY.bank.title}
        disclosure={committing ? null : state.disclosure}
        closingNote={state.flow.name === 'submitting' ? COPY.flow.closingWillNotCancel : null}
        onClose={onClose}
      >
        <ModeTabs
          mode={state.mode}
          register={state.door}
          modes={modes}
          onSelect={(mode) => panel.setMode(mode)}
        />

        {!state.door.open ? (
          <LockedNotice reason={state.door.reason ?? 'unknown-route'} message={state.door.message} />
        ) : (
          <>
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
                  {COPY.flow.submitted} <code>{shortenAddress(state.flow.transactionHash)}</code>
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
  register,
  modes,
  onSelect,
}: {
  mode: BankMode;
  register: BankState['door'];
  modes: readonly BankMode[];
  onSelect: (mode: BankMode) => void;
}) {
  const labels: Record<BankMode, string> = {
    shield: COPY.bank.shield,
    unshield: COPY.bank.unshield,
    transfer: COPY.bank.transfer,
  };
  return (
    <nav className="panel-modes" role="tablist">
      {modes.map((value) => {
        // Each tab reports its own door, so a route that loses its approval is
        // visibly shut rather than looking available until it is clicked.
        const door = value === mode ? register : routeDoor(ROUTE_BY_MODE[value]);
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
  const needsRecipient = state.mode !== 'shield';
  const max = panel.maxSpendable();

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
        {experience === 'station' ? COPY.gameMode.reviewAction : COPY.batch.add}
      </button>

      {experience === 'station' ? (
        state.batch.length > 0 ? <StationAction state={state} panel={panel} /> : null
      ) : (
        <BatchList state={state} panel={panel} />
      )}

      <p className="panel-hint">
        {experience === 'station' ? COPY.gameMode.singleAction : COPY.batch.why}
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
function StationAction({ state, panel }: { state: BankState; panel: BankPanelMachine }) {
  const intent = state.batch[0];
  if (!intent) return null;
  return (
    <p className="station-action" role="status">
      {describeIntent(intent)}{' '}
      <button type="button" onClick={() => panel.clearBatch()}>
        {COPY.batch.clear}
      </button>
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

  return (
    <div className="panel-review">
      <h3>{COPY.flow.review}</h3>
      <ul className="batch-list">
        {summary.intents.map((intent, index) => (
          <li key={`${intent.kind}-${index}`}>{describeIntent(intent)}</li>
        ))}
      </ul>

      {/* Exact figures: this is the number being agreed to, not an ambient one. */}
      <dl className="review-costs">
        <dt>{COPY.bank.poolFee}</dt>
        <dd title={COPY.bank.poolFeeNote}>{formatStrkExact(summary.poolFee)}</dd>
        <dt>{COPY.bank.networkCost}</dt>
        <dd>{formatStrkExact(summary.gasEstimate)}</dd>
        <dt>{COPY.bank.total}</dt>
        <dd>{formatStrkExact(summary.totalCost)}</dd>
      </dl>

      {summary.warnings.length > 0 ? (
        <ul className="review-warnings">
          {summary.warnings.map((warning, index) => (
            <li key={`${warning.kind}-${index}`}>{describeWarning(warning)}</li>
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
