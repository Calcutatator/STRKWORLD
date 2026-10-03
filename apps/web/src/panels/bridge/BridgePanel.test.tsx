import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakePrivacyOperations, ReservePublicShieldPlanner } from '@strkworld/privacy';
import { PrivacyProvider } from '../../privacy/PrivacyProvider.js';
import { BridgeProvider } from '../../bridge/BridgeProvider.js';
import { BridgePanel, estimatedTime } from './BridgePanel.js';
import { createBridgePanel } from '../../bridge/bridge-machine.js';
import { PRIVACY_REGISTER } from '../../privacy/register.js';
import { COPY } from '../../copy.js';
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
    expect(markup).toContain('class="panel-card"');
    expect(markup).toContain('Provider fee: 0.2% of the bridged amount. Pool and network costs are separate.');
    expect(markup).toContain('<details class="bridge-details"><summary>Keep the signed record safe</summary>');
    expect(markup).not.toContain('appFees');
  });

  it('renders the disclosure from the supplied route register', () => {
    const disclosure = 'Custom bridge disclosure.';
    const register = PRIVACY_REGISTER.map((entry) => entry.route === 'bridge.deposit'
      ? { ...entry, disclosure }
      : entry);
    const markup = renderToStaticMarkup(
      <PrivacyProvider operations={new FakePrivacyOperations()}>
        <BridgeProvider service={service} account="0x123" planner={null}>
          {createElement(BridgePanel, { onClose: () => {}, register })}
        </BridgeProvider>
      </PrivacyProvider>,
    );
    expect(markup).toContain(disclosure);
    expect(markup).not.toContain('Bridging is public. Your destination address and amount are visible');
  });

  /**
   * D-131: the balance line is the thing a press fills the amount from, and
   * the Bridge's deposit has none — the source chain's balance is not
   * something this app reads — so its field shows no figure to press. The
   * bridged amount is still typed, as it always was.
   */
  it('shows no balance line to fill the deposit amount from, since the source chain balance is never read', () => {
    const markup = renderBridge();
    expect(markup).toContain('class="ui-amount"');
    expect(markup).not.toContain('ui-amount-balance');
    expect(markup).not.toContain('ui-balance-fill');
  });

  it('keeps recovery controls and quote evidence compact instead of making them primary actions', () => {
    const markup = renderBridge();
    expect(markup).toContain('<summary>Recover a saved deposit</summary>');
    expect(markup).not.toContain('Direct unauthenticated 1Click charges');
  });

  it('keeps recovered status controls visible without re-exposing settled deposit instructions', async () => {
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
    await machine.open();
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

  it('offers one concise resume action for a restored awaiting-deposit quote', async () => {
    const restored: BridgeRecord = {
      v: 1,
      createdAt: 1,
      updatedAt: 1,
      source: { assetId: 'nep141:arb-usdc.omft.near', symbol: 'USDC', chainName: 'arbitrum', decimals: 6, depositMode: 'manual' },
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: '0x1111111111111111111111111111111111111111',
      signedQuote: {
        correlationId: 'resume-me',
        timestamp: '2030-01-01T00:00:00.000Z',
        signature: 'signed',
        quoteRequest: { recipient: '0x123' },
        quote: { depositAddress: '0xdeposit', amountOut: '20', minAmountOut: '19', deadline: '2030-01-01T00:30:00.000Z' },
      } as never,
      status: { leg: 'awaiting-deposit', message: 'Waiting for deposit', pollingStopped: false },
    };
    const machine = createBridgePanel({ service: { ...service, resume: () => restored }, loadSources: async () => [], readAccount: () => '0x123', planner: { planMax: async () => { throw new Error('unused'); } }, now: () => Date.parse('2030-01-01T00:01:00.000Z') });
    await machine.open();
    const markup = renderToStaticMarkup(
      <PrivacyProvider operations={new FakePrivacyOperations()}>
        <BridgeProvider service={service} account="0x123" planner={{ planMax: async () => { throw new Error('unused'); } }}>
          <BridgePanel panel={machine} onClose={() => {}} />
        </BridgeProvider>
      </PrivacyProvider>,
    );
    expect(markup).toContain('Resume saved deposit');
    expect(markup).not.toContain('Prepare deposit instructions');
  });

  it('gives a refund its own presentation — destination and amount — never as a bare failure, and never claiming privacy', async () => {
    const refunded: BridgeRecord = {
      v: 1,
      createdAt: 1,
      updatedAt: 1,
      source: { assetId: 'nep141:arb-usdc.omft.near', symbol: 'USDC', chainName: 'arbitrum', decimals: 6, depositMode: 'manual' },
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: '0x2222222222222222222222222222222222222222',
      signedQuote: {
        correlationId: 'refund-me',
        timestamp: '2030-01-01T00:00:00.000Z',
        signature: 'signed',
        quoteRequest: { recipient: '0x123' },
        quote: { depositAddress: '0xdeposit', amountOut: '20', minAmountOut: '19', deadline: '2030-01-01T00:30:00.000Z' },
      } as never,
      status: {
        leg: 'refunded',
        depositTxHash: '0xorigin',
        refundedAmount: 987_654n,
        message: '1Click refunded this deposit instead of completing it.',
        pollingStopped: true,
      },
    };
    const machine = createBridgePanel({ service: { ...service, resume: () => refunded }, loadSources: async () => [], readAccount: () => '0x123', planner: null, now: () => Date.parse('2030-01-01T00:01:00.000Z') });
    await machine.open();
    const markup = renderToStaticMarkup(
      <PrivacyProvider operations={new FakePrivacyOperations()}>
        <BridgeProvider service={service} account="0x123" planner={null}>
          <BridgePanel panel={machine} onClose={() => {}} />
        </BridgeProvider>
      </PrivacyProvider>,
    );
    expect(markup).toContain(COPY.bridge.refundAddress);
    // Shortened, like every other address the Bridge displays — never the raw address.
    expect(markup).not.toContain(refunded.refundAddress);
    expect(markup).toContain(COPY.bridge.refundedAmount);
    expect(markup).toContain('0.987654');
    expect(markup).toContain('USDC');
    // Distinct from a bare failure: never described as settled.
    expect(markup).not.toContain(COPY.bridge.settled);
    // The refund's own presentation must never claim this was private — only
    // the always-present D-024 disclosure may say the word "privacy", and only
    // to say it begins later (this asserts against the status block alone).
    const instructions = markup.slice(markup.indexOf('class="bridge-instructions"'));
    expect(instructions.toLowerCase()).not.toContain('private');
  });

  it('says the planned reserve stays as public STRK in the wallet beside the shield plan and its Bank handoff (D-061)', async () => {
    const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
    const ONE_STRK = 10n ** 18n;
    const settled: BridgeRecord = {
      v: 1,
      createdAt: 1,
      updatedAt: 1,
      source: { assetId: 'nep141:arb-usdc.omft.near', symbol: 'USDC', chainName: 'arbitrum', decimals: 6, depositMode: 'manual' },
      amountIn: 100_000_000n,
      starknetRecipient: '0x123',
      refundAddress: '0x1111111111111111111111111111111111111111',
      signedQuote: {
        correlationId: 'settled-reserve',
        timestamp: '2030-01-01T00:00:00.000Z',
        signature: 'signed',
        quoteRequest: { recipient: '0x123' },
        quote: { depositAddress: '0xdeposit', amountOut: (101n * ONE_STRK).toString(), minAmountOut: (100n * ONE_STRK).toString(), deadline: '2030-01-01T00:30:00.000Z' },
      } as never,
      status: { leg: 'settled', message: 'settled', pollingStopped: true, strkReceived: 100n * ONE_STRK },
    };
    const planner = new ReservePublicShieldPlanner({
      pool: { config: async () => ({ feeAmount: 6n * ONE_STRK, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 }) },
      readAccount: () => '0x123',
    });
    const machine = createBridgePanel({ service: { ...service, resume: () => settled }, loadSources: async () => [], readAccount: () => '0x123', planner, now: () => Date.parse('2030-01-01T00:01:00.000Z') });
    await machine.open();
    await machine.planShield();
    expect(machine.store.getState().flow.name).toBe('ready-to-shield');

    const markup = renderToStaticMarkup(
      <PrivacyProvider operations={new FakePrivacyOperations()}>
        <BridgeProvider service={service} account="0x123" planner={planner}>
          <BridgePanel panel={machine} onClose={() => {}} />
        </BridgeProvider>
      </PrivacyProvider>,
    );
    const start = markup.indexOf('class="bridge-next-step"');
    const handoff = markup.slice(start, markup.indexOf('Recovery options', start));

    expect(start).toBeGreaterThan(-1);
    expect(handoff).toMatch(/90(<!-- -->)? STRK/);
    expect(handoff).toMatch(/10(<!-- -->)? STRK/);
    expect(handoff).toContain(COPY.bridge.reserveStaysPublic);
    expect(handoff).toContain(COPY.bridge.shield);
    // The Bridge is never described as private.
    expect(handoff.toLowerCase()).not.toContain('private');
  });
});

describe('the Bridge quote and status, as bridges show them (D-091)', () => {
  function awaiting(timeEstimate?: number): BridgeRecord {
    return {
      v: 1,
      createdAt: 1,
      updatedAt: 1,
      source: { assetId: 'nep141:arb-usdc.omft.near', symbol: 'USDC', chainName: 'arbitrum', decimals: 6, depositMode: 'manual' },
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: '0x1111111111111111111111111111111111111111',
      signedQuote: {
        correlationId: 'rows',
        timestamp: '2030-01-01T00:00:00.000Z',
        signature: 'signed',
        quoteRequest: { recipient: '0x123' },
        quote: {
          depositAddress: '0xdeposit',
          amountOut: (25n * 10n ** 17n).toString(),
          minAmountOut: (24n * 10n ** 17n).toString(),
          deadline: '2030-01-01T00:30:00.000Z',
          ...(timeEstimate === undefined ? {} : { timeEstimate }),
        },
      } as never,
      status: { leg: 'awaiting-deposit', message: 'Waiting for your deposit', pollingStopped: false },
    };
  }

  async function markupFor(record: BridgeRecord): Promise<string> {
    const machine = createBridgePanel({ service: { ...service, resume: () => record }, loadSources: async () => [], readAccount: () => '0x123', planner: null, now: () => Date.parse('2030-01-01T00:01:00.000Z') });
    await machine.open();
    return renderToStaticMarkup(
      <PrivacyProvider operations={new FakePrivacyOperations()}>
        <BridgeProvider service={service} account="0x123" planner={null}>
          <BridgePanel panel={machine} onClose={() => {}} />
        </BridgeProvider>
      </PrivacyProvider>,
    );
  }

  it('shows what arrives, the signed floor and the estimated time', async () => {
    const markup = await markupFor(awaiting(180));
    expect(markup).toContain(`<dt>${COPY.bridge.willReceive}</dt><dd>≈ 2.5 STRK</dd>`);
    expect(markup).toContain('2.4 STRK');
    expect(markup).toContain(`<dt>${COPY.bridge.estTime}</dt><dd>~3 min`);
    expect(markup).toContain(COPY.bridge.estTimeNote);
    // A bridge has no slippage setting, Max or swap rows.
    expect(markup).not.toContain(COPY.kit.max);
    expect(markup).not.toContain('Slippage');
  });

  it('keeps the deposit status on screen as a live line', async () => {
    const markup = await markupFor(awaiting(30));
    expect(markup).toMatch(/<p class="bridge-status" role="status" aria-live="polite" data-leg="awaiting-deposit"><span class="bridge-status-label">Status<\/span> (<!-- -->)?Waiting for your deposit<\/p>/);
  });

  it('formats 1Click seconds the way bridges do', () => {
    expect(estimatedTime(0)).toBe(COPY.bridge.estUnderMinute);
    expect(estimatedTime(59)).toBe(COPY.bridge.estUnderMinute);
    expect(estimatedTime(60)).toBe('~1 min');
    expect(estimatedTime(150)).toBe('~3 min');
  });
});
