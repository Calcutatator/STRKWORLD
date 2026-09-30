import { useEffect, useMemo } from 'react';
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
import { VAULT_MARKET_GROUPS, type VaultMarketGroup } from '../../production/vesu-markets.js';
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
  noneInPoolLine,
  voyagerContractUrl,
  type VaultMode,
  type VaultPanel as VaultPanelMachine,
  type VaultState,
  type VaultTokenView,
} from './vault-machine.js';

const VAULT_MODES: readonly VaultMode[] = ['supply', 'redeem'];

/** A position figure: up to eight decimal places, truncated, with the token's symbol (D-079). */
function formatHolding(amount: bigint, token: VaultTokenView): string {
  return `${formatTokenAmount(amount, token.decimals, Math.min(token.decimals, 8))} ${token.symbol}`;
}

/** A figure the player agrees to: exact, in the token's decimals, with its symbol. */
function formatExact(amount: bigint, token: VaultTokenView): string {
  return `${formatTokenAmountExact(amount, token.decimals)} ${token.symbol}`;
}

/**
 * The offered tokens by picker group (D-081), in the groups' fixed order and
 * the build's order within each; a group with nothing offered is left out.
 */
function groupsOf(tokens: readonly VaultTokenView[]): Array<{ group: VaultMarketGroup; tokens: VaultTokenView[] }> {
  return VAULT_MARKET_GROUPS
    .map((group) => ({ group, tokens: tokens.filter((entry) => entry.group === group) }))
    .filter((entry) => entry.tokens.length > 0);
}

/** A market's pool as the counter names it: "Prime", or "Re7 xBTC, curated" (D-081). */
function poolLabel(token: VaultTokenView): string {
  return token.curation === 'prime' ? token.poolName : `${token.poolName}, ${COPY.vault.pools.curated}`;
}

/**
 * The Vault (D-077): lending with Vesu, from the player's STRK20 shadow
 * account, in Vesu's look, in every token this build admits (D-079), across
 * Vesu's Prime pool and the curated pools the pinned markets name (D-081).
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
  const token = state.token === null ? undefined : state.tokens.find((entry) => sameAddress(entry.token, state.token!));

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
        <VaultIntro token={token} />
        <ModeTabs state={state} register={register} onSelect={(mode) => panel.setMode(mode)} />

        {!state.door.open ? (
          <LockedNotice reason={state.door.reason ?? 'unknown-route'} message={state.door.message} />
        ) : !token ? (
          <LockedNotice reason="not-enabled" message={COPY.vault.noToken} />
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
              <ComposeBlock state={state} token={token} panel={panel} />
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
 * The counter's header: whose vaults these are, what they do, and what a
 * lender must know about fees to get back out. None of it is a disclosure;
 * what is public is the register's to say, at the commit point. While a token
 * other than STRK is chosen, a second note says the pool fee is set in STRK
 * and the wallet may take it in STRK (D-079).
 */
function VaultIntro({ token }: { token: VaultTokenView | undefined }) {
  const otherToken = token !== undefined && !sameAddress(token.token, STRK_TOKEN);
  return (
    <div className="vault-intro">
      <p className="vault-eyebrow">{COPY.vault.eyebrow}</p>
      <p className="panel-intro">{COPY.vault.intro}</p>
      <p className="vault-note">{COPY.vault.feeNote}</p>
      {otherToken ? <p className="vault-note vault-fee-token">{COPY.vault.feeInStrk}</p> : null}
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

/**
 * Every offered market, grouped as the picker groups them (D-081), each with
 * its pool, Vesu's supply APY where Vesu states one (read when the counter
 * opens, no prompt) and the position once the player asks for it: a public
 * read, after the wallet's commitment. The figures are one read, and say so;
 * the stand-in address they sit on is public, and the line under them says
 * that too, with a link the player may open.
 */
function PositionBlock({ state, onRefresh }: { state: VaultState; onRefresh: () => void }) {
  const { position, rates } = state;
  const loaded = position.status === 'loaded' ? position : null;
  const anyCurated = state.tokens.some((entry) => entry.curation === 'curated');
  return (
    <div className="panel-balance vault-position">
      <h3>{COPY.vault.position.title}</h3>
      <div className="vault-market-groups">
        {groupsOf(state.tokens).map(({ group, tokens }) => (
          <section key={group} className="vault-market-group" data-group={group}>
            <h4 className="vault-group-title">{COPY.vault.groups[group]}</h4>
            <ul className="vault-markets">
              {tokens.map((entry) => {
                const rate = rates.status === 'loaded' ? rates.rates.find((candidate) => sameAddress(candidate.token, entry.token)) : undefined;
                const held = loaded?.positions.find((candidate) => sameAddress(candidate.token, entry.token));
                const chosen = state.token !== null && sameAddress(state.token, entry.token);
                return (
                  <li
                    key={entry.token}
                    className="vault-market"
                    data-token={entry.symbol}
                    data-curation={entry.curation}
                    aria-current={chosen ? 'true' : undefined}
                  >
                    <p className="vault-market-head">
                      <strong className="vault-market-symbol">{entry.symbol}</strong>
                      <span className="vault-market-pool">{poolLabel(entry)}</span>
                      {rate ? (
                        <span className="vault-apy">
                          {`${COPY.vault.rates.label} ${formatRatePercent(rate.value, rate.decimals)}, ${COPY.vault.rates.source}`}
                        </span>
                      ) : null}
                    </p>
                    {held === undefined ? null : held.shares === 0n ? (
                      <p className="vault-market-none">{COPY.vault.position.none}</p>
                    ) : (
                      <dl className="vault-figures">
                        <dt>{COPY.vault.position.worth}</dt>
                        <dd className="balance-total">{formatHolding(held.assets, entry)}</dd>
                        <dt>{COPY.vault.position.redeemable}</dt>
                        <dd>{formatHolding(held.redeemable, entry)}</dd>
                      </dl>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      {anyCurated ? <p className="vault-curated-note">{COPY.vault.pools.curatedNote}</p> : null}
      {rates.status === 'failed' ? <p className="vault-rates-note">{COPY.vault.rates.unavailable}</p> : null}
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
          {position.positions.every((entry) => entry.shares === 0n) ? <p>{COPY.vault.position.empty}</p> : null}
          <p className="vault-as-of">{COPY.vault.position.asOf}</p>
          <button type="button" onClick={onRefresh}>{COPY.vault.position.again}</button>
          <StandInLine address={position.standIn} />
        </>
      )}
    </div>
  );
}

/**
 * The stand-in address is public (D-079): a short line saying so, and an
 * optional Voyager link, which opens a new tab without telling Voyager where
 * it came from. The address lives in this render only.
 */
function StandInLine({ address }: { address: string }) {
  const href = voyagerContractUrl(address);
  if (href === null) return null;
  return (
    <p className="vault-stand-in">
      {`${COPY.vault.standIn.lead} `}
      <code>{shortenAddress(address)}</code>
      {`, ${COPY.vault.standIn.tail} `}
      <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
        {COPY.vault.standIn.voyager}
      </a>
      <span className="vault-stand-in-note">{COPY.vault.standIn.voyagerNote}</span>
    </p>
  );
}

/**
 * The form: a grouped token picker (D-081) when there is more than one token,
 * the chosen market's pool, and for a supply the line saying it comes from the
 * pool balance, or, once a review found none of the token there, that there is
 * nothing to supply.
 */
function ComposeBlock({ state, token, panel }: { state: VaultState; token: VaultTokenView; panel: VaultPanelMachine }) {
  const preparing = state.flow.name === 'preparing';
  const all = state.mode === 'redeem' && state.redeemAll;
  const noneHeld = state.holding.status === 'none' && sameAddress(state.holding.token, token.token);
  return (
    <form
      className="panel-compose"
      onSubmit={(event) => {
        event.preventDefault();
        void panel.prepare();
      }}
    >
      {state.tokens.length > 1 ? (
        <label>
          {COPY.vault.token}
          <select
            name="token"
            value={token.token}
            disabled={preparing}
            onChange={(event) => panel.setToken(event.target.value)}
          >
            {groupsOf(state.tokens).map(({ group, tokens }) => (
              <optgroup key={group} label={COPY.vault.groups[group]}>
                {tokens.map((entry) => (
                  <option key={entry.token} value={entry.token}>
                    {entry.curation === 'prime' ? entry.symbol : `${entry.symbol} (${entry.poolName})`}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      ) : null}
      <p className="vault-pool" data-curation={token.curation}>
        {`${COPY.vault.pools.label}: ${poolLabel(token)}`}
      </p>
      {state.mode === 'supply' ? (
        noneHeld ? (
          <p className="vault-holding vault-holding-none" role="status">{noneInPoolLine(token)}</p>
        ) : (
          <p className="vault-holding">{`${COPY.vault.holding.neededLead} ${token.symbol} ${COPY.vault.holding.neededTail}`}</p>
        )
      ) : null}
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
          {`${COPY.vault.amount} (${token.symbol})`}
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
 * is the wallet's to state when it asks, so no total is invented here. The
 * pool fee is the pool's, in STRK; for another token the review says the
 * wallet chooses which token pays it (D-079).
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
  const { action, token } = summary;
  const all = action.kind === 'redeem' && action.all;
  const otherToken = !sameAddress(token.token, STRK_TOKEN);
  return (
    <div className="panel-review">
      <h3>{COPY.flow.review}</h3>
      <dl className="vault-review">
        <dt>{action.kind === 'supply' ? COPY.vault.review.supply : all ? COPY.vault.review.redeemAll : COPY.vault.review.redeem}</dt>
        <dd>{formatExact(action.amount, token)}</dd>
      </dl>
      {action.kind === 'redeem' ? (
        <p className="vault-review-note">
          {all ? `${COPY.vault.review.allNote} ` : ''}
          {`${COPY.vault.review.landsInLead} ${token.symbol} ${COPY.vault.review.landsInTail}`}
        </p>
      ) : null}
      <dl className="review-costs">
        <dt><GlossaryTerm term={COPY.bank.poolFee} definition={COPY.glossary.poolFee} /></dt>
        <dd title={COPY.bank.poolFeeNote}>{formatStrkExact(summary.poolFee)}</dd>
        <dt><GlossaryTerm term={COPY.bank.networkCost} definition={COPY.glossary.networkCost} /></dt>
        <dd>{COPY.vault.review.networkByWallet}</dd>
      </dl>
      {otherToken ? <p className="vault-review-note vault-fee-token">{COPY.vault.review.feeTokenByWallet}</p> : null}
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
