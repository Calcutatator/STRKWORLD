/**
 * @vitest-environment jsdom
 */

import { MockWallet } from '@starknetfoundation/starknet-start-react';
import type { WalletWithStarknetFeatures } from '@starknet-io/get-starknet-wallet-standard/features';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AccountInterface } from 'starknet';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProductionWalletSession, type Intent } from '../index.js';

const MAINNET_CHAIN_ID = '0x534e5f4d41494e';
const ACCOUNT = '0x123';
const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const TOKEN = '0x456';
const RECIPIENT = '0x789';
const RELAY_RECIPIENT = '0xabc';
const POOL_FEE = 2n;
const RELAY_FEE = 1n;

describe('Wallet Standard forward compatibility', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('admits a dynamically registered non-extension wallet and drives every game operation', async () => {
    const backendRequests: BackendRequest[] = [];
    vi.stubGlobal('fetch', backendFetcher(backendRequests));
    const account = { address: ACCOUNT } as AccountInterface;
    const mock = new MockWallet(
      { mainnet: [account], sepolia: [account] },
      { id: 'hosted-frame', name: 'Hosted frame signer', available: true },
    );
    mock.switchChain(BigInt(MAINNET_CHAIN_ID));
    const { wallet, requests: walletRequests } = completeWalletApi(mock);
    const session = createProductionWalletSession({
      rpcUrl: 'https://rpc.invalid',
      backendBaseUrl: '/api',
      policy: {
        maxIntents: 4,
        maxRelayFee: 5n,
        enabledRoutes: ['shield', 'unshield', 'transfer', 'swap'],
        allowedTokens: {
          shield: [STRK, TOKEN],
          unshield: [STRK, TOKEN],
          transfer: [STRK, TOKEN],
          swap: [STRK, TOKEN],
        },
        swap: { expectedChainId: MAINNET_CHAIN_ID, slippageBps: 100 },
      },
    });
    expect(Object.getOwnPropertyNames(window).filter((name) => name.startsWith('starknet')))
      .toEqual([]);
    const unregister = announceWallet(wallet);

    try {
      const [choice] = session.getSnapshot().wallets;
      expect(choice?.name).toBe('Hosted frame signer');
      await session.connect(choice!.key);

      await expect(session.operations.capability()).resolves.toMatchObject({
        supportsStrk20: true,
        walletApiVersion: '0.10.3',
      });
      expect(walletRequests.map(({ type }) => type)).toEqual([
        'wallet_requestChainId',
        'wallet_supportedWalletApi',
      ]);

      await expect(session.operations.poolConfig()).resolves.toEqual({
        feeAmount: POOL_FEE,
        feeToken: STRK,
        proofValidityBlocks: 450,
        noteMaturityBlocks: 10,
      });
      await expect(session.operations.balances([TOKEN])).resolves.toEqual([{
        token: TOKEN,
        total: 0n,
        spendable: 0n,
        maturing: 0n,
        maturityKnown: false,
      }]);
      await expect(session.operations.recipientStatus(RECIPIENT)).resolves.toBe('registered');

      const cases: Array<{
        name: Intent['kind'];
        intent: Intent;
        walletMethod: string;
        actionTypes: string[];
        receipt: string;
      }> = [
        {
          name: 'shield',
          intent: { kind: 'shield', token: TOKEN, amount: 20n },
          walletMethod: 'wallet_strk20InvokeTransaction',
          actionTypes: ['deposit'],
          receipt: '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
        {
          name: 'unshield',
          intent: { kind: 'unshield', token: TOKEN, amount: 10n, recipient: RECIPIENT },
          walletMethod: 'wallet_strk20PrepareInvoke',
          actionTypes: ['withdraw', 'withdraw'],
          receipt: '0xunshield',
        },
        {
          name: 'transfer',
          intent: { kind: 'transfer', token: TOKEN, amount: 5n, recipient: RECIPIENT },
          walletMethod: 'wallet_strk20PrepareInvoke',
          actionTypes: ['transfer', 'withdraw'],
          receipt: '0xtransfer',
        },
        {
          name: 'swap',
          intent: { kind: 'swap', tokenIn: TOKEN, tokenOut: STRK, amountIn: 20n, minAmountOut: 90n },
          walletMethod: 'wallet_strk20PrepareInvoke',
          actionTypes: ['withdraw', 'withdraw', 'transfer', 'invoke'],
          receipt: '0xswap',
        },
      ];

      for (const operation of cases) {
        const before = walletRequests.length;
        const batch = await session.operations.prepare([operation.intent]);
        await expect(batch.confirm({ feeCeiling: POOL_FEE + RELAY_FEE }))
          .resolves.toEqual({ transactionHash: operation.receipt });
        const handoff = walletRequests.slice(before)
          .find(({ type }) => type === operation.walletMethod);
        expect(handoff, operation.name).toBeDefined();
        expect(actionTypesOf(handoff!), operation.name).toEqual(operation.actionTypes);
      }

      expect(walletRequests.map(({ type }) => type).filter((type) => type === 'wallet_strk20Balances'))
        .toHaveLength(1);
      expect(walletRequests.map(({ type }) => type).filter((type) => type === 'wallet_strk20PrepareInvoke'))
        .toHaveLength(3);
      expect(backendRequests.map(({ path }) => path)).toEqual(expect.arrayContaining([
        '/api/v1/rpc/pool-config',
        '/api/v1/rpc/public-key',
        '/api/v1/private/fees',
        '/api/v1/private/swaps/prepare',
        '/api/v1/private/submissions',
      ]));
      expect(backendRequests
        .filter(({ path }) => path === '/api/v1/private/submissions')
        .map(({ body }) => body['route']))
        .toEqual(['unshield', 'transfer', 'swap']);

      const source = productionPrivacySource();
      expect(source).not.toContain(['get', 'starknet', 'wallets'].join('-'));
      expect(source).not.toMatch(/wallet\.(?:id|name)\s*[!=]==|walletId\s*[!=]==/);
    } finally {
      unregister();
      session.destroy();
    }
  });
});

function announceWallet(wallet: unknown): () => void {
  let unregister: () => void = () => undefined;
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', {
    detail(api: { register(candidate: unknown): () => void }) {
      unregister = api.register(wallet);
    },
  }));
  return () => unregister();
}

interface WalletRequest {
  readonly type: string;
  readonly params?: unknown;
}

interface BackendRequest {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

function completeWalletApi(mock: MockWallet): {
  wallet: WalletWithStarknetFeatures;
  requests: WalletRequest[];
} {
  const features = mock.features;
  const walletApi = features['starknet:walletApi'];
  const requests: WalletRequest[] = [];
  const request = (async (input: { type: string; params?: unknown }) => {
    requests.push(input);
    if (input.type === 'wallet_supportedWalletApi') return ['0.10.3'];
    return walletApi.request(input as never);
  }) as typeof walletApi.request;
  const wallet = {
    version: mock.version,
    name: mock.name,
    icon: mock.icon,
    get chains() { return mock.chains; },
    get accounts() { return mock.accounts; },
    features: {
      ...features,
      'starknet:walletApi': { ...walletApi, request },
    },
  } as unknown as WalletWithStarknetFeatures;
  return { wallet, requests };
}

function backendFetcher(requests: BackendRequest[]) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input, 'https://strkworld.invalid').pathname;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ path, body });
    let value: unknown;
    switch (path) {
      case '/api/v1/rpc/pool-config':
        value = {
          feeAmount: POOL_FEE.toString(),
          feeToken: STRK,
          proofValidityBlocks: 450,
          noteMaturityBlocks: 10,
        };
        break;
      case '/api/v1/rpc/public-key':
        value = { publicKey: '0x1' };
        break;
      case '/api/v1/private/fees':
        value = {
          token: STRK,
          recipient: RELAY_RECIPIENT,
          amount: RELAY_FEE.toString(),
          authorization: `fee-${String(body['route'])}`,
          expiresAtBlock: 1_000,
        };
        break;
      case '/api/v1/private/swaps/prepare':
        value = {
          quoteId: 'quote-forward-compatible',
          buyAmount: '95',
          expiresAt: Date.now() + 60_000,
          chainId: MAINNET_CHAIN_ID,
          executorAddress: '0xdef',
          executorCalls: [{ contractAddress: '0x111', entrypoint: 'swap', calldata: ['0x1'] }],
          fee: {
            token: STRK,
            recipient: RELAY_RECIPIENT,
            amount: RELAY_FEE.toString(),
            authorization: 'fee-swap',
            expiresAtBlock: 1_000,
          },
        };
        break;
      case '/api/v1/private/submissions':
        value = { transactionHash: `0x${String(body['route'])}` };
        break;
      default:
        throw new Error(`Unexpected backend request: ${path}`);
    }
    return { ok: true, status: 200, json: async () => value } as Response;
  });
}

function actionTypesOf(request: WalletRequest): string[] {
  const params = request.params as { actions?: Array<{ type?: unknown }> } | undefined;
  return (params?.actions ?? []).map(({ type }) => String(type));
}

function productionPrivacySource(): string {
  const root = resolve(repositoryRoot(), 'packages/privacy/src');
  return sourceFiles(root)
    .filter((path) => !path.endsWith('.test.ts'))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
}

function repositoryRoot(): string {
  let candidate = process.cwd();
  while (!existsSync(resolve(candidate, 'packages/privacy/src'))) {
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error('Could not locate the repository root.');
    candidate = parent;
  }
  return candidate;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}
