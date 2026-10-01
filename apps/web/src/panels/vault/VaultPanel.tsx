import { useEffect, useMemo, type ReactNode } from 'react';
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
import { AmountField, DetailRows, checkAmount, feeReserve, maxAfterReserve, primaryAction, type DetailRow } from '../kit/index.js';
import { createPendingHudOwner } from '../pending-hud.js';
import { routeDoor } from '../routes.js';
import {
  ROUTE_BY_VAULT_MODE,
  createVaultPanel,
  noneInPoolLine,
  poolBalanceOf,
  positionOf,
  redeemsWholePosition,
  tidyVaultAmount,
  vaultChoices,
  vaultListedMarkets,
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
  counters = null,
}: {
  onClose: () => void;
  /** Supply a driven machine to render a specific state. Tests use this. */
  panel?: VaultPanelMachine;
  experience?: 'menu' | 'station';
  register?: readonly RouteGrade[];
  /** Menu Mode's counter tabs (D-088); presentation only. */
  counters?: ReactNode;
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
  // D-081: the mode's own choices: a supply never offers a collateral-only market.
  const token = state.token === null ? undefined : vaultChoices(state, state.mode).find((entry) => sameAddress(entry.token, state.token!));

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
        counters={counters}
      >
        <VaultIntro token={token} />
        <ModeTabs state={state} register={register} onSelect={(mode) => panel.setMode(mode)} />

        {!state.door.open ? (
          <LockedNotice reason={state.door.reason ?? 'unknown-route'} message={state.door.message} />
        ) : state.tokens.length === 0 ? (
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
            ) : gateBlocked || (state.flow.name === 'failed' && state.flow.recovery === 'close') ? null : token ? (
              <ComposeBlock state={state} token={token} panel={panel} />
            ) : (
              <p className="vault-no-choice">{state.mode === 'supply' ? COPY.vault.noSupply : COPY.vault.noRedeem}</p>
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
  // D-081: markets Vesu lends out, and collateral-only ones a read found a position in.
  const listed = vaultListedMarkets(state);
  const anyCurated = listed.some((entry) => entry.curation === 'curated');
  return (
    <div className="panel-balance vault-position">
      <h3>{COPY.vault.position.title}</h3>
      <div className="vault-market-groups">
        {groupsOf(listed).map(({ group, tokens }) => (
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
                    data-lendable={entry.lendable ? 'true' : 'false'}
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
                    {entry.lendable ? null : <p className="vault-market-note">{COPY.vault.collateralOnly}</p>}
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
 * The form: a grouped token picker (D-081) when the mode offers more than one
 * token (a supply offers only markets Vesu lends out; a redeem adds any
 * collateral-only one holding a position), the chosen market's pool, and for
 * a supply the line saying it comes from the pool balance, or, once a review
 * found none of the token there, that there is nothing to supply.
 *
 * D-089, the lending touches (Aave's and Vesu's, nothing from a swap): one
 * amount field whose balance line is the pool balance for a supply (read when
 * the player asks) or what is supplied for a redeem; a Max once that figure
 * is read; the market's supply APY and "You will supply / receive";
 * and a button that says what is missing ("Enter an amount", "Insufficient
 * USDC") before it offers the review.
 */
function ComposeBlock({ state, token, panel }: { state: VaultState; token: VaultTokenView; panel: VaultPanelMachine }) {
  const preparing = state.flow.name === 'preparing';
  const supply = state.mode === 'supply';
  const noneHeld = state.holding.status === 'none' && sameAddress(state.holding.token, token.token);
  const choices = vaultChoices(state, state.mode);
  const field = amountFieldFor(state, token);
  const check = checkAmount(state.amountText, { decimals: token.decimals, balance: field.balance });
  const everything = !supply && (state.redeemAll || (check.status === 'ok' && redeemsWholePosition(state, token, check.amount)));
  const action = everything && check.status === 'empty'
    ? { label: COPY.gameMode.reviewAction, disabled: preparing }
    : primaryAction({
        check,
        symbol: token.symbol,
        ready: COPY.gameMode.reviewAction,
        busy: preparing ? COPY.flow.preparing : null,
        ...(supply ? {} : { exceeds: COPY.vault.form.overSupplied }),
      });
  const rate = state.rates.status === 'loaded' ? state.rates.rates.find((candidate) => sameAddress(candidate.token, token.token)) : undefined;
  const rows: DetailRow[] = [];
  if (rate) rows.push({ id: 'apy', label: COPY.vault.rates.label, value: `${formatRatePercent(rate.value, rate.decimals)}, ${COPY.vault.rates.source}` });
  if (check.status === 'ok') {
    rows.push({
      id: 'amount',
      label: supply ? COPY.vault.form.willSupply : COPY.vault.form.willReceive,
      value: formatExact(check.amount, token),
      tone: 'emphasis',
    });
  }
  return (
    <form
      className="panel-compose"
      onSubmit={(event) => {
        event.preventDefault();
        void panel.prepare();
      }}
    >
      {choices.length > 1 ? (
        <label>
          {COPY.vault.token}
          <select
            name="token"
            value={token.token}
            disabled={preparing}
            onChange={(event) => panel.setToken(event.target.value)}
          >
            {groupsOf(choices).map(({ group, tokens }) => (
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
      {token.lendable ? null : <p className="vault-market-note">{COPY.vault.collateralOnly}</p>}
      {supply ? (
        noneHeld ? (
          <p className="vault-holding vault-holding-none" role="status">{noneInPoolLine(token)}</p>
        ) : (
          <p className="vault-holding">{`${COPY.vault.holding.neededLead} ${token.symbol} ${COPY.vault.holding.neededTail}`}</p>
        )
      ) : null}
      {supply ? <BalanceRead state={state} onRead={() => void panel.refreshBalances()} /> : null}
      <AmountField
        label={COPY.vault.amount}
        value={state.amountText}
        onChange={(text) => panel.setAmount(text)}
        decimals={token.decimals}
        symbol={token.symbol}
        balance={field.balance}
        balanceLabel={supply ? COPY.kit.poolBalance : COPY.vault.form.supplied}
        exceedsMessage={supply ? COPY.kit.exceedsBalance : COPY.vault.form.overSupplied}
        {...(field.max ? { max: field.max } : {})}
        hint={field.hint(state.amountText)}
        disabled={preparing}
      />
      <DetailRows rows={rows} label={COPY.flow.review} />
      <button type="submit" className="review" disabled={action.disabled}>
        {action.label}
      </button>
      <p className="panel-hint">{COPY.gameMode.singleAction}</p>
    </form>
  );
}

/**
 * The amount field's figures for the chosen token (D-089). A supply checks
 * against the pool balance the player read, and its Max is what is
 * spendable where the wallet says, else the token's total (D-089: the wallet
 * refuses a spend of a note still maturing, and the counter says the funds
 * are settling), leaving the pool fee behind in the fee token. A redeem checks against what is supplied,
 * and Max is what the vault can pay out now: the whole position when it can,
 * which redeems every share.
 */
function amountFieldFor(state: VaultState, token: VaultTokenView): {
  balance: bigint | null;
  max: (() => bigint | null) | null;
  hint: (text: string) => string | null;
} {
  if (state.mode === 'supply') {
    const held = poolBalanceOf(state, token.token);
    const fee = state.balances.status === 'loaded' ? state.balances.fee : null;
    const reserve = feeReserve(token.token, fee);
    // D-089: a wallet that reports one total per token gives Max that total;
    // it refuses a spend counting a note still maturing, and the counter says so.
    const exact = held ? maxAfterReserve(held.maturityKnown ? held.spendable : held.total, reserve) : null;
    const tidy = exact === null ? null : tidyVaultAmount(exact, token);
    const maximum = tidy !== null && tidy > 0n ? tidy : null;
    return {
      balance: held?.total ?? null,
      max: held ? () => maximum : null,
      hint: (text) => maximum !== null && reserve !== null && reserve > 0n && text === formatTokenAmountExact(maximum, token.decimals)
        ? COPY.balance.feeReserved
        : null,
    };
  }
  const held = positionOf(state, token.token);
  if (held === undefined || held.shares === 0n) return { balance: null, max: null, hint: () => null };
  const short = held.redeemable < held.assets;
  const tidy = tidyVaultAmount(held.redeemable, token);
  return {
    balance: held.assets,
    max: tidy > 0n ? () => tidy : null,
    hint: () => (short ? `${COPY.vault.form.payoutLead} ${formatHolding(held.redeemable, token)} ${COPY.vault.form.payoutTail}` : null),
  };
}

/** The supply's pool balance, read only when the player asks: the wallet may ask first. */
function BalanceRead({ state, onRead }: { state: VaultState; onRead: () => void }) {
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
