import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakePrivacyOperations, type WalletRoutePolicy } from '@strkworld/privacy';
import { COPY } from '../copy.js';
import { DegenCatalogProvider } from '../panels/exchange/DegenCatalogProvider.js';
import { PrivacyProvider } from '../privacy/PrivacyProvider.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { resolveStation, stationSnapshot } from '../visits/station-registry.js';
import { VisitLayerView } from '../visits/VisitLayer.js';
import { parseRoutePolicy, routePolicyFrom } from './config.js';

/**
 * D-067's degen counter opens and locks exactly as the ground-floor swap: one
 * `exchange.swap` route, one register entry, one wallet-policy switch. Demo
 * has no production policy, so both counters open; production denies swap
 * today, so both stay locked with swap's own not-enabled line.
 *
 * As in `stake-route.test.tsx`, Vite inlines `import.meta.env`, so the live
 * policy the rendered counters read is replaced by the real parser's output.
 */
const livePolicy = vi.hoisted(() => ({ current: null as WalletRoutePolicy | null }));
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  detectRoutePolicy: () => livePolicy.current,
}));

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const escaped = (text: string) => text.replaceAll("'", '&#x27;');

/** A hypothetical swap-enabled policy; no production environment can build one today. */
const SWAP_POLICY: WalletRoutePolicy = Object.freeze({
  maxIntents: 1,
  maxRelayFee: 5n,
  enabledRoutes: Object.freeze(['swap'] as const),
  allowedTokens: Object.freeze({ shield: [], unshield: [], transfer: [], swap: Object.freeze([STRK]) }),
  swap: Object.freeze({ expectedChainId: '0x534e5f4d41494e', slippageBps: 50 }),
});

const UNAPPROVED_SWAP: readonly RouteGrade[] = PRIVACY_REGISTER.map((entry) => entry.route === 'exchange.swap'
  ? { ...entry, disclosure: null, approvedBy: null, approvedOn: null, rationale: null }
  : entry);

function degenStation(): string {
  return renderToStaticMarkup(
    <PrivacyProvider operations={new FakePrivacyOperations()}>
      <DegenCatalogProvider demo build={{ production: false }}>
        <VisitLayerView
          state={{ name: 'visiting', building: 'exchange', surface: { name: 'station', station: 'exchange:degen' } }}
          connected
          onOpenMenu={() => {}}
          onRequestExit={() => {}}
          onCloseSurface={() => {}}
          onDismissLocked={() => {}}
        />
      </DegenCatalogProvider>
    </PrivacyProvider>,
  );
}

describe('the degen counter follows the ground-floor swap exactly', () => {
  afterEach(() => {
    livePolicy.current = null;
  });

  it('opens in demo, where there is no production policy, labelled DEGEN SWAP', () => {
    expect(resolveStation('exchange', 'exchange:degen', PRIVACY_REGISTER, {}, null)).toMatchObject({
      status: 'available',
      definition: { label: 'DEGEN SWAP', routes: ['exchange.swap'], view: 'exchange', mode: 'degen' },
    });
    expect(stationSnapshot('exchange', PRIVACY_REGISTER, {}, null)).toEqual([
      { station: 'exchange:swap', label: 'SWAP', status: 'available' },
      { station: 'exchange:degen', label: 'DEGEN SWAP', status: 'available' },
    ]);
    const markup = degenStation();
    expect(markup).not.toContain('data-lock-reason');
    expect(markup).toContain('data-brand="degen"');
    expect(markup).toContain(COPY.degen.eyebrow);
  });

  it('stays locked in production, where swap is denied, with swap\'s own line and no form', () => {
    livePolicy.current = routePolicyFrom({ VITE_WALLET_MODE: 'real' });
    expect(livePolicy.current?.enabledRoutes).toEqual([]);

    expect(resolveStation('exchange', 'exchange:degen', PRIVACY_REGISTER, {}, livePolicy.current)).toMatchObject({
      status: 'locked',
      door: { reason: 'not-enabled', message: COPY.locked.notEnabled.swap },
    });
    expect(stationSnapshot('exchange', PRIVACY_REGISTER, {}, livePolicy.current)).toEqual([
      { station: 'exchange:swap', label: 'SWAP', status: 'locked' },
      { station: 'exchange:degen', label: 'DEGEN SWAP', status: 'locked' },
    ]);
    const markup = degenStation();
    expect(markup).toContain('data-lock-reason="not-enabled"');
    expect(markup).toContain(escaped(COPY.locked.notEnabled.swap));
    expect(markup).not.toContain('name="amount"');
    expect(markup).not.toContain(COPY.balance.refresh);
    expect(markup).not.toContain(COPY.degen.intro);
  });

  it('matches the ground-floor counter under every policy and register', () => {
    const policies: Array<WalletRoutePolicy | null> = [
      null,
      parseRoutePolicy({}),
      parseRoutePolicy({
        VITE_STRK20_UNSHIELD_ENABLED: 'true',
        VITE_STRK20_UNSHIELD_MAX_INTENTS: '1',
        VITE_STRK20_UNSHIELD_MAX_RELAY_FEE: '5',
        VITE_STRK20_UNSHIELD_ALLOWED_TOKENS: STRK,
      }),
      SWAP_POLICY,
    ];
    for (const register of [PRIVACY_REGISTER, UNAPPROVED_SWAP]) {
      for (const policy of policies) {
        const ground = resolveStation('exchange', 'exchange:swap', register, {}, policy);
        const degen = resolveStation('exchange', 'exchange:degen', register, {}, policy);
        expect(degen.status).toBe(ground.status);
        if (ground.status === 'locked' && degen.status === 'locked') expect(degen.door).toEqual(ground.door);
      }
    }
    expect(resolveStation('exchange', 'exchange:degen', PRIVACY_REGISTER, {}, SWAP_POLICY).status).toBe('available');
    expect(resolveStation('exchange', 'exchange:degen', UNAPPROVED_SWAP, {}, null)).toMatchObject({
      status: 'locked', door: { reason: 'unapproved-route' },
    });
  });

  it('shows every listed token this build cannot swap as display only', async () => {
    // Swap switched on for STRK alone: the degen list is listed, not swappable.
    livePolicy.current = SWAP_POLICY;
    const { createExchangePanel } = await import('../panels/exchange/exchange-machine.js');
    const { degenExchangeCatalog, policyAdmitsSwapToken } = await import('../panels/exchange/degen-catalog.js');
    const { DEMO_DEGEN_CATALOG } = await import('../privacy/demo-degen.js');
    const { createReceiptLedger } = await import('../receipts/receipt-ledger.js');
    const panel = createExchangePanel({
      operations: new FakePrivacyOperations(),
      receipts: createReceiptLedger(),
      canStartFinancialAction: () => true,
      catalog: degenExchangeCatalog(DEMO_DEGEN_CATALOG, (token) => policyAdmitsSwapToken(livePolicy.current, token)),
    });
    await panel.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const catalog = panel.store.getState().catalog;
    expect(catalog.status).toBe('ready');
    if (catalog.status !== 'ready') return;
    expect(catalog.assets.filter((asset) => asset.swappable).map((asset) => asset.symbol)).toEqual(['STRK']);
    expect(catalog.assets.filter((asset) => asset.swappable === false)).toHaveLength(9);
  });
});
