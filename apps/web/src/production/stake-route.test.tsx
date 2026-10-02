import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ENDUR_XSTRK, FakePrivacyOperations, type Address, type WalletRoutePolicy } from '@strkworld/privacy';
import { COPY } from '../copy.js';
import { parseTokenAmount } from '../format.js';
import { BankMenuPanel } from '../panels/bank/BankMenuPanel.js';
import { BankPanel } from '../panels/bank/BankPanel.js';
import { createBankPanel } from '../panels/bank/bank-machine.js';
import { PrivacyProvider } from '../privacy/PrivacyProvider.js';
import { createReceiptLedger } from '../receipts/receipt-ledger.js';
import { VisitLayerView } from '../visits/VisitLayer.js';
import { detectRoutePolicy, routePolicyFrom } from './config.js';

/**
 * D-063's "built switched off", as a player would meet it: under the
 * production default the STAKE counter is locked with its own not-enabled
 * line and Menu Mode hides its tab (D-088, D-099), and only the build's stake
 * switch opens them. Availability comes from the existing machinery alone — the register
 * plus `routeDoor`'s live policy — with nothing stake-specific deciding it.
 *
 * As in `unshield-route.test.tsx`, Vite inlines `import.meta.env`, so the live
 * policy is replaced by the real parser's output for a given environment.
 */
const livePolicy = vi.hoisted(() => ({ current: null as WalletRoutePolicy | null }));
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  detectRoutePolicy: () => livePolicy.current,
}));

const STRK: Address = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const STAKE_ENV = {
  VITE_STRK20_STAKE_ENABLED: 'true',
  VITE_STRK20_STAKE_MAX_RELAY_FEE: '5',
  VITE_STRK20_STAKE_ALLOWED_TOKENS: `${STRK},${ENDUR_XSTRK}`,
};
const escaped = (text: string) => text.replaceAll("'", '&#x27;');

function stubProduction(environment: Record<string, string> = {}): void {
  livePolicy.current = routePolicyFrom({ VITE_WALLET_MODE: 'real', ...environment });
}

function stakingStation(): string {
  return renderToStaticMarkup(
    <PrivacyProvider operations={new FakePrivacyOperations()}>
      <VisitLayerView
        state={{ name: 'visiting', building: 'bank', surface: { name: 'station', station: 'bank:staking' } }}
        connected
        onOpenMenu={() => {}}
        onRequestExit={() => {}}
        onCloseSurface={() => {}}
        onDismissLocked={() => {}}
      />
    </PrivacyProvider>,
  );
}

/** The STAKE counter's own window (D-099), over its own machine. */
async function stakeWindow(): Promise<{ markup: string; open: boolean }> {
  const operations = new FakePrivacyOperations({ balances: { [STRK]: parseTokenAmount('100')! } });
  const panel = createBankPanel({ operations, receipts: createReceiptLedger(), allowedModes: ['stake'], initialMode: 'stake', canStartFinancialAction: () => true });
  await panel.open();
  const markup = renderToStaticMarkup(
    <PrivacyProvider operations={operations}>
      <BankPanel panel={panel} mode="stake" onClose={() => {}} />
    </PrivacyProvider>,
  );
  return { markup, open: panel.store.getState().door.open };
}

/** The Bank's Menu Mode tabs under the live policy. */
function menuTabs(): string[] {
  const markup = renderToStaticMarkup(
    <PrivacyProvider operations={new FakePrivacyOperations()}>
      <BankMenuPanel onClose={() => {}} />
    </PrivacyProvider>,
  );
  return [...markup.matchAll(/role="tab"[^>]*>([^<]+)<\/button>/g)].map((match) => match[1]!);
}

describe("Endur staking follows this build's production policy", () => {
  afterEach(() => {
    livePolicy.current = null;
  });

  it('stays off under the production default, with its own not-enabled line', async () => {
    stubProduction();
    expect(detectRoutePolicy()?.enabledRoutes).toEqual([]);

    const station = stakingStation();
    expect(station).toContain('data-lock-reason="not-enabled"');
    expect(station).toContain(escaped(COPY.locked.notEnabled.stake));
    expect(station).not.toContain('name="amount"');
    expect(station).not.toContain(COPY.balance.refresh);

    // Menu Mode hides a counter its build leaves off: here every counter but SHIELD.
    expect(menuTabs()).toEqual([]);
    const { markup, open } = await stakeWindow();
    expect(open).toBe(false);
    expect(markup).toContain(escaped(COPY.locked.notEnabled.stake));
    expect(markup).not.toContain('name="amount"');
    // A locked counter offers nothing to compose, not even the intro to it.
    expect(markup).not.toContain(COPY.stake.intro);
  });

  it('opens only when the build switches staking on', async () => {
    stubProduction(STAKE_ENV);
    expect(detectRoutePolicy()?.enabledRoutes).toEqual(['stake']);

    const station = stakingStation();
    expect(station).not.toContain('data-lock-reason');
    expect(station).toContain('data-brand="endur"');
    expect(station).toContain('name="amount"');

    const { markup, open } = await stakeWindow();
    expect(open).toBe(true);
    expect(markup).toContain('name="amount"');
    // Enabling staking enables nothing else: Menu Mode offers SHIELD, always, and STAKE.
    expect(menuTabs()).toEqual(['SHIELD', 'STAKE']);
  });

  it('opens freely in demo, where there is no production policy', () => {
    livePolicy.current = null;
    const station = stakingStation();
    expect(station).not.toContain('data-lock-reason');
    expect(station).toContain(COPY.stake.intro);
  });
});
