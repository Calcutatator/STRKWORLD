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
import { BankMenuPanel } from '../panels/bank/BankMenuPanel.js';
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
 * Bank's Unshield tab down to the Wallet API adapter, where the wallet proves
 * and submits it (D-082).
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

  it('opens the UNSHIELD counter alone and keeps every other station shut (D-103)', () => {
    expect(resolveStation('bank', 'bank:unshielding', PRIVACY_REGISTER, {}, unshieldOnly).status).toBe('available');
    expect(stationSnapshot('bank', PRIVACY_REGISTER, {}, unshieldOnly)).toEqual([
      // Enabling unshield enables nothing else (D-062), shielding and staking included.
      { station: 'bank:shielding', label: 'SHIELD', status: 'locked' },
      { station: 'bank:unshielding', label: 'UNSHIELD', status: 'available' },
      { station: 'bank:staking', label: 'STAKE', status: 'locked' },
      { station: 'bank:unstaking', label: 'UNSTAKE', status: 'locked' },
    ]);
    expect(resolveStation('post-office', 'post-office:transfer', PRIVACY_REGISTER, {}, unshieldOnly))
      .toMatchObject({ status: 'locked', door: { reason: 'not-enabled' } });
    expect(resolveStation('exchange', 'exchange:swap', PRIVACY_REGISTER, {}, unshieldOnly))
      .toMatchObject({ status: 'locked', door: { reason: 'not-enabled' } });
    for (const station of ['bank:shielding', 'bank:unshielding'] as const) {
      expect(resolveStation('bank', station, PRIVACY_REGISTER, {}, denyAll), station)
        .toMatchObject({ status: 'locked', door: { reason: 'not-enabled' } });
    }
  });
});

describe("the Bank's UNSHIELD counter follows this build's environment (D-103)", () => {
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

  async function renderCounter(): Promise<{ markup: string; unshieldOpen: boolean }> {
    const operations = new FakePrivacyOperations({ balances: { [STRK]: parseTokenAmount('100')! } });
    const panel = createBankPanel({
      operations,
      receipts: createReceiptLedger(),
      allowedModes: ['unshield'],
      initialMode: 'unshield',
      canStartFinancialAction: () => true,
    });
    await panel.open();
    const markup = renderToStaticMarkup(
      <PrivacyProvider operations={operations}>
        <BankPanel panel={panel} onClose={() => {}} mode="unshield" />
      </PrivacyProvider>,
    );
    return { markup, unshieldOpen: panel.store.getState().door.open };
  }

  /** The Bank's Menu Mode tabs under the live policy (D-088 hides a counter its build leaves off). */
  function menuTabs(): string[] {
    const markup = renderToStaticMarkup(
      <PrivacyProvider operations={new FakePrivacyOperations()}>
        <BankMenuPanel onClose={() => {}} />
      </PrivacyProvider>,
    );
    return [...markup.matchAll(/role="tab"[^>]*>([^<]+)<\/button>/g)].map((match) => match[1]!);
  }

  it('opens the counter when the environment enables unshield, and offers its tab beside SHIELD', async () => {
    stubProduction(UNSHIELD_ENV);
    expect(detectRoutePolicy()?.enabledRoutes).toEqual(['unshield']);

    const { markup, unshieldOpen } = await renderCounter();

    expect(unshieldOpen).toBe(true);
    expect(markup).toContain('name="recipient"');
    expect(markup).not.toContain('data-lock-reason');
    expect(menuTabs()).toEqual(['SHIELD', 'UNSHIELD']);
  });

  it('locks the counter, and hides its tab, when the environment leaves unshield off', async () => {
    stubProduction({ ...SHIELD_ENV, ...UNSHIELD_ENV, VITE_STRK20_UNSHIELD_ENABLED: 'false' });
    expect(detectRoutePolicy()?.enabledRoutes).toEqual(['shield']);

    const { markup, unshieldOpen } = await renderCounter();

    expect(unshieldOpen).toBe(false);
    expect(markup).toContain('data-lock-reason="not-enabled"');
    expect(markup).toContain(COPY.locked.notEnabled.unshield.replaceAll("'", '&#x27;'));
    expect(markup).not.toContain('name="recipient"');
    // SHIELD alone is left, so Menu Mode draws no tab row.
    expect(menuTabs()).toEqual([]);
  });
});

describe('the Wallet API adapter has the wallet submit unshield under the parsed policy (D-082)', () => {
  function adapter(policy: WalletRoutePolicy) {
    // The shell speaks typed intents only, so this test never builds or opens
    // a protocol action (D-018): it checks who is asked, not what.
    const wallet: WalletStrk20Account = {
      address: '0xabc',
      strk20Balances: async (tokens) => tokens.map((token) => ({ token, balance: '0x64' })),
      strk20InvokeTransaction: vi.fn(async () => ({ transaction_hash: '0x5e1d' })),
      strk20PrepareInvoke: vi.fn(async () => { throw new Error('an unshield is not relayed'); }),
    };
    const pool: PoolReadClient = {
      config: async () => ({ feeAmount: POOL_FEE, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 }),
      publicKey: async (address) => (address === BOB ? '0x99' : '0x0'),
      receipt: async () => { throw new Error('no receipt read in this route test'); },
    };
    const gateway: PrivateSubmissionGateway = {
      estimate: vi.fn(async () => ({
        token: STRK,
        recipient: FEE_RECIPIENT,
        amount: 1n,
        authorization: 'fee-auth',
        expiresAtBlock: 1_450,
      })),
      submit: vi.fn(async () => ({ transactionHash: '0xunshield' })),
    };
    const ops = new WalletApiPrivacyOperations({
      wallet,
      pool,
      supportedVersions: async () => ['0.10.3'],
      policy,
    });
    return { ops, gateway, wallet };
  }

  const unshieldIntent = { kind: 'unshield', token: STRK, amount: 20n, recipient: BOB } as const;
  const transferIntent = { kind: 'transfer', token: STRK, amount: 20n, recipient: BOB } as const;

  it('prepares a STRK unshield at the pool fee and has the wallet prove and submit it, with no relay', async () => {
    const { ops, gateway, wallet } = adapter(unshieldOnly);

    const batch = await ops.prepare([unshieldIntent]);
    expect(batch).toMatchObject({ poolFee: POOL_FEE, gasEstimate: 0n, totalCost: POOL_FEE });
    const result = await batch.confirm({ feeCeiling: POOL_FEE });

    expect(result).toEqual({ transactionHash: '0x5e1d' });
    expect(wallet.strk20InvokeTransaction).toHaveBeenCalledOnce();
    expect(wallet.strk20PrepareInvoke).not.toHaveBeenCalled();
    expect(gateway.estimate).not.toHaveBeenCalled();
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  it('refuses a batch above the unshield intent bound', async () => {
    await expect(adapter(unshieldOnly).ops.prepare([unshieldIntent, unshieldIntent])).rejects.toThrow(/too many intents/i);
  });

  it('needs no relay quote for either pool spend under a merged policy', async () => {
    const merged = parseRoutePolicy({
      ...UNSHIELD_ENV,
      VITE_STRK20_TRANSFER_ENABLED: 'true',
      VITE_STRK20_TRANSFER_MAX_INTENTS: '2',
      VITE_STRK20_TRANSFER_MAX_RELAY_FEE: '7',
      VITE_STRK20_TRANSFER_ALLOWED_TOKENS: STRK,
    });
    const { ops, gateway } = adapter(merged);

    await expect(ops.prepare([transferIntent])).resolves.toMatchObject({ totalCost: POOL_FEE });
    await expect(ops.prepare([unshieldIntent])).resolves.toMatchObject({ totalCost: POOL_FEE });
    expect(gateway.estimate).not.toHaveBeenCalled();
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
