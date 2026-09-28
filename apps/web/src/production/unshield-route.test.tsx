import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FakePrivacyOperations,
  WalletApiPrivacyOperations,
  type Address,
  type PoolReadClient,
  type PrivateSubmissionGateway,
  type WalletRoutePolicy,
  type WalletStrk20Account,
} from '@strkworld/privacy';
import { COPY } from '../copy.js';
import { parseTokenAmount } from '../format.js';
import { BankPanel } from '../panels/bank/BankPanel.js';
import { createBankPanel } from '../panels/bank/bank-machine.js';
import { routeDoor } from '../panels/routes.js';
import { PrivacyProvider } from '../privacy/PrivacyProvider.js';
import { PRIVACY_REGISTER } from '../privacy/register.js';
import { createReceiptLedger } from '../receipts/receipt-ledger.js';
import { resolveStation, stationSnapshot } from '../visits/station-registry.js';
import { detectRoutePolicy, parseRoutePolicy, routePolicyFrom } from './config.js';

/**
 * D-062 end to end: the production environment switch is the only thing that
 * opens unshield, from the parsed policy through the Shell's doors and the
 * Bank's Unshield tab down to the Wallet API adapter's relayed route.
 *
 * Vite inlines `import.meta.env` when it transforms a module, so `vi.stubEnv`
 * cannot reach `detectRoutePolicy()`. The rendered Bank reads the live policy
 * through it, so it is replaced here by the real parser's output for a given
 * environment, and `routePolicyFrom` covers the environment-to-policy step.
 */
const livePolicy = vi.hoisted(() => ({ current: null as WalletRoutePolicy | null }));
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  detectRoutePolicy: () => livePolicy.current,
}));

const STRK: Address = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const BOB: Address = '0x456';
const FEE_RECIPIENT: Address = '0x789';
const POOL_FEE = 6n * 10n ** 18n;

const UNSHIELD_ENV = {
  VITE_STRK20_UNSHIELD_ENABLED: 'true',
  VITE_STRK20_UNSHIELD_MAX_INTENTS: '1',
  VITE_STRK20_UNSHIELD_MAX_RELAY_FEE: '5',
  VITE_STRK20_UNSHIELD_ALLOWED_TOKENS: STRK,
};
const SHIELD_ENV = {
  VITE_STRK20_SHIELD_ENABLED: 'true',
  VITE_STRK20_SHIELD_MAX_INTENTS: '1',
  VITE_STRK20_SHIELD_ALLOWED_TOKENS: STRK,
};

const unshieldOnly = parseRoutePolicy(UNSHIELD_ENV);
const shieldOnly = parseRoutePolicy(SHIELD_ENV);
const denyAll = parseRoutePolicy({});

describe('the Shell opens unshield exactly when the production policy enables it', () => {
  it('opens the Unshield door and nothing else for an unshield-only build', () => {
    expect(routeDoor('bank.unshield', PRIVACY_REGISTER, unshieldOnly)).toMatchObject({ open: true, reason: null });
    for (const route of ['bank.shield', 'post-office.transfer', 'exchange.swap'] as const) {
      expect(routeDoor(route, PRIVACY_REGISTER, unshieldOnly), route).toMatchObject({ open: false, reason: 'not-enabled' });
    }
  });

  it('keeps the Unshield door shut, with its own reason, whenever the switch is off', () => {
    for (const policy of [shieldOnly, denyAll]) {
      expect(routeDoor('bank.unshield', PRIVACY_REGISTER, policy)).toEqual({
        open: false,
        reason: 'not-enabled',
        message: COPY.locked.notEnabled.unshield,
      });
    }
  });

  it('opens the shared Bank station for unshield alone and keeps every other station shut', () => {
    expect(resolveStation('bank', 'bank:shielding', PRIVACY_REGISTER, {}, unshieldOnly).status).toBe('available');
    expect(stationSnapshot('bank', PRIVACY_REGISTER, {}, unshieldOnly)).toEqual([
      { station: 'bank:shielding', label: 'SHIELD / UNSHIELD', status: 'available' },
      // Enabling unshield enables nothing else (D-062), staking included.
      { station: 'bank:staking', label: 'STAKE', status: 'locked' },
    ]);
    expect(resolveStation('post-office', 'post-office:transfer', PRIVACY_REGISTER, {}, unshieldOnly))
      .toMatchObject({ status: 'locked', door: { reason: 'not-enabled' } });
    expect(resolveStation('exchange', 'exchange:swap', PRIVACY_REGISTER, {}, unshieldOnly))
      .toMatchObject({ status: 'locked', door: { reason: 'not-enabled' } });
    expect(resolveStation('bank', 'bank:shielding', PRIVACY_REGISTER, {}, denyAll))
      .toMatchObject({ status: 'locked', door: { reason: 'not-enabled' } });
  });
});

describe("the Bank's Unshield tab follows this build's environment", () => {
  afterEach(() => {
    livePolicy.current = null;
  });

  function stubProduction(environment: Record<string, string>): void {
    livePolicy.current = routePolicyFrom({ VITE_WALLET_MODE: 'real', ...environment });
  }

  it('derives the live policy from the environment only for a production-wallet build', () => {
    expect(routePolicyFrom({ VITE_WALLET_MODE: 'real', ...UNSHIELD_ENV })?.enabledRoutes).toEqual(['unshield']);
    expect(routePolicyFrom({ PROD: true, ...UNSHIELD_ENV })?.enabledRoutes).toEqual(['unshield']);
    expect(routePolicyFrom({ VITE_WALLET_MODE: 'real' })?.enabledRoutes).toEqual([]);
    expect(routePolicyFrom({ VITE_WALLET_MODE: 'demo', ...UNSHIELD_ENV })).toBeNull();
    expect(routePolicyFrom(undefined)).toBeNull();
  });

  async function renderTabs(): Promise<{ markup: string; unshieldOpen: boolean }> {
    const operations = new FakePrivacyOperations({ balances: { [STRK]: parseTokenAmount('100')! } });
    const panel = createBankPanel({
      operations,
      receipts: createReceiptLedger(),
      allowedModes: ['shield', 'unshield'],
      initialMode: 'unshield',
      canStartFinancialAction: () => true,
    });
    await panel.open();
    const markup = renderToStaticMarkup(
      <PrivacyProvider operations={operations}>
        <BankPanel panel={panel} onClose={() => {}} allowedModes={['shield', 'unshield']} initialMode="unshield" />
      </PrivacyProvider>,
    );
    return { markup, unshieldOpen: panel.store.getState().door.open };
  }

  const lockedTab = (label: string) => new RegExp(`<button[^>]*data-locked="true"[^>]*>${label}</button>`);
  const tab = (label: string) => new RegExp(`<button[^>]*>${label}</button>`);

  it('opens the tab when the environment enables unshield, and leaves shield shut', async () => {
    stubProduction(UNSHIELD_ENV);
    expect(detectRoutePolicy()?.enabledRoutes).toEqual(['unshield']);

    const { markup, unshieldOpen } = await renderTabs();

    expect(unshieldOpen).toBe(true);
    expect(markup).toMatch(tab(COPY.bank.unshield));
    expect(markup).not.toMatch(lockedTab(COPY.bank.unshield));
    expect(markup).toMatch(lockedTab(COPY.bank.shield));
  });

  it('locks the tab when the environment leaves unshield off', async () => {
    stubProduction({ ...SHIELD_ENV, ...UNSHIELD_ENV, VITE_STRK20_UNSHIELD_ENABLED: 'false' });
    expect(detectRoutePolicy()?.enabledRoutes).toEqual(['shield']);

    const { markup, unshieldOpen } = await renderTabs();

    expect(unshieldOpen).toBe(false);
    expect(markup).toMatch(lockedTab(COPY.bank.unshield));
    expect(markup).toContain('data-lock-reason="not-enabled"');
    expect(markup).toContain(COPY.locked.notEnabled.unshield.replaceAll("'", '&#x27;'));
  });
});

describe('the Wallet API adapter relays unshield under the parsed policy', () => {
  function adapter(policy: WalletRoutePolicy, relayFee = 5n) {
    // The shell speaks typed intents only. The wallet's proof stays opaque
    // here: the adapter must hand it to the relay unchanged, so this test
    // never builds or opens a protocol action (D-018).
    const proof = Object.freeze({ opaque: 'wallet-proof' }) as unknown as Awaited<
      ReturnType<WalletStrk20Account['strk20PrepareInvoke']>
    >;
    const wallet: WalletStrk20Account = {
      address: '0xabc',
      strk20Balances: async (tokens) => tokens.map((token) => ({ token, balance: '0x64' })),
      strk20InvokeTransaction: vi.fn(async () => ({ transaction_hash: '0xshield' })),
      strk20PrepareInvoke: vi.fn(async () => proof),
    };
    const pool: PoolReadClient = {
      config: async () => ({ feeAmount: POOL_FEE, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 }),
      publicKey: async (address) => (address === BOB ? '0x99' : '0x0'),
    };
    const gateway: PrivateSubmissionGateway = {
      estimate: vi.fn(async () => ({
        token: STRK,
        recipient: FEE_RECIPIENT,
        amount: relayFee,
        authorization: 'fee-auth',
        expiresAtBlock: 1_450,
      })),
      submit: vi.fn(async () => ({ transactionHash: '0xunshield' })),
    };
    const ops = new WalletApiPrivacyOperations({
      wallet,
      pool,
      submission: gateway,
      supportedVersions: async () => ['0.10.3'],
      policy,
    });
    return { ops, gateway, wallet, proof };
  }

  const unshieldIntent = { kind: 'unshield', token: STRK, amount: 20n, recipient: BOB } as const;
  const transferIntent = { kind: 'transfer', token: STRK, amount: 20n, recipient: BOB } as const;

  it('prepares, proves and submits a STRK unshield as a relayed pool-native route', async () => {
    const { ops, gateway, wallet, proof } = adapter(unshieldOnly);

    const batch = await ops.prepare([unshieldIntent]);
    const result = await batch.confirm({ feeCeiling: POOL_FEE + 5n });

    expect(result).toEqual({ transactionHash: '0xunshield' });
    expect(gateway.estimate).toHaveBeenCalledWith(expect.objectContaining({
      route: 'unshield',
      feeToken: STRK,
      operationToken: STRK,
    }));
    expect(wallet.strk20PrepareInvoke).toHaveBeenCalledOnce();
    expect(wallet.strk20InvokeTransaction).not.toHaveBeenCalled();
    expect(gateway.submit).toHaveBeenCalledOnce();
    const submitted = vi.mocked(gateway.submit).mock.calls[0]![0];
    expect(submitted).toMatchObject({ route: 'unshield', feeAuthorization: 'fee-auth', proofValidityBlocks: 450 });
    expect(submitted.artifact).toBe(proof);
  });

  it('refuses a relay fee above the unshield ceiling and a batch above its intent bound', async () => {
    await expect(adapter(unshieldOnly, 6n).ops.prepare([unshieldIntent])).rejects.toThrow(/relay fee exceeds/i);
    await expect(adapter(unshieldOnly).ops.prepare([unshieldIntent, unshieldIntent])).rejects.toThrow(/too many intents/i);
  });

  it('holds both relayed routes to the strictest merged ceiling', async () => {
    const merged = parseRoutePolicy({
      ...UNSHIELD_ENV,
      VITE_STRK20_TRANSFER_ENABLED: 'true',
      VITE_STRK20_TRANSFER_MAX_INTENTS: '2',
      VITE_STRK20_TRANSFER_MAX_RELAY_FEE: '7',
      VITE_STRK20_TRANSFER_ALLOWED_TOKENS: STRK,
    });
    expect(merged.maxRelayFee).toBe(5n);

    // 6 is inside transfer's own ceiling of 7, but not inside the merged one.
    await expect(adapter(merged, 6n).ops.prepare([transferIntent])).rejects.toThrow(/relay fee exceeds/i);
    await expect(adapter(merged, 6n).ops.prepare([unshieldIntent])).rejects.toThrow(/relay fee exceeds/i);
    await expect(adapter(merged, 5n).ops.prepare([transferIntent])).resolves.toMatchObject({ poolFee: POOL_FEE });
    await expect(adapter(merged, 5n).ops.prepare([unshieldIntent])).resolves.toMatchObject({ poolFee: POOL_FEE });
  });

  it('admits no other route or token through the unshield switch', async () => {
    const { ops } = adapter(unshieldOnly);

    await expect(ops.prepare([{ kind: 'shield', token: STRK, amount: 20n }])).rejects.toThrow(/disabled/i);
    await expect(ops.prepare([transferIntent])).rejects.toThrow(/disabled/i);
    await expect(ops.prepare([{ kind: 'swap', tokenIn: STRK, tokenOut: '0x123', amountIn: 20n, minAmountOut: 1n }]))
      .rejects.toThrow(/disabled/i);
    await expect(ops.prepare([{ ...unshieldIntent, token: '0x123' }])).rejects.toThrow(/allowlisted/i);
  });
});
