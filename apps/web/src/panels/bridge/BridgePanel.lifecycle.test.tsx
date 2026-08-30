// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { FakePrivacyOperations, type PublicShieldPlan } from '@strkworld/privacy';
import type { BridgeRecord } from '@strkworld/bridge';
import type { BridgePanel as BridgePanelMachine, BridgeState } from '../../bridge/bridge-machine.js';
import { createStore } from '../../store/store.js';
import { PrivacyProvider } from '../../privacy/PrivacyProvider.js';
import { BridgeProvider } from '../../bridge/BridgeProvider.js';
import { BridgePanel } from './BridgePanel.js';

const plan: PublicShieldPlan = {
  token: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
  recipient: '0x123',
  available: 100n,
  amountToShield: 90n,
  poolFee: 6n,
  gasEstimate: 4n,
  plannedReserve: 10n,
};

const record: BridgeRecord = {
  v: 1 as const,
  createdAt: 1,
  updatedAt: 1,
  source: { assetId: 'nep141:arb-usdc.omft.near', symbol: 'USDC', chainName: 'arbitrum', decimals: 6, depositMode: 'manual' as const },
  amountIn: 1_000_000n,
  starknetRecipient: '0x123',
  refundAddress: '0x111',
  signedQuote: {} as never,
  status: { leg: 'settled' as const, message: 'settled', pollingStopped: true, strkReceived: 100n },
};

function injectedPanel(): BridgePanelMachine {
  const initial: BridgeState = {
    sources: { status: 'loaded', assets: [] },
    record,
    account: '0x123',
    accountMatchesRecord: true,
    quote: { amountIn: 1_000_000n, sourceSymbol: 'USDC', sourceDecimals: 6, expectedAmountOut: 100n, minimumAmountOut: 90n, deadline: '2030-01-01T00:00:00.000Z', recipient: '0x123' },
    preflightAvailable: false,
    instructionsVisible: false,
    plan,
    flow: { name: 'ready-to-shield' },
    notice: null,
  };
  const owner = createStore(initial);
  const store = Object.freeze({
    getState: owner.getState,
    getServerSnapshot: owner.getServerSnapshot,
    subscribe: owner.subscribe,
  });
  return {
    store,
    open: async () => {},
    close: () => {},
    createQuote: async () => {},
    preflightSavedQuote: async () => {},
    resumeSavedQuote: async () => {},
    refresh: async () => {},
    watch: async () => {},
    exportRecord: () => null,
    importRecord: () => {},
    discardRecord: () => owner.setState((state) => ({ ...state, record: null, quote: null, plan: null, flow: { name: 'idle' } })),
    planShield: async () => {},
    shieldIntent: () => ({ kind: 'shield', token: plan.token, amount: plan.amountToShield }),
    revalidateShieldPlan: async () => plan,
  };
}

describe('BridgePanel nested shield lifecycle', () => {
  it('removes the shield Bank when its Bridge plan is discarded', async () => {
    const panel = injectedPanel();
    const container = document.createElement('div');
    const root = createRoot(container);
    const service = {
      resume: () => record,
      createManualDeposit: async () => record,
      refresh: async () => record.status,
      watch: async () => record.status,
      exportResumeRecord: () => 'record',
      importResumeRecord: () => record,
      discard: () => {},
    };
    const planner = { planMax: async () => plan };

    await act(async () => {
      root.render(
        <PrivacyProvider operations={new FakePrivacyOperations()}>
          <BridgeProvider service={service} account="0x123" planner={planner}>
            <BridgePanel panel={panel} onClose={() => {}} />
          </BridgeProvider>
        </PrivacyProvider>,
      );
    });
    const shield = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Review shield at the Bank');
    expect(shield).toBeDefined();
    await act(async () => shield!.click());
    expect(container.querySelector('[data-experience="station"]')).not.toBeNull();

    await act(async () => panel.discardRecord());
    expect(container.querySelector('[data-experience="station"]')).toBeNull();
    root.unmount();
  });
});
