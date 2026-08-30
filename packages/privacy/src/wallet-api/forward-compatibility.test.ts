/**
 * @vitest-environment jsdom
 */

import { MockWallet } from '@starknetfoundation/starknet-start-react';
import type { WalletWithStarknetFeatures } from '@starknet-io/get-starknet-wallet-standard/features';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AccountInterface } from 'starknet';
import ts from 'typescript';
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
          receipt: '0x102',
        },
        {
          name: 'transfer',
          intent: { kind: 'transfer', token: TOKEN, amount: 5n, recipient: RECIPIENT },
          walletMethod: 'wallet_strk20PrepareInvoke',
          actionTypes: ['transfer', 'withdraw'],
          receipt: '0x103',
        },
        {
          name: 'swap',
          intent: { kind: 'swap', tokenIn: TOKEN, tokenOut: STRK, amountIn: 20n, minAmountOut: 90n },
          walletMethod: 'wallet_strk20PrepareInvoke',
          actionTypes: ['withdraw', 'withdraw', 'transfer', 'invoke'],
          receipt: '0x104',
        },
      ];

      for (const operation of cases) {
        const before = walletRequests.length;
        const batch = await session.operations.prepare([operation.intent]);
        await expect(batch.confirm({ feeCeiling: POOL_FEE + RELAY_FEE }))
          .resolves.toEqual({ transactionHash: operation.receipt });
        const handoff = walletRequests.slice(before);
        expect(handoff.map(({ type }) => type), operation.name).toEqual([operation.walletMethod]);
        expect(actionTypesOf(handoff[0]!), operation.name).toEqual(operation.actionTypes);
      }

      expect(walletRequests.map(({ type }) => type)).toEqual([
        'wallet_requestChainId',
        'wallet_supportedWalletApi',
        'wallet_strk20Balances',
        'wallet_strk20InvokeTransaction',
        'wallet_strk20PrepareInvoke',
        'wallet_strk20PrepareInvoke',
        'wallet_strk20PrepareInvoke',
      ]);
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

      const source = productionPrivacySources();
      const sourceText = source.map(({ text }) => text).join('\n');
      expect(sourceText).not.toContain(['get', 'starknet', 'wallets'].join('-'));
      expect(walletIdentityReads(source)).toEqual([]);
    } finally {
      unregister();
      session.destroy();
    }
  });

  it('rejects provider identity reads outside the display-only name projection', () => {
    const hostile = sourceFixture(`
      if (handle.name === 'Hosted frame signer') admit();
      if (wallet.name.includes('Ready')) admit();
      switch (provider['name']) { case 'Ready': admit(); }
      const supported = wallet.features['starknet:walletApi'].id === 'ready';
      const { name: providerName } = wallet;
      const { ['id']: featureId } = wallet.features['starknet:walletApi'];
      const identityName = 'name';
      wallet[identityName];
      const identityId = 'id';
      const { [identityId]: providerId } = wallet.features['starknet:walletApi'];
      let assignedName;
      ({ name: assignedName } = wallet);
      let assignedFeatureId;
      ({ [identityId]: assignedFeatureId } = wallet.features['starknet:walletApi']);
      let nestedProviderId;
      ({ features: { ['starknet:walletApi']: { id: nestedProviderId } } } = wallet);
      let arrayNestedName;
      ([{ provider: { name: arrayNestedName } }] = [wallet]);
      let arrayNestedFeatureId;
      ({ wallets: [{ [identityId]: arrayNestedFeatureId }] } = { wallets: [wallet] });
      for ({ provider: { name: assignedName } } of [wallet]) {}
      for ({ [identityId]: assignedFeatureId } of [wallet.features['starknet:walletApi']]) {}
    `);
    expect(walletIdentityReads([hostile])).toEqual([
      'fixture.ts:2:11 handle.name',
      'fixture.ts:3:11 wallet.name',
      "fixture.ts:4:15 provider['name']",
      "fixture.ts:5:25 wallet.features['starknet:walletApi'].id",
      'fixture.ts:6:15 name: providerName',
      "fixture.ts:7:15 ['id']: featureId",
      'fixture.ts:9:7 wallet[identityName]',
      'fixture.ts:11:15 [identityId]: providerId',
      'fixture.ts:13:10 name: assignedName',
      'fixture.ts:15:10 [identityId]: assignedFeatureId',
      'fixture.ts:17:48 id: nestedProviderId',
      'fixture.ts:19:23 name: arrayNestedName',
      'fixture.ts:21:22 [identityId]: arrayNestedFeatureId',
      'fixture.ts:22:26 name: assignedName',
      'fixture.ts:23:14 [identityId]: assignedFeatureId',
    ]);
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
    switch (input.type) {
      case 'wallet_supportedWalletApi':
        return ['0.10.3'];
      case 'wallet_requestChainId':
      case 'wallet_strk20Balances':
      case 'wallet_strk20PrepareInvoke':
      case 'wallet_strk20InvokeTransaction':
        return walletApi.request(input as never);
      default:
        throw new Error(`Unexpected wallet request: ${input.type}`);
    }
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
        value = {
          transactionHash: {
            shield: '0x101',
            unshield: '0x102',
            transfer: '0x103',
            swap: '0x104',
          }[String(body['route'])],
        };
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

interface SourceFixture {
  readonly path: string;
  readonly text: string;
}

function productionPrivacySources(): SourceFixture[] {
  const root = resolve(repositoryRoot(), 'packages/privacy/src');
  return sourceFiles(root)
    .filter((path) => !path.endsWith('.test.ts'))
    .map((path) => ({ path, text: readFileSync(path, 'utf8') }));
}

function sourceFixture(text: string): SourceFixture {
  return { path: 'fixture.ts', text };
}

function walletIdentityReads(sources: SourceFixture[]): string[] {
  return sources.flatMap(({ path, text }) => {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const violations: string[] = [];
    const visit = (node: ts.Node): void => {
      if (isIdentityRead(node)
        && !isAllowedDisplayOrErrorName(node, path)
        && !isAllowedProductionDynamicRead(node, path, source)) {
        const start = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(`${path.split('/').at(-1)}:${start.line + 1}:${start.character + 1} ${node.getText(source)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return violations;
  });
}

type IdentityRead = ts.PropertyAccessExpression
  | ts.ElementAccessExpression
  | ts.BindingElement
  | ts.PropertyAssignment
  | ts.ShorthandPropertyAssignment;

function isIdentityRead(node: ts.Node): node is IdentityRead {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'id' || node.name.text === 'name';
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    if (ts.isStringLiteralLike(node.argumentExpression)) {
      return node.argumentExpression.text === 'id' || node.argumentExpression.text === 'name';
    }
    return !ts.isNumericLiteral(node.argumentExpression);
  }
  if (ts.isBindingElement(node)) {
    return isIdentityPropertyName(node.propertyName ?? node.name, true);
  }
  return isIdentityAssignmentRead(node);
}

function isIdentityAssignmentRead(node: ts.Node): node is ts.PropertyAssignment | ts.ShorthandPropertyAssignment {
  if ((!ts.isPropertyAssignment(node) && !ts.isShorthandPropertyAssignment(node))
    || !ts.isObjectLiteralExpression(node.parent)
    || !isObjectAssignmentTarget(node.parent)) {
    return false;
  }
  return isIdentityPropertyName(node.name, true);
}

function isIdentityPropertyName(property: ts.PropertyName | ts.BindingName, failClosedComputed: boolean): boolean {
  if (ts.isComputedPropertyName(property)) {
    if (ts.isStringLiteralLike(property.expression)) {
      return property.expression.text === 'id' || property.expression.text === 'name';
    }
    return failClosedComputed && !ts.isNumericLiteral(property.expression);
  }
  return (ts.isIdentifier(property) || ts.isStringLiteralLike(property))
    && (property.text === 'id' || property.text === 'name');
}

function isObjectAssignmentTarget(node: ts.ObjectLiteralExpression): boolean {
  let current: ts.Node = node;
  while (true) {
    if (ts.isParenthesizedExpression(current.parent)) {
      current = current.parent;
      continue;
    }
    if (ts.isPropertyAssignment(current.parent) && current.parent.initializer === current) {
      current = current.parent;
      continue;
    }
    if (ts.isObjectLiteralExpression(current.parent)) {
      current = current.parent;
      continue;
    }
    if (ts.isArrayLiteralExpression(current.parent)) {
      current = current.parent;
      continue;
    }
    break;
  }
  if (ts.isBinaryExpression(current.parent)) {
    return current.parent.left === current
      && current.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  }
  return (ts.isForOfStatement(current.parent) || ts.isForInStatement(current.parent))
    && current.parent.initializer === current;
}

function isAllowedDisplayOrErrorName(
  node: IdentityRead,
  path: string,
): boolean {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'name') return false;
  if (path.endsWith('/wallet-api/session.ts')) {
    return ts.isIdentifier(node.expression)
      && node.expression.text === 'wallet'
      && ts.isPropertyAssignment(node.parent)
      && node.parent.initializer === node
      && node.parent.name.getText() === 'name';
  }
  if (path.endsWith('/wallet-api/errors.ts')) {
    return ts.isIdentifier(node.expression) && node.expression.text === 'error';
  }
  if (path.endsWith('/types.ts')) {
    return node.expression.kind === ts.SyntaxKind.ThisKeyword
      && ts.isBinaryExpression(node.parent)
      && node.parent.left === node
      && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
  }
  return false;
}

const ALLOWED_DYNAMIC_PROPERTY_READS = new Set([
  'testing/fake.ts:this.faults[index]',
  'testing/public-shield.ts:this.estimates[Math.min(this.calls, this.estimates.length - 1)]',
  'wallet-api/errors.ts:CODE_TO_KIND[code as keyof typeof CODE_TO_KIND]',
  'wallet-api/operations.ts:policy.allowedTokens[intent.kind]',
  'wallet-api/operations.ts:actual[index]',
  'wallet-api/operations.ts:left.core[index]',
  'wallet-api/operations.ts:right.core[index]',
  'wallet-api/operations.ts:left.prerelease[index]',
  'wallet-api/operations.ts:right.prerelease[index]',
]);

function isAllowedProductionDynamicRead(
  node: IdentityRead,
  path: string,
  source: ts.SourceFile,
): boolean {
  if (!ts.isElementAccessExpression(node) || !node.argumentExpression) return false;
  if (ts.isStringLiteralLike(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)) {
    return false;
  }
  const relative = path.split('/packages/privacy/src/').at(-1);
  return relative !== undefined
    && ALLOWED_DYNAMIC_PROPERTY_READS.has(`${relative}:${node.getText(source)}`);
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
