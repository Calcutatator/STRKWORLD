import { useEffect, useMemo } from 'react';
import { COPY } from '../../copy.js';
import { formatStrk, formatStrkExact, formatTokenAmount, formatTokenAmountExact, shortenAddress } from '../../format.js';
import { usePrivacy } from '../../privacy/PrivacyProvider.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import { useStore } from '../../store/use-store.js';
import { ConfirmGate } from '../ConfirmGate.js';
import { GlossaryTerm } from '../Glossary.js';
import { AmountField, AmountSummary, checkAmount, primaryAction, totalAcross, type AmountSummaryProps, type DetailRow } from '../kit/index.js';
import { estimateText, rateRow, strkForXstrk, type EndurRateView } from './endur-rate.js';
import { voyagerContractUrl } from '../vault/vault-machine.js';
import {
  XSTRK_DECIMALS,
  createUnstakePanel,
  formatTimeLeft,
  hasClaimable,
  type UnstakePanel,
  type UnstakeState,
} from './unstake-machine.js';

/** An xSTRK figure: up to eight decimal places, truncated. */
function formatXstrk(amount: bigint): string {
  return `${formatTokenAmount(amount, XSTRK_DECIMALS, 8)} xSTRK`;
}

/** An xSTRK figure the player agrees to: exact. */
function formatXstrkExact(amount: bigint): string {
  return `${formatTokenAmountExact(amount, XSTRK_DECIMALS)} xSTRK`;
}

/**
 * The Bank's unstaking counter (D-085), under the stake form in Endur's look.
 *
 * A thin view over `unstake-machine.ts`. It renders nothing when this build
 * has not switched unstaking on, says plainly when the wallet cannot run a
 * shadow account, and its only confirm button is inside `ConfirmGate`, which
 * cannot render without the prepared route's approved disclosure.
 */
export function UnstakeCounter({
  panel: injected,
  register = PRIVACY_REGISTER,
  rate = { status: 'unavailable' },
  poolFee = null,
}: {
  /** Supply a driven machine to render a specific state. Tests use this. */
  panel?: UnstakePanel;
  register?: readonly RouteGrade[];
  /** xSTRK's live rate, read once by the staking view (D-091). */
  rate?: EndurRateView;
  /** The pool fee the Bank read live, for the preview row; null hides the row. */
  poolFee?: bigint | null;
}) {
  const { operations, receipts, noteOperationError, submissionUncertainty } = usePrivacy();
  const owned = useMemo(
    () =>
      injected
        ? null
        : createUnstakePanel({
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

  useEffect(() => {
    if (!owned) return;
    void owned.open();
    return () => owned.close();
  }, [owned]);

  // Not switched on in this build: the stake counter's own line already says
  // how unstaking works, and a locked form would offer nothing.
  if (!state.door.open) {
    return (
      <section className="unstake-counter" data-state="locked" aria-label={COPY.unstake.title}>
        <h3>{COPY.unstake.title}</h3>
        <p className="stake-note">{state.door.message}</p>
      </section>
    );
  }

  const committing = state.flow.name === 'review' || state.flow.name === 'submitting';
  return (
    <section className="unstake-counter" aria-label={COPY.unstake.title}>
      <h3>{COPY.unstake.title}</h3>
      <p className="panel-intro">{COPY.unstake.intro}</p>
      {state.capability.status === 'checking' ? (
        <p aria-busy="true">{COPY.vault.checking}</p>
      ) : state.capability.status === 'unsupported' ? (
        <p className="unstake-unsupported" role="alert">{COPY.errors['shadow-accounts-unsupported']}</p>
      ) : state.capability.status === 'failed' ? (
        <div className="flow-failed" role="alert">
          <p>{state.capability.message}</p>
          <button type="button" onClick={() => void panel.recheck()}>{COPY.vault.recheck}</button>
        </div>
      ) : (
        <>
          {committing ? (
            <ReviewBlock state={state} onConfirm={() => void panel.confirm()} onCancel={() => panel.cancelPrepared()} />
          ) : state.flow.name === 'submitted' ? (
            <SubmittedBlock state={state} onBack={() => panel.acknowledge()} />
          ) : (
            <ComposeBlock state={state} panel={panel} rate={rate} poolFee={poolFee} />
          )}
          {/* The pending requests sit under the form, as Endur's withdraw log
              does, with the claim beside them. */}
          <RequestsBlock state={state} panel={panel} />
          {committing || state.flow.name === 'submitted' ? null : <ClaimAction state={state} panel={panel} />}
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
        <p className={`panel-notice notice-${state.notice.tone}`} role="status">{state.notice.text}</p>
      ) : null}
    </section>
  );
}

/** The requests, read only when the player asks, each with its time left by the chain's clock. */
function RequestsBlock({ state, panel }: { state: UnstakeState; panel: UnstakePanel }) {
  const { position } = state;
  if (position.status === 'unrequested') {
    return (
      <div className="unstake-requests">
        <button type="button" onClick={() => void panel.refreshPosition()}>{COPY.unstake.readRequests}</button>
      </div>
    );
  }
  if (position.status === 'loading') return <p className="unstake-requests" aria-busy="true">{COPY.unstake.loading}</p>;
  if (position.status === 'failed') {
    return (
      <div className="unstake-requests flow-failed" role="alert">
        <p>{position.message}</p>
        <button type="button" onClick={() => void panel.refreshPosition()}>{COPY.unstake.readAgain}</button>
      </div>
    );
  }
  const href = voyagerContractUrl(position.standIn);
  return (
    <div className="unstake-requests">
      {position.requests.length === 0 ? (
        <p className="unstake-none">{COPY.unstake.none}</p>
      ) : (
        <>
          <h4>{COPY.unstake.pendingTitle}</h4>
          <ul className="unstake-list">
            {position.requests.map((request) => (
              <li key={request.requestId.toString()} data-status={request.status}>
                <span className="unstake-owed">{`${COPY.unstake.owedLead} ${formatStrk(request.assets)}`}</span>{' '}
                <span className="unstake-when">
                  {request.status === 'ready'
                    ? COPY.unstake.statusReady
                    : request.status === 'awaiting-funds'
                      ? COPY.unstake.statusAwaitingFunds
                      : `${formatTimeLeft(request.secondsLeft)} ${COPY.unstake.statusWaiting}`}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {position.strkHeld > 0n ? (
        <p className="unstake-held">{`${COPY.unstake.heldLead} ${formatStrk(position.strkHeld)}`}</p>
      ) : null}
      {position.xstrkHeld > 0n ? (
        <p className="unstake-leftover">{`${COPY.unstake.leftoverLead} ${formatXstrk(position.xstrkHeld)}`}</p>
      ) : null}
      {position.unlisted > 0 ? <p className="unstake-unlisted">{COPY.unstake.unlisted}</p> : null}
      {position.complete ? null : <p className="unstake-incomplete" role="status">{COPY.unstake.incomplete}</p>}
      {href ? (
        <p className="vault-stand-in">
          {`${COPY.unstake.standInLead} `}
          <code>{shortenAddress(position.standIn)}</code>
          {`, ${COPY.unstake.standInTail} `}
          <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{COPY.unstake.voyager}</a>
          <span className="vault-stand-in-note">{COPY.unstake.voyagerNote}</span>
        </p>
      ) : null}
      <p className="vault-as-of">{COPY.unstake.readNote}</p>
      <button type="button" onClick={() => void panel.refreshPosition()}>{COPY.unstake.readAgain}</button>
    </div>
  );
}

function ComposeBlock({ state, panel, rate, poolFee }: { state: UnstakeState; panel: UnstakePanel; rate: EndurRateView; poolFee: bigint | null }) {
  const preparing = state.flow.name === 'preparing';
  // The xSTRK balance is read only when a request is reviewed (the figure
  // never leaves the machine), so there is no balance line and no Max here.
  const check = checkAmount(state.amountText, { decimals: XSTRK_DECIMALS });
  const action = primaryAction({ check, symbol: 'xSTRK', ready: COPY.unstake.request, busy: preparing ? COPY.flow.preparing : null });
  return (
    <>
      <form
        className="panel-compose unstake-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void panel.prepareRequest();
        }}
      >
        <AmountField
          label={COPY.unstake.amount}
          name="unstake-amount"
          value={state.amountText}
          onChange={(text) => panel.setAmount(text)}
          decimals={XSTRK_DECIMALS}
          symbol="xSTRK"
          disabled={preparing}
        />
        {state.noXstrk ? <p className="unstake-holding-none" role="status">{COPY.unstake.noXstrk}</p> : null}
        <AmountSummary {...unstakeSummary(check.amount, rate, poolFee)} label={COPY.kit.amountsLabel} />
        <p className="stake-note">{COPY.unstake.wait}</p>
        <button type="submit" className="review" disabled={action.disabled}>
          {action.label}
        </button>
      </form>
    </>
  );
}

/** The claim, once the requests are read: offered only when something is claimable (D-085). */
function ClaimAction({ state, panel }: { state: UnstakeState; panel: UnstakePanel }) {
  const preparing = state.flow.name === 'preparing';
  const claimable = hasClaimable(state.position);
  return (
    <>
      {state.claimDoor.open && state.position.status === 'loaded' ? (
        claimable ? (
          <button type="button" className="unstake-claim" disabled={preparing} onClick={() => void panel.prepareClaim()}>
            {COPY.unstake.claim}
          </button>
        ) : (
          <p className="unstake-nothing-ready">{COPY.unstake.nothingReady}</p>
        )
      ) : null}
    </>
  );
}

/**
 * Endur's unstake figures in the owner's order (D-091, D-103): the xSTRK you
 * send, what comes back at today's rate, the pool fee on top (in STRK), and
 * the total from your pool in each token; then the rate and the wait D-085
 * measured on chain. Estimates only: the request fixes its STRK when it runs.
 */
function unstakeSummary(shares: bigint | null, rate: EndurRateView, poolFee: bigint | null): AmountSummaryProps {
  const typed = shares ?? 0n;
  const estimate = rate.status === 'loaded' && shares !== null
    ? estimateText(strkForXstrk(shares, rate.strkPerXstrk), 'STRK')
    : null;
  return {
    entered: { label: COPY.unstake.youUnstake, value: formatXstrk(typed) },
    receive: { label: COPY.stake.willReceive, value: estimate ?? '—' },
    fees: poolFee === null ? [] : [{
      id: 'fee',
      label: <GlossaryTerm term={COPY.bank.poolFee} definition={COPY.glossary.poolFee} />,
      value: formatStrk(poolFee),
      note: COPY.unstake.feeNote,
    }],
    total: poolFee === null ? null : { label: COPY.kit.totalFromPool, value: unstakeTotal(typed, poolFee, false) },
    details: [rateRow(rate), { id: 'wait', label: COPY.unstake.waitingTime, value: COPY.unstake.waitValue }],
  };
}

/** What leaves the pool for a request: the xSTRK sent and the pool fee in STRK, two tokens. */
function unstakeTotal(shares: bigint, poolFee: bigint, exact: boolean): string {
  return totalAcross([
    { token: 'xSTRK', amount: shares, format: exact ? formatXstrkExact : formatXstrk },
    { token: 'STRK', amount: poolFee, format: exact ? formatStrkExact : formatStrk },
  ]);
}

function ReviewBlock({ state, onConfirm, onCancel }: { state: UnstakeState; onConfirm: () => void; onCancel: () => void }) {
  const flow = state.flow;
  if (flow.name !== 'review' && flow.name !== 'submitting') return null;
  const { summary } = flow;
  const { action } = summary;
  return (
    <div className="panel-review">
      <h3>{COPY.flow.review}</h3>
      {/* D-103: entered, what comes back, the fees on top, the total, in exact figures. */}
      {action.kind === 'request' ? (
        <>
          <AmountSummary
            entered={{ label: COPY.unstake.youUnstake, value: formatXstrkExact(action.shares) }}
            receive={{ label: COPY.stake.youReceive, value: COPY.unstake.receiveLater }}
            fees={reviewFees(summary.poolFee)}
            total={{ label: COPY.kit.totalFromPool, value: unstakeTotal(action.shares, summary.poolFee, true) }}
            details={action.leftover > 0n ? [{ id: 'leftover', label: COPY.unstake.reviewLeftover, value: formatXstrkExact(action.leftover) }] : []}
            label={COPY.flow.review}
          />
          <p className="stake-review-note">{COPY.unstake.reviewRequestTail}</p>
        </>
      ) : (
        <>
          {/* A claim moves what Endur paid the stand-in, not the pool: only the fee leaves the pool. */}
          <AmountSummary
            entered={{ label: COPY.unstake.reviewClaim, value: formatStrkExact(action.owed + action.held) }}
            receive={{ label: COPY.stake.youReceive, value: formatStrkExact(action.owed + action.held) }}
            fees={reviewFees(summary.poolFee)}
            total={{ label: COPY.kit.totalFromPool, value: formatStrkExact(summary.poolFee) }}
            details={action.requestIds.length > 0 ? [{ id: 'requests', label: COPY.unstake.requestsCount, value: String(action.requestIds.length) }] : []}
            label={COPY.flow.review}
          />
          <p className="stake-review-note">{COPY.unstake.reviewClaimTail}</p>
        </>
      )}
      {flow.name === 'submitting' ? (
        <p className="flow-pending" aria-live="polite" data-stage={flow.stage}>{flow.message}</p>
      ) : null}
      <ConfirmGate
        disclosures={summary.disclosures}
        busy={flow.name === 'submitting'}
        countsTowardPlacement={summary.countsTowardPlacement === true}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </div>
  );
}

/** The review's fees: the pool fee, exact, and the network fee the wallet states itself (D-082). */
function reviewFees(poolFee: bigint): DetailRow[] {
  return [
    {
      id: 'fee',
      label: <GlossaryTerm term={COPY.bank.poolFee} definition={COPY.glossary.poolFee} />,
      value: <span title={COPY.bank.poolFeeNote}>{formatStrkExact(poolFee)}</span>,
    },
    {
      id: 'network',
      label: <GlossaryTerm term={COPY.bank.networkCost} definition={COPY.glossary.networkCost} />,
      value: COPY.unstake.networkByWallet,
    },
  ];
}

function SubmittedBlock({ state, onBack }: { state: UnstakeState; onBack: () => void }) {
  const flow = state.flow;
  if (flow.name !== 'submitted') return null;
  return (
    <div className="flow-done" aria-live="polite" data-outcome={flow.outcome}>
      <p>
        {COPY.unstake.submitted[flow.outcome]} <code>{shortenAddress(flow.transactionHash)}</code>
      </p>
      <button type="button" onClick={onBack}>{COPY.flow.back}</button>
    </div>
  );
}
