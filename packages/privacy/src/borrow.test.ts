import { describe, expect, it } from 'vitest';
import { CairoCustomEnum, CallData, hash } from 'starknet';
import {
  BORROW_DAPP_NAME,
  BORROW_MIN_HEALTH_AFTER,
  BORROW_PAIRS,
  BORROW_POOL,
  BORROW_SHADOW_NONCE,
  BORROW_TOKENS,
  BORROW_TOKEN_INFO,
  BORROW_WARNING_HEALTH,
  BorrowRefusedError,
  VESU_SCALE,
  assessBorrow,
  borrowAddCollateralActions,
  borrowHealth,
  borrowOpenActions,
  borrowPairKey,
  borrowPairOffered,
  borrowRepayActions,
  borrowShadowAccountAddress,
  borrowWithdrawCollateralActions,
  collateralValue,
  debtValue,
  isCollateralized,
  modifyPositionCalldata,
  repayAllBuffer,
  utilization,
  vesuDebt,
} from './borrow.js';
import type { BorrowAsset, BorrowMarket, BorrowPair, BorrowPosition } from './operations.js';
import { VAULT_DAPP_NAME, VAULT_MARKETS, VESU_PRIME_POOL, shadowAccountAddress } from './vault.js';

/**
 * D-083: the Borrow counter's pinned constants, Vesu's arithmetic, the
 * health figures, the refusals and the exact calls each flow proves.
 */

const [STRK, ETH, USDC, USDT, WBTC] = BORROW_TOKENS as [string, string, string, string, string];
const SHADOW = '0x2491aa0c7e14c1e3e2bb3d21f8a52d14aa6c1d6f0f3b2c6d0a1e5b7c9d91ac9';
const SHADOW_FELT = `0x${BigInt(SHADOW).toString(16)}`;
const PLAYER = '0xabc';
const E18 = 10n ** 18n;
const USDC_ONE = 10n ** 6n;
const STRK_USDC = { collateral: STRK, debt: USDC };
const ETH_USDC = { collateral: ETH, debt: USDC };

/** Live-shaped assets (Prime, block 15,725,569, rounded): Vesu's $10 floor, 0.95 utilization ceiling. */
function asset(token: string, price: bigint, decimals: number, overrides: Partial<BorrowAsset> = {}): BorrowAsset {
  const scale = 10n ** BigInt(decimals);
  return {
    token,
    price,
    priceValid: true,
    scale,
    floor: 10n * E18,
    reserve: 1_000_000n * scale,
    totalDebt: 1_000_000n * scale,
    maxUtilization: 950_000_000_000_000_000n,
    ...overrides,
  };
}

const ASSETS: BorrowAsset[] = [
  asset(STRK, 43_278_720_000_000_000n, 18, { reserve: 4_393_629n * E18, totalDebt: 9_496_271n * E18 }),
  asset(ETH, 2_686_650n * 10n ** 15n, 18),
  asset(USDC, 999_939_000_000_000_000n, 6),
  asset(USDT, 999_480_000_000_000_000n, 6),
  asset(WBTC, 83_579_759_432_340_000_000_000n, 8),
];

function pair(collateral: string, debt: string, maxLtv: bigint, overrides: Partial<BorrowPair> = {}): BorrowPair {
  return { collateral, debt, maxLtv, liquidationFactor: 900_000_000_000_000_000n, debtCap: 200_000n * USDC_ONE, totalDebt: 0n, ...overrides };
}

function market(overrides: { assets?: BorrowAsset[]; pairs?: BorrowPair[] } = {}): BorrowMarket {
  return {
    assets: overrides.assets ?? ASSETS,
    pairs: overrides.pairs ?? [pair(STRK, USDC, 680_000_000_000_000_000n), pair(ETH, USDC, 780_000_000_000_000_000n)],
  };
}

function position(collateralAmount: bigint, debtAmount: bigint): Pick<BorrowPosition, 'collateralShares' | 'nominalDebt' | 'collateralAmount' | 'debtAmount'> {
  return { collateralShares: collateralAmount, nominalDebt: debtAmount, collateralAmount, debtAmount };
}

function shadowInvoke(calls: unknown[], collect: unknown) {
  return { type: 'shadow_account_invoke', dapp_name: 'strkworld-borrow', nonce: '0x0', calls, collect_policy: collect };
}

describe('the pinned borrow surface (D-083)', () => {
  it('has its own dapp name at nonce 0, never the Vault\'s', () => {
    expect(BORROW_DAPP_NAME).toBe('strkworld-borrow');
    expect(BORROW_DAPP_NAME).not.toBe(VAULT_DAPP_NAME);
    expect(BORROW_SHADOW_NONCE).toBe('0x0');
    expect(BORROW_POOL).toBe(VESU_PRIME_POOL);
  });

  it('pins STRK, ETH, USDC, USDT and WBTC, each the Vault\'s own Prime market', () => {
    expect(BORROW_TOKEN_INFO.map((info) => info.symbol)).toEqual(['STRK', 'ETH', 'USDC', 'USDT', 'WBTC']);
    for (const info of BORROW_TOKEN_INFO) {
      const market = VAULT_MARKETS.find((entry) => BigInt(entry.token) === BigInt(info.token))!;
      expect(market.poolName).toBe('Prime');
      expect(BigInt(market.pool)).toBe(BigInt(VESU_PRIME_POOL));
      expect(info.decimals).toBe(market.decimals);
    }
  });

  it('pins all twenty ordered pairs, collateral-major, and refuses a pair of one token', () => {
    expect(BORROW_PAIRS).toHaveLength(20);
    expect(BORROW_PAIRS[0]).toEqual({ collateral: STRK, debt: ETH });
    expect(BORROW_PAIRS[3]).toEqual({ collateral: STRK, debt: WBTC });
    expect(BORROW_PAIRS[4]).toEqual({ collateral: ETH, debt: STRK });
    expect(new Set(BORROW_PAIRS.map((entry) => `${entry.collateral}:${entry.debt}`)).size).toBe(20);
    expect(borrowPairKey(STRK, STRK)).toBeUndefined();
    expect(borrowPairKey(STRK, '0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8')).toBeUndefined();
    expect(borrowPairKey(`0x${BigInt(STRK).toString(16)}`, USDC)).toBe(BORROW_PAIRS.find((entry) => entry.collateral === STRK && entry.debt === USDC));
  });

  it('derives the borrow stand-in at nonce 0 of its own commitment: a different address from the Vault\'s for another commitment', () => {
    const vaultPartial = '0x5f2e1d';
    const borrowPartial = '0x7a11';
    expect(borrowShadowAccountAddress(borrowPartial)).toBe(shadowAccountAddress(borrowPartial, '0x0'));
    expect(borrowShadowAccountAddress(borrowPartial)).not.toBe(shadowAccountAddress(vaultPartial));
  });

  it('pins modify_position by its selector', () => {
    expect(hash.getSelectorFromName('modify_position')).toBe('0x39b9c84d6a72745116ecdbd7f122af6d51a7183b6e764d621583713bcceb8cd');
  });
});

describe('modify_position calldata (D-083)', () => {
  // The live Prime pool class's own ABI entries for the struct, read with
  // starknet_getClassAt on 2026-10-01.
  const ABI = [
    { type: 'struct', name: 'core::integer::u256', members: [{ name: 'low', type: 'core::integer::u128' }, { name: 'high', type: 'core::integer::u128' }] },
    { type: 'enum', name: 'core::bool', variants: [{ name: 'False', type: '()' }, { name: 'True', type: '()' }] },
    { type: 'struct', name: 'alexandria_math::i257::i257', members: [{ name: 'abs', type: 'core::integer::u256' }, { name: 'is_negative', type: 'core::bool' }] },
    { type: 'enum', name: 'vesu::data_model::AmountDenomination', variants: [{ name: 'Native', type: '()' }, { name: 'Assets', type: '()' }] },
    { type: 'struct', name: 'vesu::data_model::Amount', members: [{ name: 'denomination', type: 'vesu::data_model::AmountDenomination' }, { name: 'value', type: 'alexandria_math::i257::i257' }] },
    {
      type: 'struct',
      name: 'vesu::data_model::ModifyPositionParams',
      members: [
        { name: 'collateral_asset', type: 'core::starknet::contract_address::ContractAddress' },
        { name: 'debt_asset', type: 'core::starknet::contract_address::ContractAddress' },
        { name: 'user', type: 'core::starknet::contract_address::ContractAddress' },
        { name: 'collateral', type: 'vesu::data_model::Amount' },
        { name: 'debt', type: 'vesu::data_model::Amount' },
      ],
    },
    {
      type: 'interface',
      name: 'vesu::pool::IPool',
      items: [{
        type: 'function',
        name: 'modify_position',
        inputs: [{ name: 'params', type: 'vesu::data_model::ModifyPositionParams' }],
        outputs: [],
        state_mutability: 'external',
      }],
    },
  ];
  const denomination = (name: 'Native' | 'Assets') => new CairoCustomEnum({ Native: name === 'Native' ? {} : undefined, Assets: name === 'Assets' ? {} : undefined });

  it.each([
    ['supply and borrow in assets', { denomination: 'assets', value: 5n * E18 }, { denomination: 'assets', value: 100n * USDC_ONE }],
    ['repay all in native', { denomination: 'native', value: 0n }, { denomination: 'native', value: -(123_456_789n * E18) }],
    ['withdraw in assets', { denomination: 'assets', value: -(1n << 130n) }, { denomination: 'native', value: 0n }],
  ] as const)('serializes %s exactly as starknet.js does from the ABI', (_label, collateral, debt) => {
    const ours = modifyPositionCalldata({ collateral: STRK, debt: USDC, user: SHADOW, collateralAmount: collateral, debtAmount: debt });
    const amount = (entry: { denomination: 'native' | 'assets'; value: bigint }) => ({
      denomination: denomination(entry.denomination === 'native' ? 'Native' : 'Assets'),
      value: { abs: entry.value < 0n ? -entry.value : entry.value, is_negative: entry.value < 0n },
    });
    const theirs = new CallData(ABI).compile('modify_position', {
      params: { collateral_asset: STRK, debt_asset: USDC, user: SHADOW, collateral: amount(collateral), debt: amount(debt) },
    });
    expect(ours.map((felt) => BigInt(felt))).toEqual(theirs.map((felt) => BigInt(felt)));
    expect(ours).toHaveLength(11);
  });

  it('never marks zero negative', () => {
    expect(modifyPositionCalldata({ collateral: STRK, debt: USDC, user: SHADOW, collateralAmount: { denomination: 'native', value: 0n }, debtAmount: { denomination: 'assets', value: 1n } }).slice(3, 7))
      .toEqual(['0x0', '0x0', '0x0', '0x0']);
  });
});

describe('the four flows, call for call (D-083)', () => {
  const modify = (calldata: string[]) => ({ contractAddress: VESU_PRIME_POOL, entrypoint: 'modify_position', calldata });
  const approve = (token: string, amount: bigint) => ({ contractAddress: token, entrypoint: 'approve', calldata: [VESU_PRIME_POOL, `0x${amount.toString(16)}`, '0x0'] });
  const params = (collateral: [string, bigint, boolean], debt: [string, bigint, boolean], c = STRK, d = USDC) => [
    `0x${BigInt(c).toString(16)}`,
    `0x${BigInt(d).toString(16)}`,
    SHADOW_FELT,
    collateral[0], `0x${collateral[1].toString(16)}`, '0x0', collateral[2] ? '0x1' : '0x0',
    debt[0], `0x${debt[1].toString(16)}`, '0x0', debt[2] ? '0x1' : '0x0',
  ];

  it('opens a loan: collateral out to the account, one debt note, approve and one modify_position, diff', () => {
    const actions = borrowOpenActions({ pair: STRK_USDC, shadowAccount: SHADOW, player: PLAYER, collateralAmount: 5000n * E18, borrowAmount: 100n * USDC_ONE });
    expect(actions).toEqual([
      { type: 'withdraw', token: STRK, amount: `0x${(5000n * E18).toString(16)}`, recipient: SHADOW_FELT },
      { type: 'transfer', token: USDC, amount: 'OPEN', recipient: PLAYER },
      shadowInvoke([
        approve(STRK, 5000n * E18),
        modify(params(['0x1', 5000n * E18, false], ['0x1', 100n * USDC_ONE, false])),
      ], { type: 'diff' }),
    ]);
  });

  it('borrows more against what is already there: no withdraw leg and no approve', () => {
    const actions = borrowOpenActions({ pair: STRK_USDC, shadowAccount: SHADOW, player: PLAYER, collateralAmount: 0n, borrowAmount: 7n * USDC_ONE });
    expect(actions).toEqual([
      { type: 'transfer', token: USDC, amount: 'OPEN', recipient: PLAYER },
      shadowInvoke([modify(params(['0x1', 0n, false], ['0x1', 7n * USDC_ONE, false]))], { type: 'diff' }),
    ]);
  });

  it('adds collateral: withdraw, approve, modify_position with the debt untouched (native 0), collect nothing', () => {
    expect(borrowAddCollateralActions({ pair: ETH_USDC, shadowAccount: SHADOW, amount: E18 })).toEqual([
      { type: 'withdraw', token: ETH, amount: `0x${E18.toString(16)}`, recipient: SHADOW_FELT },
      shadowInvoke([
        approve(ETH, E18),
        modify(params(['0x1', E18, false], ['0x0', 0n, false], ETH, USDC)),
      ], { type: 'exact', amount: '0x0' }),
    ]);
  });

  it('repays part: exactly that many units out, approve, a negative assets debt, collect nothing', () => {
    expect(borrowRepayActions({ pair: STRK_USDC, shadowAccount: SHADOW, player: PLAYER, repay: { amount: 40n * USDC_ONE } })).toEqual([
      { type: 'withdraw', token: USDC, amount: `0x${(40n * USDC_ONE).toString(16)}`, recipient: SHADOW_FELT },
      shadowInvoke([
        approve(USDC, 40n * USDC_ONE),
        modify(params(['0x0', 0n, false], ['0x1', 40n * USDC_ONE, true])),
      ], { type: 'exact', amount: '0x0' }),
    ]);
  });

  it('repays all: debt plus buffer out, approve that, the whole nominal debt in native, and the unused buffer back to a note (all)', () => {
    const nominal = 99_871_234_567_890_123_456_789n;
    expect(borrowRepayActions({ pair: STRK_USDC, shadowAccount: SHADOW, player: PLAYER, repay: { nominalDebt: nominal, withdraw: 100_102_000n } })).toEqual([
      { type: 'withdraw', token: USDC, amount: `0x${(100_102_000n).toString(16)}`, recipient: SHADOW_FELT },
      { type: 'transfer', token: USDC, amount: 'OPEN', recipient: PLAYER },
      shadowInvoke([
        approve(USDC, 100_102_000n),
        modify(params(['0x0', 0n, false], ['0x0', nominal, true])),
      ], { type: 'all' }),
    ]);
  });

  it('withdraws collateral: one collateral note, a negative assets collateral, no approve, diff', () => {
    expect(borrowWithdrawCollateralActions({ pair: STRK_USDC, shadowAccount: SHADOW, player: PLAYER, withdraw: { amount: 250n * E18 } })).toEqual([
      { type: 'transfer', token: STRK, amount: 'OPEN', recipient: PLAYER },
      shadowInvoke([modify(params(['0x1', 250n * E18, true], ['0x0', 0n, false]))], { type: 'diff' }),
    ]);
  });

  it('withdraws all the collateral by every share, in native', () => {
    expect(borrowWithdrawCollateralActions({ pair: STRK_USDC, shadowAccount: SHADOW, player: PLAYER, withdraw: { collateralShares: 4_990n * E18 } })[1])
      .toEqual(shadowInvoke([modify(params(['0x0', 4_990n * E18, true], ['0x0', 0n, false]))], { type: 'diff' }));
  });

  it('refuses an unpinned pair, a bad address and a bad amount', () => {
    expect(() => borrowOpenActions({ pair: { collateral: STRK, debt: STRK }, shadowAccount: SHADOW, player: PLAYER, collateralAmount: 1n, borrowAmount: 1n })).toThrow('Invalid borrow pair.');
    expect(() => borrowAddCollateralActions({ pair: STRK_USDC, shadowAccount: '0x0', amount: 1n })).toThrow('Invalid borrow address.');
    expect(() => borrowAddCollateralActions({ pair: STRK_USDC, shadowAccount: SHADOW, amount: 0n })).toThrow('Invalid borrow amount.');
    expect(() => borrowOpenActions({ pair: STRK_USDC, shadowAccount: SHADOW, player: PLAYER, collateralAmount: -1n, borrowAmount: 1n })).toThrow('Invalid borrow amount.');
  });
});

describe("Vesu's arithmetic (D-083)", () => {
  it('values collateral down and debt up, as Vesu does', () => {
    const usdc = ASSETS[2]!;
    expect(collateralValue(1n, usdc)).toBe(999_939_000_000n);
    expect(debtValue(1n, { price: 3n, scale: 2n })).toBe(2n);
    expect(collateralValue(1n, { price: 3n, scale: 2n })).toBe(1n);
  });

  it('converts nominal debt at the rate accumulator, rounding as asked', () => {
    expect(vesuDebt(10n * E18, 2n * E18, 10n ** 6n, false)).toBe(20n * 10n ** 6n);
    expect(vesuDebt(1n, E18 + 1n, 10n ** 6n, true)).toBe(1n);
    expect(vesuDebt(1n, E18 + 1n, 10n ** 6n, false)).toBe(0n);
    expect(vesuDebt(5n, 0n, 10n ** 6n, true)).toBe(0n);
  });

  it('measures utilization and collateralisation by Vesu\'s formulas', () => {
    expect(utilization(0n, 0n)).toBe(0n);
    expect(utilization(50n, 50n)).toBe(E18 / 2n);
    expect(isCollateralized(100n * E18, 68n * E18, 680_000_000_000_000_000n)).toBe(true);
    expect(isCollateralized(100n * E18, 68n * E18 + 1n, 680_000_000_000_000_000n)).toBe(false);
    // Vesu: with no debt a position is collateralised even at a zero max LTV.
    expect(isCollateralized(0n, 0n, 0n)).toBe(true);
  });

  it('buffers a repay-all by 0.1% and two units', () => {
    expect(repayAllBuffer(100_000_000n)).toBe(100_002n);
    expect(repayAllBuffer(1n)).toBe(3n);
    expect(repayAllBuffer(0n)).toBe(2n);
  });

  it('offers a pair only with a max LTV and a debt cap above zero', () => {
    expect(borrowPairOffered({ maxLtv: 1n, debtCap: 1n })).toBe(true);
    expect(borrowPairOffered({ maxLtv: 0n, debtCap: 1n })).toBe(false);
    // Vesu reads a zero cap as uncapped; the counter reads it as not ramped (D-083).
    expect(borrowPairOffered({ maxLtv: 1n, debtCap: 0n })).toBe(false);
  });
});

describe('health (D-083)', () => {
  const strk = ASSETS[0]!;
  const usdc = ASSETS[2]!;
  const maxLtv = 680_000_000_000_000_000n;

  it('reads no debt as nothing to liquidate', () => {
    const health = borrowHealth({ collateralAmount: 1000n * E18, debtAmount: 0n, collateral: strk, debt: usdc, maxLtv });
    expect(health).toEqual({
      status: 'no-debt',
      collateralValue: 43_278_720_000_000_000_000n,
      debtValue: 0n,
      ltv: null,
      maxLtv,
      healthFactor: null,
      liquidationPrice: null,
      band: 'none',
    });
  });

  it('gives LTV, health and the liquidation price of a priced loan', () => {
    // 10,000 STRK at $0.04327872 is $432.7872; 100 USDC owed at $0.999939 is $99.9939.
    const health = borrowHealth({ collateralAmount: 10_000n * E18, debtAmount: 100n * USDC_ONE, collateral: strk, debt: usdc, maxLtv });
    expect(health.status).toBe('priced');
    expect(health.collateralValue).toBe(432_787_200_000_000_000_000n);
    expect(health.debtValue).toBe(99_993_900_000_000_000_000n);
    expect(health.ltv).toBe(231_046_343_329_932_124n); // ~23.1%
    expect(health.healthFactor).toBe(2_943_132_491_081_955_999n); // ~2.94
    // Liquidatable when 10,000 STRK × P × 0.68 < $99.9939: P ≈ $0.01470499.
    expect(health.liquidationPrice).toBe(14_704_985_294_117_648n);
    expect(health.band).toBe('safe');
    // At that price, Vesu's own rule flips.
    const at = { ...strk, price: health.liquidationPrice! };
    const below = { ...strk, price: health.liquidationPrice! - 1n };
    expect(isCollateralized(collateralValue(10_000n * E18, at), health.debtValue, maxLtv)).toBe(true);
    expect(isCollateralized(collateralValue(10_000n * E18, below), health.debtValue, maxLtv)).toBe(false);
  });

  it('puts a loan near liquidation in the warning band, and one past it in liquidatable', () => {
    const near = borrowHealth({ collateralAmount: 10_000n * E18, debtAmount: 270n * USDC_ONE, collateral: strk, debt: usdc, maxLtv });
    expect(near.healthFactor! < BORROW_WARNING_HEALTH && near.healthFactor! >= VESU_SCALE).toBe(true);
    expect(near.band).toBe('warning');
    const past = borrowHealth({ collateralAmount: 10_000n * E18, debtAmount: 300n * USDC_ONE, collateral: strk, debt: usdc, maxLtv });
    expect(past.healthFactor! < VESU_SCALE).toBe(true);
    expect(past.band).toBe('liquidatable');
  });

  it('shows no figure at all with a stale price on either side', () => {
    for (const [collateral, debt] of [[{ ...strk, priceValid: false }, usdc], [strk, { ...usdc, priceValid: false }]] as const) {
      expect(borrowHealth({ collateralAmount: 10_000n * E18, debtAmount: 100n * USDC_ONE, collateral, debt, maxLtv })).toEqual({
        status: 'stale-price',
        collateralValue: 0n,
        debtValue: 0n,
        ltv: null,
        maxLtv,
        healthFactor: null,
        liquidationPrice: null,
        band: 'unknown',
      });
    }
  });

  it('reads debt with no collateral as liquidatable, with no LTV or liquidation price', () => {
    const health = borrowHealth({ collateralAmount: 0n, debtAmount: 1n, collateral: strk, debt: usdc, maxLtv });
    expect(health).toMatchObject({ status: 'priced', ltv: null, healthFactor: 0n, liquidationPrice: null, band: 'liquidatable' });
  });
});

describe('assessing an action before the wallet is asked (D-083)', () => {
  it('accepts an open within the max LTV and states its health after', () => {
    const assessed = assessBorrow({ kind: 'borrow', ...STRK_USDC, collateralAmount: 10_000n * E18, borrowAmount: 100n * USDC_ONE }, market(), undefined);
    expect(assessed).toMatchObject({ ok: true, fromPool: 10_000n * E18, buffer: 0n, collateralAfter: 10_000n * E18, debtAfter: 100n * USDC_ONE + 1n });
    expect(assessed.ok && assessed.after.band).toBe('safe');
  });

  it('refuses a max LTV breach, counting a base unit more debt', () => {
    // $432.7872 × 0.68 = $294.295296, which at $0.999939 a USDC is 294.313249… USDC,
    // less the base unit counted for Vesu's rounding.
    const limit = 294_313_248n;
    expect(assessBorrow({ kind: 'borrow', ...STRK_USDC, collateralAmount: 10_000n * E18, borrowAmount: limit + 1n }, market(), undefined))
      .toEqual({ ok: false, reason: 'above-max-ltv' });
    // At the limit itself Vesu would accept, but health would be 1.00: too close to send.
    expect(assessBorrow({ kind: 'borrow', ...STRK_USDC, collateralAmount: 10_000n * E18, borrowAmount: limit }, market(), undefined))
      .toEqual({ ok: false, reason: 'too-close-to-liquidation' });
  });

  it('keeps a margin on actions that add risk: health after must be at least 1.05 (review fix)', () => {
    expect(BORROW_MIN_HEALTH_AFTER).toBe(1_050_000_000_000_000_000n);
    // $294.295296 / 1.05 = $280.281234…, at $0.999939 a USDC 280.298… USDC, less a base unit.
    const margin = 280_298_331n;
    const ok = assessBorrow({ kind: 'borrow', ...STRK_USDC, collateralAmount: 10_000n * E18, borrowAmount: margin }, market(), undefined);
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.after.healthFactor! >= BORROW_MIN_HEALTH_AFTER).toBe(true);
    expect(assessBorrow({ kind: 'borrow', ...STRK_USDC, collateralAmount: 10_000n * E18, borrowAmount: margin + 1n }, market(), undefined))
      .toEqual({ ok: false, reason: 'too-close-to-liquidation' });
    // A withdrawal is held to it too: $99.9939 needs $157.40 of STRK at 0.68 × 1.05, about 3,567.6 STRK.
    const held = position(10_000n * E18, 100n * USDC_ONE);
    expect(assessBorrow({ kind: 'withdraw-collateral', ...STRK_USDC, amount: 6_432n * E18 }, market(), held).ok).toBe(true);
    expect(assessBorrow({ kind: 'withdraw-collateral', ...STRK_USDC, amount: 6_433n * E18 }, market(), held))
      .toEqual({ ok: false, reason: 'too-close-to-liquidation' });
    // Repaying and adding collateral only raise health: never held to the margin, even at 1.01.
    const thin = position(10_000n * E18, 290n * USDC_ONE);
    expect(assessBorrow({ kind: 'repay', ...STRK_USDC, amount: USDC_ONE }, market(), thin).ok).toBe(true);
    expect(assessBorrow({ kind: 'add-collateral', ...STRK_USDC, amount: E18 }, market(), thin).ok).toBe(true);
  });

  it('refuses everything on a pair with a stale price, repay included', () => {
    const stale = market({ assets: ASSETS.map((entry) => (entry.token === USDC ? { ...entry, priceValid: false } : entry)) });
    for (const request of [
      { kind: 'borrow', ...STRK_USDC, collateralAmount: 1n, borrowAmount: 1n },
      { kind: 'repay', ...STRK_USDC, amount: 'all' },
      { kind: 'add-collateral', ...STRK_USDC, amount: 1n },
      { kind: 'withdraw-collateral', ...STRK_USDC, amount: 1n },
    ] as const) {
      expect(assessBorrow(request, stale, position(10_000n * E18, 100n * USDC_ONE))).toEqual({ ok: false, reason: 'stale-price' });
    }
  });

  it('refuses new debt in a pair not offered, but lets its loan be repaid and topped up', () => {
    const notOffered = market({ pairs: [pair(ETH, USDC, 780_000_000_000_000_000n)] });
    const held = position(10_000n * E18, 100n * USDC_ONE);
    expect(assessBorrow({ kind: 'borrow', ...STRK_USDC, collateralAmount: 0n, borrowAmount: 1n }, notOffered, held)).toEqual({ ok: false, reason: 'pair-not-offered' });
    expect(assessBorrow({ kind: 'repay', ...STRK_USDC, amount: 'all' }, notOffered, held).ok).toBe(true);
    expect(assessBorrow({ kind: 'add-collateral', ...STRK_USDC, amount: E18 }, notOffered, held).ok).toBe(true);
    // Without its max LTV, withdrawing collateral with debt is refused.
    expect(assessBorrow({ kind: 'withdraw-collateral', ...STRK_USDC, amount: E18 }, notOffered, held)).toEqual({ ok: false, reason: 'above-max-ltv' });
  });

  it('measures a loan in a pair no longer offered by the max LTV the caller read (review fix)', () => {
    const notOffered = market({ pairs: [pair(ETH, USDC, 780_000_000_000_000_000n)] });
    const held = position(10_000n * E18, 100n * USDC_ONE);
    const maxLtv = 680_000_000_000_000_000n;
    // An improving action reads healthy, not liquidatable.
    const repaid = assessBorrow({ kind: 'repay', ...STRK_USDC, amount: 50n * USDC_ONE }, notOffered, held, maxLtv);
    expect(repaid.ok && repaid.after).toMatchObject({ status: 'priced', band: 'safe', maxLtv });
    const added = assessBorrow({ kind: 'add-collateral', ...STRK_USDC, amount: E18 }, notOffered, held, maxLtv);
    expect(added.ok && added.after.band).toBe('safe');
    // A partial withdrawal within the margin passes; new debt still does not.
    expect(assessBorrow({ kind: 'withdraw-collateral', ...STRK_USDC, amount: E18 }, notOffered, held, maxLtv).ok).toBe(true);
    expect(assessBorrow({ kind: 'borrow', ...STRK_USDC, collateralAmount: 0n, borrowAmount: 20n * USDC_ONE }, notOffered, held, maxLtv))
      .toEqual({ ok: false, reason: 'pair-not-offered' });
  });

  it('refuses a debt at or under Vesu\'s floor, and a partial repay that would leave one', () => {
    expect(assessBorrow({ kind: 'borrow', ...STRK_USDC, collateralAmount: 10_000n * E18, borrowAmount: 9n * USDC_ONE }, market(), undefined))
      .toEqual({ ok: false, reason: 'debt-below-floor' });
    const held = position(10_000n * E18, 100n * USDC_ONE);
    expect(assessBorrow({ kind: 'repay', ...STRK_USDC, amount: 95n * USDC_ONE }, market(), held)).toEqual({ ok: false, reason: 'debt-below-floor' });
    expect(assessBorrow({ kind: 'repay', ...STRK_USDC, amount: 50n * USDC_ONE }, market(), held)).toMatchObject({ ok: true, fromPool: 50n * USDC_ONE, debtAfter: 50n * USDC_ONE });
  });

  it('refuses the debt cap and the utilization ceiling', () => {
    const capped = market({ pairs: [pair(STRK, USDC, 680_000_000_000_000_000n, { debtCap: 1000n * USDC_ONE, totalDebt: 950n * USDC_ONE })] });
    expect(assessBorrow({ kind: 'borrow', ...STRK_USDC, collateralAmount: 10_000n * E18, borrowAmount: 50n * USDC_ONE }, capped, undefined))
      .toEqual({ ok: false, reason: 'debt-cap' });
    const tight = market({ assets: ASSETS.map((entry) => (entry.token === USDC ? { ...entry, reserve: 60n * USDC_ONE, totalDebt: 940n * USDC_ONE } : entry)) });
    expect(assessBorrow({ kind: 'borrow', ...STRK_USDC, collateralAmount: 10_000n * E18, borrowAmount: 50n * USDC_ONE }, tight, undefined))
      .toEqual({ ok: false, reason: 'utilization' });
  });

  it('repays all with the buffer, and refuses a partial repay of the whole debt or a repay of nothing', () => {
    const held = position(10_000n * E18, 100n * USDC_ONE);
    const all = assessBorrow({ kind: 'repay', ...STRK_USDC, amount: 'all' }, market(), held);
    expect(all).toMatchObject({ ok: true, fromPool: 100n * USDC_ONE + 100_002n, buffer: 100_002n, debtAfter: 0n });
    expect(all.ok && all.after.status).toBe('no-debt');
    expect(assessBorrow({ kind: 'repay', ...STRK_USDC, amount: 100n * USDC_ONE }, market(), held)).toEqual({ ok: false, reason: 'repay-exceeds-debt' });
    expect(assessBorrow({ kind: 'repay', ...STRK_USDC, amount: 'all' }, market(), position(5n, 0n))).toEqual({ ok: false, reason: 'nothing-to-repay' });
  });

  it('blocks a withdrawal that would breach the max LTV, and all of the collateral while debt remains', () => {
    const held = position(10_000n * E18, 100n * USDC_ONE);
    // $99.9939 needs $147.0498 of collateral at 0.68: 3,397.75… STRK.
    expect(assessBorrow({ kind: 'withdraw-collateral', ...STRK_USDC, amount: 6_300n * E18 }, market(), held).ok).toBe(true);
    expect(assessBorrow({ kind: 'withdraw-collateral', ...STRK_USDC, amount: 6_610n * E18 }, market(), held)).toEqual({ ok: false, reason: 'above-max-ltv' });
    expect(assessBorrow({ kind: 'withdraw-collateral', ...STRK_USDC, amount: 'all' }, market(), held)).toEqual({ ok: false, reason: 'withdraw-all-with-debt' });
    expect(assessBorrow({ kind: 'withdraw-collateral', ...STRK_USDC, amount: 10_001n * E18 }, market(), held)).toEqual({ ok: false, reason: 'withdraw-exceeds-collateral' });
    expect(assessBorrow({ kind: 'withdraw-collateral', ...STRK_USDC, amount: 'all' }, market(), position(10_000n * E18, 0n))).toMatchObject({ ok: true, collateralAfter: 0n });
  });

  it('refuses bad amounts and unknown pairs', () => {
    expect(assessBorrow({ kind: 'borrow', ...STRK_USDC, collateralAmount: 0n, borrowAmount: 0n }, market(), undefined)).toEqual({ ok: false, reason: 'amount' });
    expect(assessBorrow({ kind: 'add-collateral', collateral: STRK, debt: STRK, amount: 1n }, market(), undefined)).toEqual({ ok: false, reason: 'unknown-pair' });
  });

  it('carries the refusal on a PrivacyError of kind unknown', () => {
    const error = new BorrowRefusedError('above-max-ltv', 'message');
    expect(error.kind).toBe('unknown');
    expect(error.refusal).toBe('above-max-ltv');
  });
});
