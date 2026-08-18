import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakePrivacyOperations } from '@strkworld/privacy';
import { PrivacyProvider } from '../../privacy/PrivacyProvider.js';
import { BridgeProvider } from '../../bridge/BridgeProvider.js';
import { BridgePanel } from './BridgePanel.js';
import { createBridgePanel } from '../../bridge/bridge-machine.js';
import type { BridgeRecord } from '@strkworld/bridge';

const service = {
  resume: () => null,
  createManualDeposit: async () => { throw new Error('unused'); },
  refresh: async () => { throw new Error('unused'); },
  watch: async () => { throw new Error('unused'); },
  exportResumeRecord: () => { throw new Error('unused'); },
  importResumeRecord: () => { throw new Error('unused'); },
  discard: () => undefined,
};

function renderBridge() {
  return renderToStaticMarkup(
    <PrivacyProvider operations={new FakePrivacyOperations()}>
      <BridgeProvider service={service} account="0x123" planner={{ planMax: async () => { throw new Error('unused'); } }}>
        <BridgePanel onClose={() => {}} />
      </BridgeProvider>
    </PrivacyProvider>,
  );
}

describe('BridgePanel', () => {
  it('keeps Menu Mode and Game Mode manual-only with no batch vocabulary', () => {
    for (const experience of ['menu', 'station'] as const) {
      const markup = renderToStaticMarkup(
        <PrivacyProvider operations={new FakePrivacyOperations()}>
          <BridgeProvider service={service} account="0x123" planner={null}>
            <BridgePanel experience={experience} onClose={() => {}} />
          </BridgeProvider>
        </PrivacyProvider>,
      );
      expect(markup).toContain('Bridging is public.');
      expect(markup).not.toContain('Add to this visit');
      expect(markup).not.toContain('appFees');
    }
  });

  it('keeps sensitive import available with no current record and renders the canonical disclosure', () => {
    const markup = renderBridge();
    expect(markup).toContain('Import sensitive record');
    expect(markup).toContain('Bridging is public. Your destination address and amount are visible');
    expect(markup).not.toContain('appFees');
  });

  it('keeps recovered status controls visible without re-exposing settled deposit instructions', () => {
    const recovered: BridgeRecord = {
      v: 1,
      createdAt: 1,
      updatedAt: 1,
      source: { assetId: 'nep141:arb-usdc.omft.near', symbol: 'USDC', chainName: 'arbitrum', decimals: 6, depositMode: 'manual' },
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: '0x1111111111111111111111111111111111111111',
      signedQuote: {
        correlationId: 'recovered',
        timestamp: '2030-01-01T00:00:00.000Z',
        signature: 'signed',
        quoteRequest: { recipient: '0x123' },
        quote: { depositAddress: '0xdeposit', amountOut: '20', minAmountOut: '19', deadline: '2030-01-01T00:30:00.000Z' },
      } as never,
      status: { leg: 'settled', message: 'settled', pollingStopped: true, strkReceived: 18n },
    };
    const machine = createBridgePanel({ service: { ...service, resume: () => recovered }, loadSources: async () => [], readAccount: () => '0x123', planner: null, now: () => Date.parse('2030-01-01T00:01:00.000Z') });
    machine.store.setState((state) => ({ ...state, record: recovered, flow: { name: 'idle' } }));
    const markup = renderToStaticMarkup(
      <PrivacyProvider operations={new FakePrivacyOperations()}>
        <BridgeProvider service={service} account="0x123" planner={null}>
          <BridgePanel panel={machine} onClose={() => {}} />
        </BridgeProvider>
      </PrivacyProvider>,
    );
    expect(markup).toContain('Check for deposit');
    expect(markup).toContain('Export sensitive record');
    expect(markup).not.toContain('Send the exact amount');
    expect(markup).not.toContain('0xdeposit');
  });
});
