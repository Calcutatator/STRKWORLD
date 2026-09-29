import { useEffect, useMemo } from 'react';
import { COPY } from '../../copy.js';
import { formatStrk, formatStrkExact, shortenAddress } from '../../format.js';
import { usePrivacy } from '../../privacy/PrivacyProvider.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import { useStore } from '../../store/use-store.js';
import { WalletAttentionCue } from '../../wallet/WalletAttentionCue.js';
import { ConfirmGate } from '../ConfirmGate.js';
import { GlossaryTerm } from '../Glossary.js';
import { LockedNotice } from '../LockedRoom.js';
import { PanelFrame } from '../PanelFrame.js';
import { createPendingHudOwner } from '../pending-hud.js';
import { routeDoor } from '../routes.js';
import {
  ROUTE_BY_VAULT_MODE,
  createVaultPanel,
  type VaultMode,
  type VaultPanel as VaultPanelMachine,
  type VaultState,
} from './vault-machine.js';

const VAULT_MODES: readonly VaultMode[] = ['supply', 'redeem'];

/**
 * The Vault (D-077): lending with Vesu, from the player's STRK20 shadow
 * account, in Vesu's look.
 *
 * A thin view over `vault-machine.ts`, like the Bank over its machine. It
 * enforces what is purely about rendering: a route this build has not
 * switched on shows a locked door rather than a form nobody can submit; a
 * wallet that cannot run a shadow account is told so instead of being shown a
 * form; and the only confirm button is inside `ConfirmGate`, which cannot
 * render without the prepared route's approved disclosure. The Game Mode
 * counter and Menu Mode render the same window: the Vault confirms one action
 * at a time either way.
 */
export function VaultPanel({
  onClose,
  panel: injected,
  experience = 'menu',
  register = PRIVACY_REGISTER,
}: {
  onClose: () => void;
  /** Supply a driven machine to render a specific state. Tests use this. */
  panel?: VaultPanelMachine;
  experience?: 'menu' | 'station';
  register?: readonly RouteGrade[];
}) {
  const { operations, receipts, noteOperationError, shellBus, submissionUncertainty } = usePrivacy();
  const owned = useMemo(
    () =>
      injected
        ? null
        : createVaultPanel({
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
  // The position read asks the wallet for a commitment, which it may confirm
  // with the player first; a submission waits on the player's approval.
  const attention = state.position.status === 'loading'
    ? 'connect'
    : state.flow.name === 'submitting' && state.flow.stage === 'awaiting-approval'
      ? 'confirm'
      : null;

  return (
    <div className="vault-experience" data-experience={experience}>
      <WalletAttentionCue active={attention !== null} kind={attention ?? 'confirm'} />
      <PanelFrame
        title={COPY.buildings.vault}
        building="vault"
        // Previewed while composing; at the commit point ConfirmGate carries it.
        disclosure={committing ? null : state.disclosure}
        closingNote={state.flow.name === 'submitting' ? COPY.flow.closingWillNotCancel : null}
        onClose={onClose}
      >
        <VaultIntro />
        <ModeTabs state={state} register={register} onSelect={(mode) => panel.setMode(mode)} />

        {!state.door.open ? (
          <LockedNotice reason={state.door.reason ?? 'unknown-route'} message={state.door.message} />
        ) : state.capability.status === 'checking' ? (
          <p className="vault-checking" aria-busy="true">{COPY.vault.checking}</p>
        ) : state.capability.status === 'unsupported' ? (
          <p className="vault-unsupported" role="alert">{COPY.errors['shadow-accounts-unsupported']}</p>
        ) : state.capability.status === 'failed' ? (
          <div className="flow-failed" role="alert">
            <p>{state.capability.message}</p>
            <button type="button" onClick={() => void panel.recheck()}>{COPY.vault.recheck}</button>
          </div>
        ) : (
          <>
            <PositionBlock state={state} onRefresh={() => void panel.refreshPosition()} />
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

/**
 * The counter's header: whose vault this is, what it does, and the one thing
 * about fees a lender must know to get back out. None of it is a disclosure;
 * what is public is the register's to say, at the commit point.
 */
function VaultIntro() {
  return (
    <div className="vault-intro">
      <p className="vault-eyebrow">{COPY.vault.eyebrow}</p>
      <p className="panel-intro">{COPY.vault.intro}</p>
      <p className="vault-note">{COPY.vault.feeNote}</p>
    </div>
  );
}

function ModeTabs({
  state,
  register,
  onSelect,
}: {
  state: VaultState;
  register: readonly RouteGrade[];
  onSelect: (mode: VaultMode) => void;
}) {
  const labels: Record<VaultMode, string> = { supply: COPY.vault.supply, redeem: COPY.vault.redeem };
  return (
    <nav className="panel-modes" role="tablist">
      {VAULT_MODES.map((mode) => {
        const door = mode === state.mode ? state.door : routeDoor(ROUTE_BY_VAULT_MODE[mode], register);
        return (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={state.mode === mode}
            data-locked={door.open ? undefined : 'true'}
            onClick={() => onSelect(mode)}
          >
            {labels[mode]}
          </button>
        );
      })}
    </nav>
  );
}

/** The position, read only when the player asks: a public read, after the wallet's commitment. */
function PositionBlock({ state, onRefresh }: { state: VaultState; onRefresh: () => void }) {
  const { position } = state;
  return (
    <div className="panel-balance vault-position">
      <h3>{COPY.vault.position.title}</h3>
      {position.status === 'unrequested' ? (
        <>
          <p>{COPY.vault.position.unrequested}</p>
          <button type="button" onClick={onRefresh}>{COPY.vault.position.show}</button>
        </>
      ) : position.status === 'loading' ? (
        <p aria-busy="true">{COPY.vault.position.loading}</p>
      ) : position.status === 'failed' ? (
        <>
          <p role="alert">{position.message}</p>
          <button type="button" onClick={onRefresh}>{COPY.vault.position.again}</button>
        </>
      ) : (
        <>
          {position.shares === 0n ? (
            <p>{COPY.vault.position.empty}</p>
          ) : (
            <dl className="vault-figures">
              <dt>{COPY.vault.position.worth}</dt>
              <dd className="balance-total">{formatStrk(position.assets)}</dd>
              <dt>{COPY.vault.position.redeemable}</dt>
              <dd>{formatStrk(position.redeemable)}</dd>
            </dl>
          )}
          <button type="button" onClick={onRefresh}>{COPY.vault.position.again}</button>
        </>
      )}
    </div>
  );
}

function ComposeBlock({ state, panel }: { state: VaultState; panel: VaultPanelMachine }) {
  const preparing = state.flow.name === 'preparing';
  const all = state.mode === 'redeem' && state.redeemAll;
  return (
    <form
      className="panel-compose"
      onSubmit={(event) => {
        event.preventDefault();
        void panel.prepare();
      }}
    >
      {state.mode === 'redeem' ? (
        <label className="vault-all">
          <input
            type="checkbox"
            name="redeem-all"
            checked={state.redeemAll}
            onChange={(event) => panel.setRedeemAll(event.target.checked)}
          />
          {COPY.vault.redeemAll}
        </label>
      ) : null}
      {all ? null : (
        <label>
          {COPY.vault.amount}
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

/**
 * Review and submission are one surface, as in the Bank: the figures and the
 * approved disclosure stay on screen while the wallet works. The network fee
 * is the wallet's to state when it asks, so no total is invented here.
 */
function CommitBlock({
  state,
  onConfirm,
  onCancel,
}: {
  state: VaultState;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const flow = state.flow;
  if (flow.name !== 'review' && flow.name !== 'submitting') return null;
  const { summary } = flow;
  const { action } = summary;
  const all = action.kind === 'redeem' && action.all;
  return (
    <div className="panel-review">
      <h3>{COPY.flow.review}</h3>
      <dl className="vault-review">
        <dt>{action.kind === 'supply' ? COPY.vault.review.supply : all ? COPY.vault.review.redeemAll : COPY.vault.review.redeem}</dt>
        <dd>{formatStrkExact(action.amount)}</dd>
      </dl>
      {action.kind === 'redeem' ? (
        <p className="vault-review-note">
          {all ? `${COPY.vault.review.allNote} ` : ''}
          {COPY.vault.review.landsIn}
        </p>
      ) : null}
      <dl className="review-costs">
        <dt><GlossaryTerm term={COPY.bank.poolFee} definition={COPY.glossary.poolFee} /></dt>
        <dd title={COPY.bank.poolFeeNote}>{formatStrkExact(summary.poolFee)}</dd>
        <dt><GlossaryTerm term={COPY.bank.networkCost} definition={COPY.glossary.networkCost} /></dt>
        <dd>{COPY.vault.review.networkByWallet}</dd>
      </dl>
      {flow.name === 'submitting' ? (
        <p className="flow-pending" aria-live="polite" data-stage={flow.stage}>
          {flow.message}
        </p>
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

function SubmittedBlock({ state, onBack }: { state: VaultState; onBack: () => void }) {
  const flow = state.flow;
  if (flow.name !== 'submitted') return null;
  // A receipt found on reopening was recorded when the wallet answered; its
  // outcome was not seen here, so it reads as not confirmed yet.
  const text = flow.restored ? COPY.vault.submitted.pending : COPY.vault.submitted[flow.outcome];
  return (
    <div className="flow-done" aria-live="polite" data-outcome={flow.restored ? 'pending' : flow.outcome}>
      <p>
        {text} <code>{shortenAddress(flow.transactionHash)}</code>
      </p>
      <button type="button" onClick={onBack}>{COPY.flow.back}</button>
    </div>
  );
}
