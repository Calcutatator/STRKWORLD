import { useEffect, useMemo, useState } from 'react';
import { COPY } from '../../copy.js';
import { formatStrk, formatStrkExact, formatTokenAmountExact, shortenAddress } from '../../format.js';
import { useBridge } from '../../bridge/BridgeProvider.js';
import { createBridgePanel, planDisplay, type BridgePanel as BridgeMachine, type BridgeQuoteReview } from '../../bridge/bridge-machine.js';
import { useStore } from '../../store/use-store.js';
import { PanelFrame } from '../PanelFrame.js';
import { routeDisclosure } from '../routes.js';
import { BankPanel } from '../bank/BankPanel.js';
import { createBankPanel, type BankPanel as BankMachine } from '../bank/bank-machine.js';
import { usePrivacy } from '../../privacy/PrivacyProvider.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import { GlossaryTerm } from '../Glossary.js';
import { AmountField, DetailRows, type DetailRow } from '../kit/index.js';

export function BridgePanel({
  onClose,
  panel: injected,
  experience = 'menu',
  onShieldReady,
  register = PRIVACY_REGISTER,
}: {
  onClose: () => void;
  panel?: BridgeMachine;
  experience?: 'menu' | 'station';
  onShieldReady?: (amount: bigint) => void;
  /** Route authority used for disclosure and the nested shield panel. */
  register?: readonly RouteGrade[];
}) {
  const runtime = useBridge();
  const { operations, receipts, noteOperationError, submissionUncertainty } = usePrivacy();
  const owned = useMemo(() => injected ?? (runtime.service ? createBridgePanel({
    service: runtime.service,
    loadSources: runtime.loadSources,
    readAccount: runtime.readAccount,
    planner: runtime.planner,
    now: runtime.now,
  }) : null), [injected, runtime]);
  const state = useStore(owned?.store ?? unavailablePanel.store);
  const [amountText, setAmountText] = useState('1');
  const [refundAddress, setRefundAddress] = useState('0x1111111111111111111111111111111111111111');
  const [sourceIndex, setSourceIndex] = useState(0);
  const [importText, setImportText] = useState('');
  const [showShieldBank, setShowShieldBank] = useState(false);

  useEffect(() => {
    runtime.load();
  }, [runtime.load]);

  const shieldMachine = useMemo<BankMachine | null>(() => {
    if (!showShieldBank || !owned || !state.plan || state.flow.name !== 'ready-to-shield') return null;
    return createBankPanel({
      operations,
      receipts,
      allowedModes: ['shield'],
      initialMode: 'shield',
      building: 'bank',
      canStartFinancialAction: () => {
        const uncertainty = submissionUncertainty.store.getState();
        return !uncertainty.active || uncertainty.acknowledged;
      },
      onError: noteOperationError,
      preConfirmGuard: async () => (await owned.revalidateShieldPlan()) !== null,
      register,
    });
  }, [showShieldBank, owned, state.plan, state.flow.name, operations, receipts, noteOperationError, submissionUncertainty, register]);

  useEffect(() => {
    if (!shieldMachine || !state.plan) return;
    shieldMachine.setAmount(formatTokenAmountExact(state.plan.amountToShield));
  }, [shieldMachine, state.plan]);

  useEffect(() => {
    if (!shieldMachine) return;
    void shieldMachine.open();
    return () => shieldMachine.close();
  }, [shieldMachine]);

  useEffect(() => {
    if (!owned) return;
    void owned.open();
    return () => owned.close();
  }, [owned]);

  if (!owned || !runtime.service) {
    return (
      <PanelFrame title={COPY.bridge.title} building="bridge" disclosure={routeDisclosure('bridge.deposit', register)} onClose={onClose}>
        <p className="room-locked" role="note">{COPY.bridge.recoveryUnavailable}</p>
      </PanelFrame>
    );
  }

  const source = state.sources.assets[sourceIndex] ?? state.sources.assets[0];
  const review = state.quote;
  const plan = state.plan;
  return (
    <section className="bridge-experience" data-experience={experience}>
      <PanelFrame title={COPY.bridge.title} building="bridge" disclosure={routeDisclosure('bridge.deposit', register)} onClose={onClose}>
        <p className="bridge-compact-note" role="note">{COPY.bridge.providerFee}</p>
        <details className="bridge-details">
          <summary>Keep the signed record safe</summary>
          <p>{COPY.bridge.sensitive}</p>
        </details>
        {state.notice && state.notice.text !== COPY.bridge.providerFee ? <p className="panel-notice" role={state.notice.tone === 'error' ? 'alert' : 'note'}>{state.notice.text}</p> : null}
        {!runtime.planner ? <p className="room-locked" role="note">{COPY.bridge.plannerUnavailable}</p> : null}

        {runtime.planner && !review && !state.record ? (
          <div className="bridge-quote-form">
            <label>{COPY.bridge.source}
              <select value={sourceIndex} onChange={(event) => setSourceIndex(Number(event.target.value))}>
                {state.sources.assets.map((asset, index) => <option key={asset.assetId} value={index}>{asset.symbol} · {asset.chainName}</option>)}
              </select>
            </label>
            {/* The source chain's balance is not something this app reads, so the
                field shows none and offers no Max. */}
            <AmountField
              label={COPY.bridge.amount}
              value={amountText}
              onChange={setAmountText}
              decimals={source?.decimals ?? 18}
              symbol={source?.symbol ?? ''}
            />
            <details className="bridge-details">
              <summary>{COPY.bridge.refundAddress}</summary>
              <p className="glossary-definition">{COPY.glossary.refundAddress}</p>
              <label>
                <input value={refundAddress} onChange={(event) => setRefundAddress(event.target.value)} />
              </label>
            </details>
            <button type="button" disabled={state.flow.name === 'quoting' || state.flow.name === 'preflighting'} onClick={() => {
              if (!source) return;
              const parsed = parseSourceAmount(amountText, source.decimals);
              if (parsed === null) return;
              void owned.createQuote({ source, amountIn: parsed, refundAddress });
            }}>{COPY.bridge.quote}</button>
          </div>
        ) : null}

        {review ? <QuoteReview review={review} /> : null}
        {runtime.planner && state.record && review && state.preflightAvailable && !state.instructionsVisible ? (
          <button type="button" onClick={() => void owned.resumeSavedQuote()} disabled={state.flow.name === 'loading' || state.flow.name === 'preflighting'}>
            {COPY.bridge.resume}
          </button>
        ) : null}
        {state.record && !state.instructionsVisible && state.flow.name === 'failed' ? (
          <p className="flow-failed" role="alert">{state.flow.message}</p>
        ) : null}
        {state.record ? (
          <BridgeStatusPanel
            record={state.record}
            onRefresh={() => void owned.refresh()}
            onWatch={() => void owned.watch()}
            onImport={() => owned.importRecord(importText)}
            importText={importText}
            setImportText={setImportText}
            onExport={() => {
              const value = owned.exportRecord();
              if (value) setImportText(value);
            }}
            onDiscard={() => owned.discardRecord()}
            onShield={() => {
              const intent = owned.shieldIntent();
              if (intent?.kind === 'shield') {
                onShieldReady?.(intent.amount);
                setShowShieldBank(true);
              }
              else void owned.planShield();
            }}
            plan={plan}
            allowShield={Boolean(runtime.planner && runtime.account)}
            flow={state.flow.name}
          />
        ) : null}
        {state.record && state.instructionsVisible && state.record.status.leg === 'awaiting-deposit' ? (
          <BridgeDepositInstructions record={state.record} />
        ) : null}
        {!state.record ? (
          <details className="bridge-details">
            <summary>Recover a saved deposit</summary>
            <div className="bridge-recovery">
              <label>{COPY.bridge.import}
                <textarea value={importText} onChange={(event) => setImportText(event.target.value)} />
              </label>
              <button type="button" onClick={() => owned.importRecord(importText)}>{COPY.bridge.import}</button>
            </div>
          </details>
        ) : null}
        {shieldMachine ? <BankPanel panel={shieldMachine} experience="station" allowedModes={['shield']} initialMode="shield" title={COPY.bank.title} building="bank" register={register} onClose={() => setShowShieldBank(false)} /> : null}
      </PanelFrame>
    </section>
  );
}

function QuoteReview({ review }: { review: BridgeQuoteReview }) {
  // D-091: the rows a bridge shows, and no more: what is sent, what arrives,
  // the floor the quote signs, and how long it should take.
  const rows: DetailRow[] = [
    { id: 'amount', label: COPY.bridge.amount, value: `${formatTokenAmountExact(review.amountIn, review.sourceDecimals)} ${review.sourceSymbol}` },
    { id: 'receive', label: COPY.bridge.willReceive, value: `≈ ${formatStrk(review.expectedAmountOut)}`, tone: 'emphasis' },
    { id: 'minimum', label: <GlossaryTerm term={COPY.bridge.minimum} definition={COPY.glossary.bridgeMinimum} />, value: formatStrkExact(review.minimumAmountOut) },
  ];
  if (review.timeEstimateSeconds !== null) {
    rows.push({ id: 'time', label: COPY.bridge.estTime, value: estimatedTime(review.timeEstimateSeconds), note: COPY.bridge.estTimeNote });
  }
  return (
    <>
      <DetailRows rows={rows} label={COPY.bridge.expected} />
      <details className="bridge-details">
        <summary>Quote details</summary>
        <dl className="bridge-review">
          <dt>{COPY.bridge.recipient}</dt><dd><code>{shortenAddress(review.recipient)}</code></dd>
          <dt><GlossaryTerm term={COPY.bridge.deadline} definition={COPY.glossary.quoteExpiry} /></dt><dd>{compactDeadline(review.deadline)}</dd>
        </dl>
      </details>
    </>
  );
}

/** 1Click's seconds as a bridge shows them: "~3 min", or under a minute. */
export function estimatedTime(seconds: number): string {
  if (seconds < 60) return COPY.bridge.estUnderMinute;
  return COPY.bridge.estMinutes.replace('{minutes}', String(Math.round(seconds / 60)));
}

function BridgeStatusPanel({
  record,
  onRefresh,
  onWatch,
  onImport,
  importText,
  setImportText,
  onExport,
  onDiscard,
  onShield,
  plan,
  allowShield,
  flow,
}: {
  record: import('@strkworld/bridge').BridgeRecord;
  onRefresh: () => void;
  onWatch: () => void;
  onImport: () => void;
  importText: string;
  setImportText: (value: string) => void;
  onExport: () => void;
  onDiscard: () => void;
  onShield: () => void;
  plan: import('@strkworld/privacy').PublicShieldPlan | null;
  allowShield: boolean;
  flow: string;
}) {
  const status = record.status;
  return (
    <div className="bridge-instructions">
      {/* D-091: the deposit's status, on screen for as long as the record is:
          a bridge settles in minutes, and the player may leave and come back. */}
      <p className="bridge-status" role="status" aria-live="polite" data-leg={status.leg}>
        <span className="bridge-status-label">{COPY.bridge.status}</span> {status.message}
      </p>
      <dl>
        {status.strkReceived !== undefined ? <><dt>{COPY.bridge.settled}</dt><dd>{formatStrkExact(status.strkReceived)}</dd></> : null}
        {status.leg === 'refunded' ? <>
          <dt>{COPY.bridge.refundAddress}</dt><dd><code>{shortenAddress(record.refundAddress)}</code></dd>
          {status.refundedAmount !== undefined ? <>
            <dt>{COPY.bridge.refundedAmount}</dt>
            <dd>{formatTokenAmountExact(status.refundedAmount, record.source.decimals)} {record.source.symbol}</dd>
          </> : null}
        </> : null}
      </dl>
      <div className="bridge-actions">
        <button type="button" onClick={onRefresh} disabled={flow === 'loading'}>{COPY.bridge.refresh}</button>
        <button type="button" onClick={onWatch} disabled={flow === 'watching'}>{COPY.bridge.watch}</button>
        {allowShield && status.leg === 'settled' && !plan ? <button type="button" onClick={onShield} disabled={flow === 'planning-shield'}>{COPY.bridge.plan}</button> : null}
      </div>
      {plan && flow === 'ready-to-shield' ? (
        <div className="bridge-next-step">
          <strong>{COPY.next.shieldAtBank}</strong>
          <ShieldPlan plan={plan} />
          <button type="button" onClick={onShield}>{COPY.bridge.shield}</button>
        </div>
      ) : null}
      <details className="bridge-details">
        <summary>Recovery options</summary>
        <div className="bridge-actions">
          <button type="button" onClick={onExport}>{COPY.bridge.export}</button>
          <button type="button" onClick={onDiscard}>{COPY.bridge.discard}</button>
        </div>
        <label>{COPY.bridge.import}
          <textarea value={importText} onChange={(event) => setImportText(event.target.value)} />
        </label>
        <button type="button" onClick={onImport}>{COPY.bridge.import}</button>
      </details>
    </div>
  );
}

function BridgeDepositInstructions({ record }: { record: import('@strkworld/bridge').BridgeRecord }) {
  return (
    <div className="bridge-deposit-instructions">
      <p>{COPY.bridge.instructions}</p>
      <dl>
        <dt>{COPY.bridge.depositAddress}</dt><dd><code>{record.signedQuote.quote.depositAddress}</code></dd>
        {record.signedQuote.quote.depositMemo ? <><dt><GlossaryTerm term={COPY.bridge.memo} definition={COPY.glossary.memo} /></dt><dd><code>{record.signedQuote.quote.depositMemo}</code></dd></> : null}
      </dl>
    </div>
  );
}

function ShieldPlan({ plan }: { plan: import('@strkworld/privacy').PublicShieldPlan }) {
  const values = planDisplay(plan);
  // D-061: the planned shield and its Bank handoff always say where the reserve goes.
  return <>
    <dl className="bridge-plan">
      <dt>{COPY.bridge.amountToShield}</dt><dd>{values.amountToShield} STRK</dd>
      <dt>{COPY.bridge.plannedReserve}</dt><dd>{values.plannedReserve} STRK</dd>
    </dl>
    <p className="bridge-compact-note" role="note">{COPY.bridge.reserveStaysPublic}</p>
  </>;
}

function compactDeadline(deadline: string): string {
  const parsed = new Date(deadline);
  if (Number.isNaN(parsed.getTime())) return 'Unavailable';
  return `${parsed.toISOString().slice(11, 16)} UTC`;
}

function parseSourceAmount(input: string, decimals: number): bigint | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) return null;
  try { return BigInt(whole + fraction.padEnd(decimals, '0')); } catch { return null; }
}

const unavailableService = {
  resume: () => null,
  createManualDeposit: async () => { throw new Error('unavailable'); },
  refresh: async () => { throw new Error('unavailable'); },
  watch: async () => { throw new Error('unavailable'); },
  exportResumeRecord: () => { throw new Error('unavailable'); },
  importResumeRecord: () => { throw new Error('unavailable'); },
  discard: () => undefined,
};

const unavailablePanel = createBridgePanel({
  service: unavailableService,
  loadSources: async () => [],
  readAccount: () => null,
});
