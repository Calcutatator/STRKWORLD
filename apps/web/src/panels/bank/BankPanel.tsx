import { useEffect, useMemo } from 'react';
import type { Intent } from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { formatStrk, formatTokenAmountExact, shortenAddress } from '../../format.js';
import { usePrivacy } from '../../privacy/PrivacyProvider.js';
import { useStore } from '../../store/use-store.js';
import { PanelFrame } from '../PanelFrame.js';
import { createBankPanel, type BankMode, type BankState } from './bank-machine.js';

/**
 * The Bank.
 *
 * A thin view over `bank-machine.ts`. Every rule that matters — no polled
 * balance, no invented maximum, no prompt counting, no mixing a shield with a
 * spend — lives in the machine, where it is tested without a renderer. This
 * file decides what the room looks like and nothing else.
 */
export function BankPanel({ onClose }: { onClose: () => void }) {
  const { operations, connect, shellBus } = usePrivacy();

  const panel = useMemo(
    () => createBankPanel({ operations, onError: (error) => connect.noteOperationError(error) }),
    [operations, connect],
  );
  const state = useStore(panel.store);

  useEffect(() => {
    void panel.open();
    return () => panel.close();
  }, [panel]);

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

  return (
    <PanelFrame title={COPY.bank.title} disclosure={state.disclosure} onClose={onClose}>
      <ModeTabs mode={state.mode} onSelect={(mode) => panel.setMode(mode)} />
      <BalanceBlock state={state} onRefresh={() => void panel.refreshBalance()} />

      {state.flow.name === 'review' ? (
        <ReviewBlock
          state={state}
          onConfirm={() => void panel.confirm()}
          onCancel={() => panel.cancelPrepared()}
        />
      ) : state.flow.name === 'submitting' ? (
        <p className="flow-pending" aria-live="polite" data-stage={state.flow.stage}>
          {state.flow.message}
        </p>
      ) : state.flow.name === 'submitted' ? (
        <p className="flow-done" aria-live="polite">
          {COPY.flow.submitted} <code>{shortenAddress(state.flow.transactionHash)}</code>
        </p>
      ) : (
        <ComposeBlock state={state} panel={panel} />
      )}

      {state.flow.name === 'failed' ? (
        <p className="flow-failed" role="alert">
          {state.flow.message}
        </p>
      ) : null}

      {state.notice ? (
        <p className={`panel-notice notice-${state.notice.tone}`} role="status">
          {state.notice.text}
        </p>
      ) : null}
    </PanelFrame>
  );
}

function ModeTabs({ mode, onSelect }: { mode: BankMode; onSelect: (mode: BankMode) => void }) {
  const modes: readonly [BankMode, string][] = [
    ['shield', COPY.bank.shield],
    ['unshield', COPY.bank.unshield],
    ['transfer', COPY.bank.transfer],
  ];
  return (
    <nav className="panel-modes" role="tablist">
      {modes.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={mode === value}
          onClick={() => onSelect(value)}
        >
          {label}
        </button>
      ))}
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
}: {
  state: BankState;
  panel: ReturnType<typeof createBankPanel>;
}) {
  const busy = state.flow.name === 'preparing';
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

      <button type="submit" disabled={!state.door.open || busy}>
        {COPY.batch.add}
      </button>

      <BatchList state={state} panel={panel} />

      <p className="panel-hint">{COPY.batch.why}</p>
      <button
        type="button"
        disabled={state.batch.length === 0 || busy}
        onClick={() => void panel.prepare()}
      >
        {busy ? COPY.flow.preparing : COPY.flow.review}
      </button>
    </form>
  );
}

function BatchList({
  state,
  panel,
}: {
  state: BankState;
  panel: ReturnType<typeof createBankPanel>;
}) {
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

function ReviewBlock({
  state,
  onConfirm,
  onCancel,
}: {
  state: BankState;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (state.flow.name !== 'review') return null;
  const { summary } = state.flow;

  return (
    <div className="panel-review">
      <h3>{COPY.flow.review}</h3>
      <ul className="batch-list">
        {summary.intents.map((intent, index) => (
          <li key={`${intent.kind}-${index}`}>{describeIntent(intent)}</li>
        ))}
      </ul>

      <dl className="review-costs">
        <dt>{COPY.bank.poolFee}</dt>
        <dd title={COPY.bank.poolFeeNote}>{formatStrk(summary.poolFee)}</dd>
        <dt>{COPY.bank.networkCost}</dt>
        <dd>{formatStrk(summary.gasEstimate)}</dd>
        <dt>{COPY.bank.total}</dt>
        <dd>{formatStrk(summary.totalCost)}</dd>
      </dl>

      {summary.warnings.length > 0 ? (
        <ul className="review-warnings">
          {summary.warnings.map((warning, index) => (
            <li key={`${warning.kind}-${index}`}>{describeWarning(warning)}</li>
          ))}
        </ul>
      ) : null}

      <button type="button" onClick={onConfirm}>
        {COPY.flow.confirm}
      </button>
      <button type="button" onClick={onCancel}>
        {COPY.flow.cancel}
      </button>
    </div>
  );
}

function describeIntent(intent: Intent): string {
  switch (intent.kind) {
    case 'shield':
      return `${COPY.bank.shield} ${formatTokenAmountExact(intent.amount)}`;
    case 'unshield':
      return `${COPY.bank.unshield} ${formatTokenAmountExact(intent.amount)} → ${shortenAddress(intent.recipient)}`;
    case 'transfer':
      return `${COPY.bank.transfer} ${formatTokenAmountExact(intent.amount)} → ${shortenAddress(intent.recipient)}`;
    case 'swap':
      return `${formatTokenAmountExact(intent.amountIn)} → ${shortenAddress(intent.tokenOut)}`;
  }
}

/**
 * Seam warnings, said plainly.
 *
 * `public-leg` carries its own detail string from `packages/privacy`, which
 * describes exactly what becomes visible; it is shown as given rather than
 * summarised, for the same reason the disclosures are.
 */
function describeWarning(warning: import('@strkworld/privacy').BatchWarning): string {
  switch (warning.kind) {
    case 'public-leg':
      return warning.detail;
    case 'leaves-below-fee':
      return `${COPY.balance.feeReserved} (${formatStrk(warning.remaining)} left)`;
    case 'funds-maturing':
      return `${COPY.balance.maturing} ${formatStrk(warning.maturingAmount)}`;
    case 'recipient-unregistered':
      return COPY.notices.recipientUnregistered;
    case 'multiple-prompts':
      // Reported by the seam, never assumed by the shell.
      return `Your wallet expects to ask you ${warning.count} times.`;
  }
}
