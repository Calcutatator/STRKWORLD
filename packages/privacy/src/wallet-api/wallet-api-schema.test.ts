import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { STRK20_ACTION } from 'starknet';
import {
  ENDUR_XSTRK,
  ENDUR_XSTRK_ASSET,
  WalletApiPrivacyOperations,
  type Intent,
  type PoolReadClient,
  type WalletRoutePolicy,
  type WalletStrk20Account,
} from '../index.js';

/**
 * The stake request checked against the Wallet API schema STRKWORLD pins:
 * `@starknet-io/types-js` 0.10.4. Ready refused a stake whose actions carried
 * padded felts (`0x030dee…`, `0x04718f…`) as 114 `INVALID_REQUEST_PAYLOAD`.
 * The patterns are read from the installed schema itself, so a schema bump
 * that changes them fails here rather than on a player's wallet.
 */

const require = createRequire(import.meta.url);
const typesRoot = dirname(require.resolve('@starknet-io/types-js/package.json'));
const typesVersion = (JSON.parse(readFileSync(join(typesRoot, 'package.json'), 'utf8')) as { version: string }).version;
const apiComponents = readFileSync(join(typesRoot, 'dist/types/api/components.d.ts'), 'utf8');
const walletComponents = readFileSync(join(typesRoot, 'dist/types/wallet-api/components.d.ts'), 'utf8');

/** The `@pattern` in the doc comment directly above `export type <name> = string;`. */
function schemaPattern(source: string, name: string): RegExp {
  const match = new RegExp(`@pattern (\\S+)\\s*\\*/\\s*export type ${name} = string;`).exec(source);
  if (!match?.[1]) throw new Error(`No @pattern for ${name} in the installed schema.`);
  return new RegExp(match[1]);
}

const FELT = schemaPattern(apiComponents, 'FELT');
const PLACEHOLDER = schemaPattern(walletComponents, 'STRK20_CALLDATA_PLACEHOLDER');

/** Every key each action variant declares in 0.10.4, in no particular order. */
const ACTION_KEYS: Record<string, readonly string[]> = {
  deposit: ['type', 'token', 'amount'],
  withdraw: ['type', 'token', 'amount', 'recipient'],
  transfer: ['type', 'token', 'amount', 'recipient'],
  invoke: ['type', 'contract', 'calldata'],
};

/** Every way `action` breaks the 0.10.4 schema; empty when it conforms. */
function schemaViolations(action: STRK20_ACTION, where: string): string[] {
  const problems: string[] = [];
  const record = action as unknown as Record<string, unknown>;
  const expected = ACTION_KEYS[String(record.type)];
  if (!expected) return [`${where}: unsupported action type ${String(record.type)}`];
  const keys = Object.keys(record).sort();
  if (keys.join() !== [...expected].sort().join()) problems.push(`${where}: keys ${keys.join()}`);
  const felt = (field: string, value: unknown) => {
    if (typeof value !== 'string' || !FELT.test(value)) problems.push(`${where}.${field}: ${String(value)} is not a FELT`);
  };
  switch (action.type) {
    case 'deposit':
      felt('token', action.token);
      felt('amount', action.amount);
      break;
    case 'withdraw':
      felt('token', action.token);
      felt('amount', action.amount);
      felt('recipient', action.recipient);
      break;
    case 'transfer':
      felt('token', action.token);
      if (action.amount !== 'OPEN') felt('amount', action.amount);
      felt('recipient', action.recipient);
      break;
    case 'invoke':
      felt('contract', action.contract);
      if (!Array.isArray(action.calldata)) {
        problems.push(`${where}.calldata: not an array`);
        break;
      }
      action.calldata.forEach((item, index) => {
        if (typeof item !== 'string' || !(FELT.test(item) || PLACEHOLDER.test(item))) {
          problems.push(`${where}.calldata.${index}: ${String(item)} is neither a FELT nor a placeholder`);
        }
      });
      break;
    default:
      problems.push(`${where}: not checked here`);
  }
  return problems;
}

function stakeHarness(address: string) {
  const invoked: STRK20_ACTION[][] = [];
  const wallet: WalletStrk20Account = {
    address,
    async strk20Balances(tokens) {
      return tokens.map((token) => ({ token, balance: '0x64' }));
    },
    async strk20InvokeTransaction(actions) {
      invoked.push(actions);
      return { transaction_hash: '0x5eed' };
    },
    async strk20PrepareInvoke() {
      throw new Error('a stake is submitted, never prepared');
    },
  };
  const pool: PoolReadClient = {
    async config() {
      return { feeAmount: 6n * 10n ** 18n, feeToken: ENDUR_XSTRK_ASSET, proofValidityBlocks: 450, noteMaturityBlocks: 10 };
    },
    async publicKey() {
      return '0x99';
    },
    async receipt() {
      throw new Error('no receipt read here');
    },
  };
  const policy: WalletRoutePolicy = {
    maxIntents: 8,
    maxRelayFee: 0n,
    enabledRoutes: ['stake'],
    allowedTokens: { shield: [], unshield: [], transfer: [], swap: [], stake: [ENDUR_XSTRK_ASSET, ENDUR_XSTRK] },
  };
  const ops = new WalletApiPrivacyOperations({
    wallet,
    pool,
    supportedVersions: vi.fn(async () => ['0.10.4']),
    policy,
  });
  return { ops, invoked };
}

async function stakeRequest(amountIn: bigint, address: string): Promise<STRK20_ACTION[]> {
  const { ops, invoked } = stakeHarness(address);
  const intent: Intent = { kind: 'stake', tokenIn: ENDUR_XSTRK_ASSET, tokenOut: ENDUR_XSTRK, amountIn };
  const batch = await ops.prepare([intent]);
  await batch.confirm({ feeCeiling: 6n * 10n ** 18n });
  expect(invoked).toHaveLength(1);
  return invoked[0]!;
}

describe('the Wallet API 0.10.4 schema the payload is checked against', () => {
  it('is the pinned types-js, and its patterns say what the stake fix relies on', () => {
    expect(typesVersion).toBe('0.10.4');
    expect(FELT.source).toBe('^0x(0|[a-fA-F1-9]{1}[a-fA-F0-9]{0,62})$');
    expect(PLACEHOLDER.test('${openNoteIds[0]}')).toBe(true);
    expect(PLACEHOLDER.test('${poolAddress}')).toBe(true);
    // A padded felt, as the pinned constants are written, is not a FELT.
    expect(FELT.test(ENDUR_XSTRK_ASSET)).toBe(false);
    expect(FELT.test(`0x${BigInt(ENDUR_XSTRK_ASSET).toString(16)}`)).toBe(true);
    expect(FELT.test('0x0')).toBe(true);
  });

  it('finds the padded felts in the request Ready refused as 114', () => {
    const refused: STRK20_ACTION[] = [
      { type: 'withdraw', token: ENDUR_XSTRK_ASSET, amount: '0x8ac7230489e80000', recipient: '0x030dee638065962eb3642ca54aa48e9e2cd98536bc90b64b99bb306c1db30698' },
      { type: 'transfer', token: ENDUR_XSTRK, amount: 'OPEN', recipient: '0xabc' },
      {
        type: 'invoke',
        contract: '0x030dee638065962eb3642ca54aa48e9e2cd98536bc90b64b99bb306c1db30698',
        calldata: [ENDUR_XSTRK_ASSET, ENDUR_XSTRK, '0x8ac7230489e80000', '0x0', '${openNoteIds[0]}'],
      },
    ];
    const problems = refused.flatMap((action, index) => schemaViolations(action, `actions.${index}`));
    expect(problems).toEqual([
      expect.stringContaining('actions.0.token'),
      expect.stringContaining('actions.0.recipient'),
      expect.stringContaining('actions.1.token'),
      expect.stringContaining('actions.2.contract'),
      expect.stringContaining('actions.2.calldata.0'),
      expect.stringContaining('actions.2.calldata.1'),
    ]);
  });
});

describe('the stake request against the 0.10.4 schema', () => {
  it.each([
    ['10 STRK, the live failure', 10n * 10n ** 18n],
    ['one base unit', 1n],
    ['the largest u128', (1n << 128n) - 1n],
  ])('conforms for %s', async (_label, amountIn) => {
    const actions = await stakeRequest(amountIn, '0xabc');
    expect(actions.flatMap((action, index) => schemaViolations(action, `actions.${index}`))).toEqual([]);
  });

  it('conforms when the wallet reports its own address padded', async () => {
    const padded = `0x${'abc'.padStart(64, '0')}`;
    const actions = await stakeRequest(10n * 10n ** 18n, padded);
    expect(actions.flatMap((action, index) => schemaViolations(action, `actions.${index}`))).toEqual([]);
    expect(actions[1]).toEqual({ type: 'transfer', token: `0x${BigInt(ENDUR_XSTRK).toString(16)}`, amount: 'OPEN', recipient: '0xabc' });
  });
});
