import { useEffect, useMemo, type ReactNode } from 'react';
import type { WalletRoutePolicy } from '@strkworld/privacy';
import { COPY } from '../copy.js';
import { formatTokenAmountExact, sameAddress, shortenAddress } from '../format.js';
import { ConfirmGate } from '../panels/ConfirmGate.js';
import { LockedNotice } from '../panels/LockedRoom.js';
import { stageCopy } from '../panels/bank/bank-machine.js';
import { describeWarnings } from '../panels/bank/summary-copy.js';
import { usePrivacy } from '../privacy/PrivacyProvider.js';
import type { RouteGrade } from '../privacy/register.js';
import { detectRoutePolicy } from '../production/config.js';
import { useStore } from '../store/use-store.js';
import { WalletAttentionCue } from '../wallet/WalletAttentionCue.js';
import {
  createEntryGate,
  entryPolicyKey,
  entryTokens,
  type AccountReader,
  type DepositFailure,
  type EntryGate as EntryGateMachine,
  type EntryGateOptions,
  type EntryGateState,
} from './entry-gate.js';
import { createEntryPassMemory, type EntryPassMemory } from './entry-pass.js';
import { NotRegisteredNotice } from './NotRegisteredNotice.js';

type Of<N extends EntryGateState['name']> = Extract<EntryGateState, { name: N }>;

/**
 * The entry gate (D-072): the city's children render only once it passes.
 *
 * Mounted twice, by whoever owns the seam: `ProductionRoot` puts it after the
 * wallet's capability check and before the presence owner and `App` exist, so
 * no World, HUD or lobby connection starts early; `App` puts it around the
 * city for the demo seam it loads itself. One gate per account: the owner
 * keys it by account, so a new account starts over and checks again, and
 * `readAccount` lets the gate drop an answer that races that replacement.
 *
 * The cards reuse the connect rooms' `.room` card and the Bank's review and
 * commit pieces, so the gate brings no visual language of its own.
 */
export function EntryGate({
  operations,
  account,
  readAccount,
  policy,
  register,
  memory,
  watch,
  children,
}: {
  operations: EntryGateOptions['operations'];
  /** The connected account, for this tab's once-per-session pass. Null (the demo) checks every time. */
  account: string | null;
  /** The session's current account, re-read without a wallet prompt before an answer counts. */
  readAccount?: AccountReader;
  /** This build's route policy. Omitted, the live one. */
  policy?: WalletRoutePolicy | null;
  register?: readonly RouteGrade[];
  /** Override the pass memory; tests use this. Omitted, this tab's session storage. */
  memory?: EntryPassMemory | null;
  watch?: EntryGateOptions['watch'];
  children: ReactNode;
}) {
  const resolvedPolicy = policy === undefined ? detectRoutePolicy() : policy;
  // The default policy is parsed afresh on every render; key the gate by what
  // it means instead, so a re-render never rebuilds the gate mid-deposit.
  const policyKey = entryPolicyKey(resolvedPolicy);
  const gate = useMemo(
    () => createEntryGate({
      operations,
      tokens: entryTokens(resolvedPolicy),
      policy: resolvedPolicy,
      register,
      memory: memory === undefined ? createEntryPassMemory({ account }) : memory,
      account,
      readAccount,
      watch,
    }),
    // `policyKey` stands for `resolvedPolicy` here.
    [operations, account, readAccount, policyKey, register, memory, watch],
  );
  useEffect(() => {
    gate.start();
    return () => gate.stop();
  }, [gate]);
  const state = useStore(gate.store);
  if (state.name === 'passed') return <>{children}</>;
  return <EntryGateView gate={gate} state={state} />;
}

/**
 * The gate for a composition whose seam `PrivacyProvider` loads itself: the
 * demo. It has no account, so there is no once-per-session pass, and a fresh
 * demo player starts with nothing in the pool.
 */
export function SeamEntryGate({ children }: { children: ReactNode }) {
  const { operations } = usePrivacy();
  return <EntryGate operations={operations} account={null}>{children}</EntryGate>;
}

export function EntryGateView({ gate, state }: { gate: EntryGateMachine; state: EntryGateState }) {
  switch (state.name) {
    case 'recalling':
    case 'ready':
    case 'checking':
    case 'check-failed':
      return <CheckCard gate={gate} state={state} />;
    case 'deposit':
    case 'preparing':
    case 'deposit-failed':
      return <DepositCard gate={gate} state={state} />;
    case 'review':
    case 'depositing':
      return <ReviewCard gate={gate} state={state} />;
    case 'landing':
    case 'unconfirmed':
    case 'receipt-unreachable':
      return <LandingCard gate={gate} state={state} />;
    case 'not-registered':
      // Registering in the wallet often makes a first deposit too, so the way
      // on is the check, never straight back to a second deposit.
      return <NotRegisteredNotice action={COPY.entry.checkBalance} onRetry={() => void gate.check()} />;
    case 'passed':
      return null;
  }
}

function CheckCard({ gate, state }: { gate: EntryGateMachine; state: Of<'recalling' | 'ready' | 'checking' | 'check-failed'> }) {
  const checking = state.name === 'checking';
  const waiting = checking || state.name === 'recalling';
  return (
    <>
      <WalletAttentionCue active={checking} kind="balance" />
      <section
        className="room room-entry"
        data-testid="entry-gate"
        data-gate={state.name}
        aria-busy={waiting ? 'true' : undefined}
      >
        <h2>{COPY.entry.title}</h2>
        <p>{COPY.entry.body}</p>
        {state.name === 'check-failed' ? (
          <p className="flow-failed" role="alert">{COPY.errors[state.failure]}</p>
        ) : null}
        {checking ? <p className="flow-pending" aria-live="polite">{COPY.entry.checking}</p> : null}
        <button type="button" disabled={waiting} onClick={() => void gate.check()}>
          {state.name === 'check-failed' ? COPY.connect.retry : COPY.entry.action}
        </button>
      </section>
    </>
  );
}

/**
 * The way off any card after the first check: the check again, which the
 * wallet asks the player to approve. For a player who has funds after all, or
 * has just deposited somewhere else.
 */
function BalanceCheck({ gate, disabled = false }: { gate: EntryGateMachine; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={() => void gate.check()}>
      {COPY.entry.checkBalance}
    </button>
  );
}

function DepositCard({ gate, state }: { gate: EntryGateMachine; state: Of<'deposit' | 'preparing' | 'deposit-failed'> }) {
  const { form } = state;
  const preparing = state.name === 'preparing';
  const token = form.token === null ? undefined : gate.tokens.find((entry) => sameAddress(entry.token, form.token!));
  const locked = !gate.door.open || !token;
  return (
    <section
      className="room room-entry"
      data-testid="entry-gate"
      data-gate={state.name}
      aria-busy={preparing ? 'true' : undefined}
    >
      <h2>{COPY.entry.depositTitle}</h2>
      <p>{COPY.entry.depositBody}</p>
      {!gate.door.open ? (
        <LockedNotice reason={gate.door.reason ?? 'unknown-route'} message={gate.door.message} />
      ) : !token ? (
        <LockedNotice reason="not-enabled" message={COPY.entry.noToken} />
      ) : (
        <form
          className="panel-compose"
          onSubmit={(event) => {
            event.preventDefault();
            void gate.review();
          }}
        >
          {gate.tokens.length > 1 ? (
            <label>
              {COPY.entry.token}
              <select
                name="token"
                value={token.token}
                disabled={preparing}
                onChange={(event) => gate.setToken(event.target.value)}
              >
                {gate.tokens.map((entry) => (
                  <option key={entry.token} value={entry.token}>
                    {entry.symbol}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            {`${COPY.bank.amount} (${token.symbol})`}
            <input
              name="amount"
              inputMode="decimal"
              autoComplete="off"
              value={form.amountText}
              disabled={preparing}
              onChange={(event) => gate.setAmount(event.target.value)}
            />
          </label>
          <p className="panel-hint">{COPY.entry.feeNote}</p>
          <button type="submit" className="review" disabled={preparing}>
            {preparing ? COPY.flow.preparing : COPY.entry.review}
          </button>
          {/* Inside the form, after the one call to action, so it reads as the second choice. */}
          <BalanceCheck gate={gate} disabled={preparing} />
        </form>
      )}
      {locked ? <BalanceCheck gate={gate} /> : null}
      {state.name === 'deposit-failed' ? (
        <p className="flow-failed" role="alert">{depositFailureCopy(state.failure, token?.symbol ?? null)}</p>
      ) : null}
      {state.name === 'deposit' && state.notice ? (
        <p className="panel-notice notice-error" role="status">{state.notice}</p>
      ) : null}
    </section>
  );
}

/**
 * The commit point. The only confirm button is `ConfirmGate`'s, with the
 * register's approved deposit disclosure right above it (D-020, D-024). No fee
 * figure is shown: the wallet takes the pool's fee out of the deposit, in the
 * deposited token, so the note says so without a number. A STRK deposit no
 * larger than that fee gets a plain warning in its place instead, and can
 * still be confirmed: there is no minimum.
 */
function ReviewCard({ gate, state }: { gate: EntryGateMachine; state: Of<'review' | 'depositing'> }) {
  const { review } = state;
  const depositing = state.name === 'depositing';
  return (
    <>
      <WalletAttentionCue active={depositing && state.stage === 'awaiting-approval'} kind="confirm" />
      <section className="room room-entry" data-testid="entry-gate" data-gate={state.name}>
        <h2>{COPY.entry.depositTitle}</h2>
        <div className="panel-review">
          <h3>{COPY.flow.review}</h3>
          <ul className="batch-list">
            <li>{`${COPY.entry.deposit} ${formatTokenAmountExact(review.amount, review.token.decimals)} ${review.token.symbol}`}</li>
          </ul>
          {review.feeTakesAll ? (
            <p className="panel-notice" role="status" data-warning="fee-takes-all">{COPY.entry.feeTakesAll}</p>
          ) : (
            <p className="panel-hint">{COPY.entry.feeNote}</p>
          )}
          {review.warnings.length > 0 ? (
            <ul className="review-warnings">
              {describeWarnings(review.warnings, [{ kind: 'shield', token: review.token.token, amount: review.amount }]).map(
                (text, index) => <li key={`${review.warnings[index]!.kind}-${index}`}>{text}</li>,
              )}
            </ul>
          ) : null}
          {depositing ? (
            <p className="flow-pending" aria-live="polite" data-stage={state.stage}>
              {stageCopy(state.stage)}
            </p>
          ) : null}
          <ConfirmGate
            disclosures={review.disclosures}
            requiresDisclosure={review.requiresDisclosure}
            busy={depositing}
            onConfirm={() => void gate.confirm()}
            onCancel={() => gate.cancelReview()}
          />
        </div>
      </section>
    </>
  );
}

/**
 * A sent deposit. While the receipt is watched there is nothing to press;
 * once the watch ends, unconfirmed or unable to reach the network check, the
 * player can watch again (no prompt) or ask the wallet for the balance.
 */
function LandingCard({ gate, state }: { gate: EntryGateMachine; state: Of<'landing' | 'unconfirmed' | 'receipt-unreachable'> }) {
  const landing = state.name === 'landing';
  return (
    <section
      className="room room-entry"
      data-testid="entry-gate"
      data-gate={state.name}
      aria-busy={landing ? 'true' : undefined}
    >
      <h2>{COPY.entry.depositTitle}</h2>
      {landing ? (
        <p className="flow-pending" aria-live="polite">{COPY.entry.landing}</p>
      ) : (
        <p role="status">{state.name === 'receipt-unreachable' ? COPY.entry.receiptUnreachable : COPY.entry.unconfirmed}</p>
      )}
      <p className="room-detail">
        {COPY.flow.submitted} <code>{shortenAddress(state.transactionHash)}</code>
      </p>
      {landing ? null : (
        <>
          <button type="button" onClick={() => void gate.checkDeposit()}>
            {COPY.entry.checkAgain}
          </button>
          <BalanceCheck gate={gate} />
        </>
      )}
    </section>
  );
}

/**
 * What went wrong with a deposit. A 119 here is about the wallet's public
 * balance of the chosen token, which a shield draws on, so it does not take
 * `COPY.errors`' line about the shielded balance.
 */
function depositFailureCopy(failure: DepositFailure, symbol: string | null): string {
  if (failure === 'reverted') return COPY.entry.reverted;
  if (failure === 'insufficient-balance') {
    return [COPY.entry.publicShortLead, symbol, COPY.entry.publicShortTail].filter(Boolean).join(' ');
  }
  return COPY.errors[failure];
}
