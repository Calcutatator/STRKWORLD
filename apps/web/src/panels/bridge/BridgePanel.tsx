import { useEffect, useMemo, useState } from 'react';
import { COPY } from '../../copy.js';
import { formatStrkExact, formatTokenAmountExact, shortenAddress } from '../../format.js';
import { useBridge } from '../../bridge/BridgeProvider.js';
import { createBridgePanel, planDisplay, type BridgePanel as BridgeMachine, type BridgeQuoteReview } from '../../bridge/bridge-machine.js';
import { useStore } from '../../store/use-store.js';
import { PanelFrame } from '../PanelFrame.js';
import { routeDisclosure } from '../routes.js';
import { BankPanel } from '../bank/BankPanel.js';
import { createBankPanel, type BankPanel as BankMachine } from '../bank/bank-machine.js';
import { usePrivacy } from '../../privacy/PrivacyProvider.js';

export function BridgePanel({
  onClose,
  panel: injected,
  experience = 'menu',
  onShieldReady,
}: {
  onClose: () => void;
  panel?: BridgeMachine;
  experience?: 'menu' | 'station';
  onShieldReady?: (amount: bigint) => void;
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
    });
  }, [showShieldBank, owned, operations, receipts, noteOperationError, submissionUncertainty]);

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
      <PanelFrame title={COPY.bridge.title} disclosure={routeDisclosure('bridge.deposit')} onClose={onClose}>
        <p className="room-locked" role="note">{COPY.bridge.plannerUnavailable}</p>
      </PanelFrame>
    );
  }

  const source = state.sources.assets[sourceIndex] ?? state.sources.assets[0];
  const review = state.quote;
  const plan = state.plan;
  return (
    <section className="bridge-experience" data-experience={experience}>
      <PanelFrame title={COPY.bridge.title} disclosure={routeDisclosure('bridge.deposit')} onClose={onClose}>
        <p className="panel-notice" role="note">{COPY.bridge.providerFee}</p>
        <p className="panel-notice" role="note">{COPY.bridge.sensitive}</p>
        {state.notice && state.notice.text !== COPY.bridge.providerFee ? <p className="panel-notice" role={state.notice.tone === 'error' ? 'alert' : 'note'}>{state.notice.text}</p> : null}
        {!runtime.planner ? <p className="room-locked" role="note">{COPY.bridge.plannerUnavailable}</p> : null}

        {runtime.planner && !review && !state.record ? (
          <div className="bridge-quote-form">
            <label>{COPY.bridge.source}
              <select value={sourceIndex} onChange={(event) => setSourceIndex(Number(event.target.value))}>
                {state.sources.assets.map((asset, index) => <option key={asset.assetId} value={index}>{asset.symbol} · {asset.chainName}</option>)}
              </select>
            </label>
            <label>{COPY.bridge.amount}
              <input value={amountText} onChange={(event) => setAmountText(event.target.value)} inputMode="decimal" />
            </label>
            <label>{COPY.bridge.refundAddress}
              <input value={refundAddress} onChange={(event) => setRefundAddress(event.target.value)} />
            </label>
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
          <button type="button" onClick={() => void owned.preflightSavedQuote()} disabled={state.flow.name === 'preflighting'}>
            {COPY.bridge.preflight}
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
          <div className="bridge-recovery">
            <label>{COPY.bridge.import}
              <textarea value={importText} onChange={(event) => setImportText(event.target.value)} />
            </label>
            <button type="button" onClick={() => owned.importRecord(importText)}>{COPY.bridge.import}</button>
            <button type="button" disabled>{COPY.bridge.export}</button>
            <button type="button" disabled>{COPY.bridge.discard}</button>
          </div>
        ) : null}
        {plan && state.flow.name === 'ready-to-shield' ? <ShieldPlan plan={plan} /> : null}
        {shieldMachine ? <BankPanel panel={shieldMachine} experience="station" allowedModes={['shield']} initialMode="shield" title={COPY.bank.title} building="bank" onClose={() => setShowShieldBank(false)} /> : null}
      </PanelFrame>
    </section>
  );
}

function QuoteReview({ review }: { review: BridgeQuoteReview }) {
  return (
    <dl className="bridge-review">
      <dt>{COPY.bridge.amount}</dt><dd>{formatTokenAmountExact(review.amountIn, review.sourceDecimals)} {review.sourceSymbol}</dd>
      <dt>{COPY.bridge.expected}</dt><dd>{formatStrkExact(review.expectedAmountOut)}</dd>
      <dt>{COPY.bridge.minimum}</dt><dd>{formatStrkExact(review.minimumAmountOut)}</dd>
      <dt>{COPY.bridge.recipient}</dt><dd><code>{shortenAddress(review.recipient)}</code></dd>
      <dt>{COPY.bridge.deadline}</dt><dd>{review.deadline}</dd>
    </dl>
  );
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
      <p>{status.message}</p>
      <dl>
        {status.strkReceived !== undefined ? <><dt>{COPY.bridge.settled}</dt><dd>{formatStrkExact(status.strkReceived)}</dd></> : null}
      </dl>
      <div className="bridge-actions">
        <button type="button" onClick={onRefresh} disabled={flow === 'loading'}>{COPY.bridge.refresh}</button>
        <button type="button" onClick={onWatch} disabled={flow === 'watching'}>{COPY.bridge.watch}</button>
        {allowShield && status.leg === 'settled' ? <button type="button" onClick={onShield} disabled={flow === 'planning-shield'}>{plan ? COPY.bridge.shield : COPY.bridge.plan}</button> : null}
        <button type="button" onClick={onExport}>{COPY.bridge.export}</button>
        <button type="button" onClick={onDiscard}>{COPY.bridge.discard}</button>
      </div>
      <label>{COPY.bridge.import}
        <textarea value={importText} onChange={(event) => setImportText(event.target.value)} />
      </label>
      <button type="button" onClick={onImport}>{COPY.bridge.import}</button>
    </div>
  );
}

function BridgeDepositInstructions({ record }: { record: import('@strkworld/bridge').BridgeRecord }) {
  return (
    <div className="bridge-deposit-instructions">
      <p>{COPY.bridge.instructions}</p>
      <dl>
        <dt>{COPY.bridge.depositAddress}</dt><dd><code>{record.signedQuote.quote.depositAddress}</code></dd>
        {record.signedQuote.quote.depositMemo ? <><dt>{COPY.bridge.memo}</dt><dd><code>{record.signedQuote.quote.depositMemo}</code></dd></> : null}
      </dl>
    </div>
  );
}

function ShieldPlan({ plan }: { plan: import('@strkworld/privacy').PublicShieldPlan }) {
  const values = planDisplay(plan);
  return <dl className="bridge-plan">
    <dt>{COPY.bridge.amountToShield}</dt><dd>{values.amountToShield} STRK</dd>
    <dt>{COPY.bridge.poolFee}</dt><dd>{values.poolFee} STRK</dd>
    <dt>{COPY.bridge.gasEstimate}</dt><dd>{values.gasEstimate} STRK</dd>
    <dt>{COPY.bridge.plannedReserve}</dt><dd>{values.plannedReserve} STRK</dd>
  </dl>;
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
