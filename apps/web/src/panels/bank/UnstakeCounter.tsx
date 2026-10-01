import { useEffect, useMemo } from 'react';
import { COPY } from '../../copy.js';
import { formatStrk, formatStrkExact, formatTokenAmount, formatTokenAmountExact, shortenAddress } from '../../format.js';
import { usePrivacy } from '../../privacy/PrivacyProvider.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import { useStore } from '../../store/use-store.js';
import { ConfirmGate } from '../ConfirmGate.js';
import { GlossaryTerm } from '../Glossary.js';
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
}: {
  /** Supply a driven machine to render a specific state. Tests use this. */
  panel?: UnstakePanel;
  register?: readonly RouteGrade[];
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
      <p className="stake-note">{COPY.unstake.wait}</p>
      <p className="stake-note">{COPY.unstake.feeNote}</p>
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
          <RequestsBlock state={state} panel={panel} />
          {committing ? (
            <ReviewBlock state={state} onConfirm={() => void panel.confirm()} onCancel={() => panel.cancelPrepared()} />
          ) : state.flow.name === 'submitted' ? (
            <SubmittedBlock state={state} onBack={() => panel.acknowledge()} />
          ) : (
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

function ComposeBlock({ state, panel }: { state: UnstakeState; panel: UnstakePanel }) {
  const preparing = state.flow.name === 'preparing';
  const claimable = hasClaimable(state.position);
  return (
    <>
      <form
        className="panel-compose unstake-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void panel.prepareRequest();
        }}
      >
        <label>
          {COPY.unstake.amount}
          <input
            name="unstake-amount"
            inputMode="decimal"
            autoComplete="off"
            value={state.amountText}
            disabled={preparing}
            onChange={(event) => panel.setAmount(event.target.value)}
          />
        </label>
        {state.noXstrk ? <p className="unstake-holding-none" role="status">{COPY.unstake.noXstrk}</p> : null}
        <button type="submit" className="review" disabled={preparing}>
          {preparing ? COPY.flow.preparing : COPY.unstake.request}
        </button>
      </form>
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

function ReviewBlock({ state, onConfirm, onCancel }: { state: UnstakeState; onConfirm: () => void; onCancel: () => void }) {
  const flow = state.flow;
  if (flow.name !== 'review' && flow.name !== 'submitting') return null;
  const { summary } = flow;
  const { action } = summary;
  return (
    <div className="panel-review">
      <h3>{COPY.flow.review}</h3>
      {action.kind === 'request' ? (
        <>
          <dl className="stake-review">
            <dt>{COPY.unstake.reviewRequest}</dt>
            <dd>{formatXstrkExact(action.shares)}</dd>
            {action.leftover > 0n ? (
              <>
                <dt>{COPY.unstake.reviewLeftover}</dt>
                <dd>{formatXstrkExact(action.leftover)}</dd>
              </>
            ) : null}
          </dl>
          <p className="stake-review-note">{COPY.unstake.reviewRequestTail}</p>
        </>
      ) : (
        <>
          <dl className="stake-review">
            <dt>{COPY.unstake.reviewClaim}</dt>
            <dd>{formatStrkExact(action.owed + action.held)}</dd>
            {action.requestIds.length > 0 ? (
              <>
                <dt>{COPY.unstake.requestsCount}</dt>
                <dd>{action.requestIds.length}</dd>
              </>
            ) : null}
          </dl>
          <p className="stake-review-note">{COPY.unstake.reviewClaimTail}</p>
        </>
      )}
      <dl className="review-costs">
        <dt><GlossaryTerm term={COPY.bank.poolFee} definition={COPY.glossary.poolFee} /></dt>
        <dd title={COPY.bank.poolFeeNote}>{formatStrkExact(summary.poolFee)}</dd>
        <dt><GlossaryTerm term={COPY.bank.networkCost} definition={COPY.glossary.networkCost} /></dt>
        <dd>{COPY.unstake.networkByWallet}</dd>
      </dl>
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
