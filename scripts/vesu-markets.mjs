#!/usr/bin/env node
/**
 * The Vault's pinned Vesu markets (D-081): derive them, verify them on
 * mainnet, and render the one list the three packages pin.
 *
 *   node scripts/vesu-markets.mjs           re-derive and re-verify, and fail
 *                                           on any drift from the committed list
 *   node scripts/vesu-markets.mjs --write   regenerate the committed list and
 *                                           its three copies
 *
 * Environment: STARKNET_RPC_URL (default Cartridge's public mainnet RPC) and
 * VESU_API_URL (default https://api.vesu.xyz). Both are read-only: nothing
 * here signs, writes to the chain, or needs a key.
 *
 * WHY THE LIST IS PINNED. The Vault sends a player's funds to the vault a
 * market names, so the list is code, reviewed in a diff, never read at run
 * time. Vesu's API only proposes: a market is written out only when mainnet
 * itself agrees with every address in it (the checks in `verifyCandidate`),
 * through contracts this file pins, and only into a pool this file approves
 * by address. A compromised API can make this script fail or propose a diff;
 * it can never move a pinned vault without a human committing the change.
 *
 * THE POLICY, in order, for every asset of a live Vesu V2 pool that Vesu
 * marks verified:
 *
 *   1. Group it (`POLICY.groups`). An asset in no group is skipped as
 *      `unclassified`: a new Vesu asset waits for a human to place it.
 *   2. Choose one vault: Prime's, if Prime lists it; else Re7 xBTC's, the
 *      BTC-focused pool the lead chose for strkBTC on 2026-09-30, if it lists
 *      it; else the only pool that lists it; else the pool `POLICY.choices`
 *      names, with its reason. The chosen pool must be one `POLICY.pools`
 *      approves by address, or the asset is skipped as `no-pool`.
 *   3. Verify it on mainnet. A failed check skips the asset with the check's
 *      name, so a broken market is reported, never pinned.
 *   4. Admit it only if the STRK20 pool has ever credited the token to a note
 *      (a `Deposit` or `OpenNoteDeposited` event naming it): the evidence that
 *      it can sit in a private balance. The pool is token-agnostic, so the rest
 *      are skipped as `never-held`, and a later run admits each one once
 *      someone has held it privately.
 *
 * The output is deterministic for a given API answer and chain state, and
 * holds nothing that moves between runs (no rates, no block numbers), so a
 * check with no real change passes.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_RPC_URL = 'https://api.cartridge.gg/x/starknet/mainnet';
export const DEFAULT_VESU_API_URL = 'https://api.vesu.xyz';

/** The canonical STRK20 pool on mainnet, and the first block it exists at. */
export const STRK20_POOL = '0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a';
export const STRK20_POOL_FIRST_BLOCK = 8_978_970;

/**
 * Vesu V2's official PoolFactory (docs.vesu.xyz/developers/contract-addresses).
 * It maps (pool, asset) to the pool's vToken and back; a vault that is not the
 * factory's own for its pool and token is never pinned.
 */
export const VESU_POOL_FACTORY = '0x03760f903a37948f97302736f89ce30290e45f441559325026842b7a6fb388c0';

/**
 * The vToken class every vault the Vault has pinned runs, and the factory's own
 * `v_token_class_hash()` (D-079). A vault of another class is pinned only when
 * its ABI has every entry point the action builders call, in their shapes.
 */
export const VESU_VTOKEN_CLASS_HASH = '0x41b16e0ca0565a58d1379ffc3c7eab7459b382ba8f8208b3b87d18d2aed4f78';

/** The decision this list is recorded under; the generated files cite it. */
export const DECISION = 'D-081';

/** A Vault allowlist's ceiling (D-081): more markets than this is a mistake, not a policy. */
export const MAX_MARKETS = 48;

/** `sn_keccak` of each entry point and event read here; scripts/vesu-markets.test.mjs pins every one. */
export const SELECTORS = Object.freeze({
  asset: '0x3d4060688a1800ae986e4840aebc924bb40b5bf44de4583df2257220b54b77c',
  pool_contract: '0x34044f090cf33c19084c37ddd543c545514cfdce73d9c2b6a2347a8b8e1a22c',
  decimals: '0x4c4fb1ab068f6039d5780c68dd0fa2f8742cceb3426d19667778ca7f3518a9',
  symbol: '0x216b05c387bab9ac31918a3e61672f4618601f3c598a2f3f2710f37053e1ea4',
  v_token_for_asset: '0x1af1863f84c6038664ebb45064ad3e4a459b237acc8df4acfbf8fcd52010b92',
  asset_for_v_token: '0x1464e0fda425108d477d517c97c3c862de1f58a66c67fe10d908f80470eb792',
  pool_name: '0x370b5b871d074a164a9ae326d3e13e8721ff31af01f4148f6b3073c19f33ede',
  is_paused: '0x238d7ea31550fece8f0a8a601e3ae1a7c59cb3b6cc976ceb721e31ebd9c36f9',
  Deposit: '0x9149d2123147c5f43d258257fef0b7b969db78269369ebcf5ebb9eef8592f2',
  OpenNoteDeposited: '0x25b6da03c4858d11cb0708d5cb6be79b190fb32eb7a7ce83804e07cbbb9bead',
});

const T = Object.freeze({
  STRK: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
  ETH: '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7',
  USDC: '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb',
  USDT: '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8',
  USDC_E: '0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8',
  SUSN: '0x02411565ef1a14decfbe83d2e987cced918cd752508a3d9c55deb67148d14d17',
  MRE7YIELD: '0x04be8945e61dc3e19ebadd1579a6bd53b262f51ba89e6f8b0c4bc9a7e3c633fc',
  WBTC: '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac',
  STRKBTC: '0x0787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135',
  TBTC: '0x04daa17763b286d1e59b97c283c0b8c949994c361e426a28f743c67bdfe9a32f',
  SOLVBTC: '0x0593e034dda23eea82d2ba9a30960ed42cf4a01502cc2351dc9b9881f9931a68',
  UNIBTC: '0x023a312ece4a275e38c9fc169e3be7b5613a0cb55fe1bece4422b09a88434573',
  YBTC_B: '0x02cab84694e1be6af2ce65b1ae28a76009e8ec99ec4bc17047386abf20cbb688',
  MRE7BTC: '0x04e4fb1a9ca7e84bae609b9dc0078ad7719e49187ae7e425bb47d131710eddac',
  XSTRK: '0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a',
  WSTETH: '0x0057912720381af14b0e5c87aa4718ed5e527eab60b3801ebf702ab09139e38b',
  XWBTC: '0x06a567e68c805323525fe1649adb80b03cddf92c23d2629a6779f54192dffc13',
  XSTRKBTC: '0x047751b3532fabca89b0f2e35ca1cb45e5a7b11d5e3d3663dfa1f4406b45fd88',
  XTBTC: '0x043a35c1425a0125ef8c171f1a75c6f31ef8648edcc8324b55ce1917db3f9b91',
  LBTC: '0x036834a40984312f7f7de8d31e3f6305b325389eaeea5b1c0664b2fb936461a4',
  XLBTC: '0x07dd3c80de9fcc5545f0cb83678826819c79619ed7992cc06ff81fc67cd2efe0',
  XSBTC: '0x0580f3dc564a7b82f21d40d404b3842d490ae7205e6ac07b1b7af2b4a5183dc9',
  EKUBO: '0x075afe6402ad5a5c20dd25e10ec3b3986acaa647b77e4ae24b0cbc9a54a27a87',
});

const PRIME = '0x0451fe483d5921a2919ddd81d0de6696669bccdacd859f72a4fba7656b97c3b5';
const RE7_XBTC = '0x03a8416bf20d036df5b1cf3447630a2e1cb04685f6b0c3a70ed7fb1473548ecf';
const RE7_ECOSYSTEM = '0x0486294fe74daf3d964523e7a1f4e5d686f153934b2c183ececa0cab9dd2f3e6';
const RE7_USDC_STABLE_CORE = '0x073702fce24aba36da1eac539bd4bae62d4d6a76747b7cdd3e016da754d7a135';
const RE7_USDC_CORE = '0x03976cac265a12609934089004df458ea29c776d77da423c96dc761d09d24124';
const RE7_USDC_FRONTIER = '0x05c03e7e0ccfe79c634782388eb1e6ed4e8e2a013ab0fcc055140805e46261bd';

/**
 * Every human decision the list rests on, in one place. Changing any of it is
 * a reviewed change to this file, and the generated list shows its effect.
 */
export const POLICY = deepFreeze({
  prime: PRIME,
  /**
   * The lead named Re7 xBTC for strkBTC (2026-09-30). It is Vesu's BTC-focused
   * pool: every pair in it lends a BTC token against BTC collateral. Every
   * other BTC asset Prime does not list goes to it too, so a player's non-Prime
   * BTC positions share one curator's risk settings.
   */
  btc: RE7_XBTC,
  /**
   * The pools a market may name, approved by address, with the name the pool
   * contract itself reports (`pool_name()`, trimmed) and whether it is Vesu's
   * Prime pool or a pool run by a third-party curator. Each is a verified V2
   * pool created by the PoolFactory; the five Re7 ones share one curator
   * (`curator()` 0x1c89…ce59 on every one).
   */
  pools: {
    [PRIME]: { poolName: 'Prime', curation: 'prime' },
    [RE7_XBTC]: { poolName: 'Re7 xBTC', curation: 'curated' },
    [RE7_ECOSYSTEM]: { poolName: 'Re7 Labs Starknet Ecosystem', curation: 'curated' },
    [RE7_USDC_STABLE_CORE]: { poolName: 'Re7 USDC Stable Core', curation: 'curated' },
    [RE7_USDC_CORE]: { poolName: 'Re7 USDC Core', curation: 'curated' },
    [RE7_USDC_FRONTIER]: { poolName: 'Re7 USDC Frontier', curation: 'curated' },
  },
  /**
   * Assets that neither Prime nor Re7 xBTC lists and that more than one pool
   * does: the choice, and why.
   */
  choices: {
    [T.SUSN]: {
      pool: RE7_USDC_STABLE_CORE,
      why: 'Clearstar USDC Reactor and Re7 USDC Stable Core both list sUSN as collateral only. Stable Core lends only USDC and USDC.e, against stable collateral, and holds more sUSN through its vault; the Reactor also lends WBTC, tBTC and strkBTC.',
    },
  },
  /**
   * The counter's groups, in order, and each group's tokens in order. Every
   * asset Vesu lists is placed, held privately or not, so a later run only
   * admits; a new asset is `unclassified` until it is placed here.
   */
  groups: [
    { group: 'majors', tokens: [T.STRK, T.ETH] },
    { group: 'stables', tokens: [T.USDC, T.USDT, T.USDC_E, T.SUSN, T.MRE7YIELD] },
    { group: 'btc', tokens: [T.WBTC, T.STRKBTC, T.TBTC, T.SOLVBTC, T.UNIBTC, T.YBTC_B, T.MRE7BTC] },
    { group: 'staking', tokens: [T.XSTRK, T.WSTETH, T.XWBTC, T.XSTRKBTC, T.XTBTC, T.LBTC, T.XLBTC, T.XSBTC] },
    { group: 'ecosystem', tokens: [T.EKUBO] },
  ],
  /**
   * Display symbols that differ from the token's own `symbol()`, and why. The
   * rest show exactly what their contract reports.
   */
  symbols: {
    [T.USDC_E]: {
      symbol: 'USDC.e',
      onChain: 'USDC',
      why: "Its contract's symbol() is USDC, the same as Circle's native USDC; Vesu and avnu call the bridged token USDC.e.",
    },
  },
});

// ---------------------------------------------------------------------------
// Selection: which vault each asset would use, from Vesu's pool list
// ---------------------------------------------------------------------------

/**
 * Vesu's pools that can hold a market: V2, not deprecated, verified by Vesu,
 * and neither paused nor shut down in Vesu's own answer.
 */
export function eligiblePools(pools) {
  if (!Array.isArray(pools)) throw new Error("Vesu's pool list is not a list.");
  return pools.filter((pool) => pool && typeof pool === 'object'
    && pool.protocolVersion === 'v2'
    && pool.isDeprecated === false
    && pool.isVerified === true
    && pool.isPaused !== true
    && (pool.shutdownConfig === null || pool.shutdownConfig === undefined)
    && isAddress(pool.id)
    && Array.isArray(pool.assets));
}

/**
 * Every eligible asset, grouped and matched to a vault by the policy, in the
 * policy's order: `{ candidates, skipped }`. Pure: no network.
 */
export function selectCandidates(pools, policy = POLICY) {
  const eligible = eligiblePools(pools);
  const listings = new Map();
  for (const pool of eligible) {
    for (const asset of pool.assets) {
      if (!asset || !isAddress(asset.address) || !isAddress(asset.vToken?.address)) {
        throw new Error(`Vesu lists a malformed asset in pool ${pool.id}.`);
      }
      const key = canonical(asset.address);
      if (!listings.has(key)) listings.set(key, []);
      listings.get(key).push({
        pool: canonical(pool.id),
        apiPoolName: String(pool.name ?? '').trim(),
        vault: canonical(asset.vToken.address),
        symbol: String(asset.symbol ?? ''),
        decimals: asset.decimals,
      });
    }
  }
  const approved = new Map(Object.entries(policy.pools).map(([address, entry]) => [canonical(address), entry]));
  const candidates = [];
  const skipped = [];
  const placed = new Set();
  for (const { group, tokens } of policy.groups) {
    for (const token of tokens) {
      const key = canonical(token);
      placed.add(key);
      const found = listings.get(key);
      if (!found) {
        skipped.push({ symbol: symbolFor(policy, key, null), token: key, reason: 'not-listed' });
        continue;
      }
      const listing = choose(found, key, policy);
      const apiSymbol = found[0].symbol;
      if (!listing || !approved.has(listing.pool)) {
        skipped.push({ symbol: symbolFor(policy, key, apiSymbol), token: key, reason: 'no-pool' });
        continue;
      }
      const { poolName, curation } = approved.get(listing.pool);
      candidates.push({ ...listing, token: key, group, poolName, curation });
    }
  }
  const unplaced = [...listings.keys()].filter((key) => !placed.has(key)).sort();
  for (const key of unplaced) {
    skipped.push({ symbol: listings.get(key)[0].symbol, token: key, reason: 'unclassified' });
  }
  return { candidates, skipped };
}

/** The one listing the policy picks for an asset, or null when it needs a decision. */
function choose(found, token, policy) {
  const byPool = (pool) => found.find((listing) => listing.pool === canonical(pool));
  const explicit = Object.entries(policy.choices).find(([address]) => canonical(address) === token)?.[1];
  return byPool(policy.prime)
    ?? byPool(policy.btc)
    ?? (found.length === 1 ? found[0] : null)
    ?? (explicit ? byPool(explicit.pool) ?? null : null);
}

function overrideFor(policy, token) {
  return Object.entries(policy.symbols).find(([address]) => canonical(address) === canonical(token))?.[1];
}

function symbolFor(policy, token, apiSymbol) {
  return overrideFor(policy, token)?.symbol ?? apiSymbol ?? token;
}

// ---------------------------------------------------------------------------
// Verification: mainnet must agree with every address a market names
// ---------------------------------------------------------------------------

const U256 = 'core::integer::u256';
const ADDRESS = 'core::starknet::contract_address::ContractAddress';
const BOOL = 'core::bool';

/** The vault entry points the action builders and position reads call, in their shapes. */
export const VAULT_SHAPES = deepFreeze({
  deposit: { inputs: [U256, ADDRESS], output: U256 },
  withdraw: { inputs: [U256, ADDRESS, ADDRESS], output: U256 },
  redeem: { inputs: [U256, ADDRESS, ADDRESS], output: U256 },
  balance_of: { inputs: [ADDRESS], output: U256 },
  preview_redeem: { inputs: [U256], output: U256 },
  max_withdraw: { inputs: [ADDRESS], output: U256 },
  max_redeem: { inputs: [ADDRESS], output: U256 },
  convert_to_assets: { inputs: [U256], output: U256 },
  asset: { inputs: [], output: ADDRESS },
  pool_contract: { inputs: [], output: ADDRESS },
});

/** The token entry points the pool and the shadow account rely on: an ordinary ERC-20. */
export const TOKEN_SHAPES = deepFreeze({
  approve: { inputs: [ADDRESS, U256], output: BOOL },
  transfer: { inputs: [ADDRESS, U256], output: BOOL },
  transfer_from: { inputs: [ADDRESS, ADDRESS, U256], output: BOOL },
  balance_of: { inputs: [ADDRESS], output: U256 },
  decimals: { inputs: [], output: 'core::integer::u8' },
});

/**
 * A contract that answered, but not as a market needs: a call the node
 * refused (no such entry point, a panic) or an answer of the wrong shape. The
 * candidate is skipped with the check's name. Anything else (the node down, a
 * rate limit) aborts the run, so a flaky RPC can never shrink the list.
 */
export class AnswerError extends Error {}

/**
 * Verify one candidate against mainnet through `reader`, and answer the
 * pinned market or the first check it failed.
 */
export async function verifyCandidate(reader, candidate, policy = POLICY) {
  const { token, vault, pool } = candidate;
  const override = overrideFor(policy, token);
  const skip = (reason, symbol = override?.symbol ?? candidate.symbol) => ({ ok: false, skip: { symbol, token, reason } });
  const checks = [
    ['vault entry points', async () => {
      const vaultClass = canonical(await reader.classHashAt(vault));
      if (vaultClass === canonical(VESU_VTOKEN_CLASS_HASH)) return vaultClass;
      return hasShapes(abiShapes(await reader.classAbi(vaultClass)), VAULT_SHAPES) ? vaultClass : null;
    }],
    ['vault asset()', async () => sameAddress(single(await reader.call(vault, SELECTORS.asset, [])), token)],
    ['vault pool_contract()', async () => sameAddress(single(await reader.call(vault, SELECTORS.pool_contract, [])), pool)],
    ['factory v_token_for_asset', async () => (
      sameAddress(single(await reader.call(VESU_POOL_FACTORY, SELECTORS.v_token_for_asset, [pool, token])), vault)
    )],
    ['factory asset_for_v_token', async () => (
      sameAddress(single(await reader.call(VESU_POOL_FACTORY, SELECTORS.asset_for_v_token, [pool, vault])), token)
    )],
    ['pool name', async () => {
      const onChain = decodeShortString(single(await reader.call(pool, SELECTORS.pool_name, []))).trim();
      return onChain === candidate.poolName && candidate.apiPoolName === candidate.poolName;
    }],
    ['pool paused', async () => BigInt(single(await reader.call(pool, SELECTORS.is_paused, []))) === 0n],
    ['token entry points', async () => (
      hasShapes(abiShapes(await reader.classAbi(canonical(await reader.classHashAt(token)))), TOKEN_SHAPES)
    )],
    ['token decimals()', async () => {
      const decimals = Number(BigInt(single(await reader.call(token, SELECTORS.decimals, []))));
      return Number.isSafeInteger(decimals) && decimals >= 0 && decimals <= 36 && decimals === candidate.decimals;
    }],
    ['token symbol()', async () => {
      // The token's own symbol, as Vesu shows it, unless the policy records
      // the contract's symbol and a display symbol to use instead.
      const onChain = decodeString(await reader.call(token, SELECTORS.symbol, []));
      return override ? onChain === override.onChain && candidate.symbol === override.symbol : onChain === candidate.symbol;
    }],
  ];
  let vaultClass = null;
  for (const [name, check] of checks) {
    let passed;
    try {
      passed = await check();
    } catch (error) {
      if (error instanceof AnswerError) return skip(`failed: ${name}`);
      throw error;
    }
    if (!passed) return skip(`failed: ${name}`);
    if (name === 'vault entry points') vaultClass = passed;
  }
  if (!(await reader.poolCreditsToken(token))) return skip('never-held');
  return {
    ok: true,
    market: {
      symbol: override?.symbol ?? candidate.symbol,
      token,
      decimals: candidate.decimals,
      group: candidate.group,
      vault,
      vaultClass,
      pool,
      poolName: candidate.poolName,
      curation: candidate.curation,
    },
  };
}

/** Select, then verify every candidate: the whole derivation, in the policy's order. */
export async function deriveMarkets(pools, reader, policy = POLICY) {
  const { candidates, skipped: unselected } = selectCandidates(pools, policy);
  const verdicts = await Promise.all(candidates.map((candidate) => verifyCandidate(reader, candidate, policy)));
  const markets = verdicts.filter((verdict) => verdict.ok).map((verdict) => verdict.market);
  const skipped = [...verdicts.filter((verdict) => !verdict.ok).map((verdict) => verdict.skip), ...unselected];
  const symbols = new Set(markets.map((market) => market.symbol));
  if (symbols.size !== markets.length) throw new Error('Two pinned markets would show the same symbol.');
  if (markets.length === 0 || markets.length > MAX_MARKETS) {
    throw new Error(`The Vault must pin 1 to ${MAX_MARKETS} markets, not ${markets.length}.`);
  }
  const order = orderOf(policy);
  skipped.sort((a, b) => (order.get(a.token) ?? Infinity) - (order.get(b.token) ?? Infinity) || a.token.localeCompare(b.token));
  return { markets, skipped };
}

function orderOf(policy) {
  const order = new Map();
  for (const { tokens } of policy.groups) for (const token of tokens) order.set(canonical(token), order.size);
  return order;
}

/** Each function's input types and output type, from a Sierra ABI, interfaces included. */
export function abiShapes(abi) {
  const shapes = new Map();
  const walk = (items) => {
    for (const item of items ?? []) {
      if (item?.type === 'function') {
        shapes.set(item.name, {
          inputs: (item.inputs ?? []).map((input) => input.type),
          output: (item.outputs ?? []).map((output) => output.type).join(','),
        });
      } else if (item?.type === 'interface') {
        walk(item.items);
      }
    }
  };
  walk(Array.isArray(abi) ? abi : []);
  return shapes;
}

function hasShapes(shapes, wanted) {
  return Object.entries(wanted).every(([name, shape]) => {
    const found = shapes.get(name);
    return found !== undefined
      && found.output === shape.output
      && found.inputs.length === shape.inputs.length
      && found.inputs.every((type, index) => type === shape.inputs[index]);
  });
}

// ---------------------------------------------------------------------------
// Rendering: one list, four files
// ---------------------------------------------------------------------------

export const OUTPUTS = Object.freeze({
  json: 'scripts/vesu-markets.json',
  privacy: 'packages/privacy/src/vesu-markets.ts',
  backend: 'apps/backend/src/vesu-markets.ts',
  web: 'apps/web/src/production/vesu-markets.ts',
});

const GENERATED_NOTE = [
  ' * Generated by `scripts/vesu-markets.mjs` from `scripts/vesu-markets.json`',
  ` * (${DECISION}). Do not edit by hand: \`node scripts/vesu-markets.mjs --write\``,
  ' * re-derives the list from Vesu\'s API, re-verifies every entry on mainnet',
  ' * and rewrites this file, and `scripts/vesu-markets.test.mjs` fails on any',
  ' * hand edit.',
];

export function renderJson({ markets, skipped }) {
  const rows = (items, fields) => items.map((item, index) => `    ${jsonObject(item, fields)}${index < items.length - 1 ? ',' : ''}`);
  return [
    '{',
    `  "about": ${JSON.stringify(`The Vault's pinned Vesu markets (${DECISION}). Generated by scripts/vesu-markets.mjs; do not edit by hand.`)},`,
    '  "markets": [',
    ...rows(markets, MARKET_FIELDS),
    '  ],',
    '  "skipped": [',
    ...rows(skipped, ['symbol', 'token', 'reason']),
    '  ]',
    '}',
    '',
  ].join('\n');
}

/** One flat object on one line, its fields in the given order. */
function jsonObject(value, fields) {
  return `{ ${fields.map((field) => `${JSON.stringify(field)}: ${JSON.stringify(value[field])}`).join(', ')} }`;
}

const MARKET_FIELDS = ['symbol', 'token', 'decimals', 'group', 'vault', 'vaultClass', 'pool', 'poolName', 'curation'];

export function renderPrivacy({ markets }) {
  return [
    '/**',
    ' * The Vault\'s pinned Vesu markets: one vault per token, each verified on',
    ` * mainnet against Vesu's PoolFactory (D-079, ${DECISION}).`,
    ' *',
    ...GENERATED_NOTE,
    ' */',
    '',
    '/** One pinned market. `vault.ts` freezes these into `VAULT_MARKETS`. */',
    'export interface VesuMarketRow {',
    '  readonly token: string;',
    '  readonly vault: string;',
    '  readonly pool: string;',
    '  readonly poolName: string;',
    '  readonly curation: \'prime\' | \'curated\';',
    '  readonly symbol: string;',
    '  readonly decimals: number;',
    '}',
    '',
    'export const VESU_MARKET_ROWS: readonly VesuMarketRow[] = [',
    ...markets.map((market) => `  ${tsObject(market, ['token', 'vault', 'pool', 'poolName', 'curation', 'symbol', 'decimals'])},`),
    '];',
    '',
  ].join('\n');
}

export function renderBackend({ markets }) {
  return [
    '/**',
    ` * The vaults the Vault's public reads pin (D-079, ${DECISION}), in the privacy`,
    " * package's order, and the Vesu pool each one supplies into.",
    ' *',
    ...GENERATED_NOTE,
    ' */',
    '',
    '/** One pinned vault. `vault.ts` freezes these into `VESU_VAULTS`. */',
    'export interface VesuVaultRow {',
    '  readonly token: string;',
    '  readonly vault: string;',
    '  readonly pool: string;',
    '}',
    '',
    'export const VESU_VAULT_ROWS: readonly VesuVaultRow[] = [',
    ...markets.map((market) => `  ${tsObject(market, ['token', 'vault', 'pool'])},`),
    '];',
    '',
  ].join('\n');
}

export function renderWeb({ markets }, policy = POLICY) {
  const groups = policy.groups.map(({ group }) => group);
  return [
    '/**',
    ' * The tokens the Vault can lend, in order, with the display metadata the',
    ` * counter shows (D-079, ${DECISION}): each token's symbol and decimals as its`,
    ' * contract reported them at generation, its group in the picker, and the',
    ' * Vesu pool its vault supplies into.',
    ' *',
    ...GENERATED_NOTE,
    ' */',
    '',
    `export type VaultMarketGroup = ${groups.map((group) => `'${group}'`).join(' | ')};`,
    '',
    '/** The picker\'s groups, in order. */',
    `export const VAULT_MARKET_GROUPS: readonly VaultMarketGroup[] = [${groups.map((group) => `'${group}'`).join(', ')}];`,
    '',
    '/** One market as the counter describes it. */',
    'export interface VaultMarketMetadata {',
    '  readonly token: string;',
    '  readonly symbol: string;',
    '  readonly decimals: number;',
    '  readonly group: VaultMarketGroup;',
    '  readonly poolName: string;',
    '  readonly curation: \'prime\' | \'curated\';',
    '}',
    '',
    'export const VAULT_MARKET_METADATA: readonly VaultMarketMetadata[] = [',
    ...markets.map((market) => `  ${tsObject(market, ['token', 'symbol', 'decimals', 'group', 'poolName', 'curation'])},`),
    '];',
    '',
  ].join('\n');
}

/** Every generated file's path and contents, keyed like `OUTPUTS`. */
export function renderAll(list, policy = POLICY) {
  return {
    json: renderJson(list),
    privacy: renderPrivacy(list),
    backend: renderBackend(list),
    web: renderWeb(list, policy),
  };
}

function tsObject(value, fields) {
  const parts = fields.map((field) => {
    const item = value[field];
    if (typeof item === 'number') return `${field}: ${item}`;
    if (typeof item !== 'string' || /['\\\n]/.test(item)) throw new Error(`Cannot render ${field}.`);
    return `${field}: '${item}'`;
  });
  return `{ ${parts.join(', ')} }`;
}

// ---------------------------------------------------------------------------
// Felt helpers
// ---------------------------------------------------------------------------

const FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

export function isAddress(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) return false;
  const number = BigInt(value);
  return number > 0n && number < (1n << 251n);
}

/** `0x` and 64 lowercase hex digits: the one spelling every output uses. */
export function canonical(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value) || BigInt(value) >= FIELD_PRIME) {
    throw new Error(`Not a felt: ${String(value)}`);
  }
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
}

function sameAddress(a, b) {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

function single(result) {
  if (!Array.isArray(result) || result.length !== 1 || typeof result[0] !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(result[0])) {
    throw new AnswerError('A call answered something other than one felt.');
  }
  return result[0];
}

/** A Cairo short string: up to 31 bytes in one felt, as text. */
export function decodeShortString(felt) {
  return bytesToText(feltBytes(felt, null));
}

/**
 * A `symbol()` answer: one short-string felt, or a Cairo `ByteArray`
 * (`[words, ...31-byte words, pending word, pending length]`).
 */
export function decodeString(result) {
  if (!Array.isArray(result) || result.length === 0 || result.some((item) => typeof item !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(item))) {
    throw new AnswerError('A malformed string answer.');
  }
  if (result.length === 1) return decodeShortString(result[0]);
  const words = Number(BigInt(result[0]));
  if (!Number.isSafeInteger(words) || words < 0 || result.length !== words + 3) throw new AnswerError('A malformed ByteArray.');
  const pendingLength = Number(BigInt(result[words + 2]));
  if (pendingLength < 0 || pendingLength > 30) throw new AnswerError('A malformed ByteArray.');
  const bytes = [];
  for (let index = 1; index <= words; index += 1) bytes.push(...feltBytes(result[index], 31));
  bytes.push(...feltBytes(result[words + 1], pendingLength));
  return bytesToText(bytes);
}

/** A felt's big-endian bytes: exactly `length` of them, or as few as it needs when `length` is null. */
function feltBytes(felt, length) {
  let hex = BigInt(felt).toString(16);
  if (hex === '0') hex = '';
  if (hex.length % 2) hex = `0${hex}`;
  if (length !== null) {
    if (hex.length > length * 2) throw new AnswerError('A ByteArray word is longer than it says.');
    hex = hex.padStart(length * 2, '0');
  }
  return [...Buffer.from(hex, 'hex')];
}

/**
 * The bytes as text. Zero bytes are dropped, as starknet.js's own decoder
 * drops them: sUSN's contract, for one, pads its symbol with a zero word.
 * Anything else outside printable ASCII is not a symbol.
 */
function bytesToText(bytes) {
  const text = Buffer.from(bytes.filter((byte) => byte !== 0)).toString('latin1');
  if (!/^[\x20-\x7e]*$/.test(text)) throw new AnswerError('A string answer that is not printable ASCII.');
  return text;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

// ---------------------------------------------------------------------------
// The live reader: JSON-RPC and Vesu's API
// ---------------------------------------------------------------------------

/** JSON-RPC errors that describe the called contract: not found, or execution failed. */
const CONTRACT_ERROR_CODES = new Set([20, 21, 40]);

export function liveReader({ rpcUrl = DEFAULT_RPC_URL, fetcher = globalThis.fetch, concurrency = 3 } = {}) {
  let id = 0;
  let active = 0;
  const waiting = [];
  const classes = new Map();
  const acquire = async () => {
    if (active >= concurrency) await new Promise((resolve) => waiting.push(resolve));
    active += 1;
  };
  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };
  const rpc = async (method, params) => {
    await acquire();
    try {
      for (let attempt = 0; ; attempt += 1) {
        const response = await fetcher(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: (id += 1), method, params }),
        });
        // A public RPC rate-limits a long event scan: back off and ask again,
        // honouring Retry-After, for up to about three minutes in all.
        if ((response.status === 429 || response.status >= 500) && attempt < 12) {
          const retryAfter = Number(response.headers.get('retry-after'));
          const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : Math.min(1_000 * 2 ** attempt, 30_000);
          await new Promise((resolve) => setTimeout(resolve, wait));
          continue;
        }
        if (!response.ok) throw new Error(`${method} answered HTTP ${response.status}.`);
        const body = await response.json();
        if (body.error) {
          // A call the contract refused (no such entry point, a panic) is an
          // answer about that contract; any other error is the node's.
          if (method === 'starknet_call' && CONTRACT_ERROR_CODES.has(body.error.code)) {
            throw new AnswerError(`${method} failed: ${body.error.code}`);
          }
          throw new Error(`${method} failed: ${body.error.code} ${body.error.message}`);
        }
        return body.result;
      }
    } finally {
      release();
    }
  };
  return {
    rpc,
    head: () => rpc('starknet_blockNumber', []),
    classHashAt: (address) => rpc('starknet_getClassHashAt', ['latest', address]),
    classAbi(classHash) {
      if (!classes.has(classHash)) {
        classes.set(classHash, rpc('starknet_getClass', ['latest', classHash]).then((cls) => (
          typeof cls.abi === 'string' ? JSON.parse(cls.abi) : cls.abi
        )));
      }
      return classes.get(classHash);
    },
    call: (address, selector, calldata) => rpc('starknet_call', [
      { contract_address: address, entry_point_selector: selector, calldata },
      'latest',
    ]),
    /** The first pool event crediting `token` to a note, or null: `Deposit` and `OpenNoteDeposited` both key the token third. */
    async poolCreditsToken(token) {
      let continuation;
      for (let page = 0; page < 5_000; page += 1) {
        const answer = await rpc('starknet_getEvents', [{
          address: STRK20_POOL,
          from_block: { block_number: STRK20_POOL_FIRST_BLOCK },
          to_block: 'latest',
          keys: [[SELECTORS.Deposit, SELECTORS.OpenNoteDeposited], [], [token]],
          chunk_size: 1_000,
          ...(continuation ? { continuation_token: continuation } : {}),
        }]);
        const event = answer.events?.find((item) => sameAddress(item.keys?.[2], token));
        if (event) return { block: event.block_number };
        continuation = answer.continuation_token;
        if (!continuation) return null;
      }
      throw new Error(`The event scan for ${token} did not end.`);
    },
  };
}

async function fetchVesuPools(apiUrl, fetcher = globalThis.fetch) {
  const response = await fetcher(`${apiUrl.replace(/\/$/, '')}/pools`, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Vesu's /pools answered HTTP ${response.status}.`);
  const body = await response.json();
  return body.data;
}

/** The current rates, for the report only: they move, so nothing pinned holds them. */
function rateOf(pools, market) {
  const pool = pools.find((candidate) => sameAddress(candidate.id, market.pool));
  const asset = pool?.assets.find((candidate) => sameAddress(candidate.address, market.token));
  const apy = asset?.stats?.supplyApy;
  if (!apy) return 'n/a';
  return `${(Number(BigInt(apy.value)) / 10 ** apy.decimals * 100).toFixed(4)}%`;
}

async function main(argv) {
  const write = argv.includes('--write');
  const rpcUrl = process.env.STARKNET_RPC_URL || DEFAULT_RPC_URL;
  const apiUrl = process.env.VESU_API_URL || DEFAULT_VESU_API_URL;
  const reader = liveReader({ rpcUrl });
  const head = await reader.head();
  const pools = await fetchVesuPools(apiUrl);
  const list = await deriveMarkets(pools, reader);
  const rendered = renderAll(list);

  console.log(`Vesu markets, verified on mainnet at block ${head} (${rpcUrl})`);
  for (const market of list.markets) {
    console.log(`  ${market.symbol.padEnd(9)} ${market.group.padEnd(9)} ${market.curation.padEnd(7)} ${market.poolName.padEnd(28)} vault ${market.vault}  APY ${rateOf(pools, market)}`);
  }
  for (const skip of list.skipped) console.log(`  skipped ${skip.symbol.padEnd(9)} ${skip.reason}`);

  let drift = 0;
  for (const [key, path] of Object.entries(OUTPUTS)) {
    const target = join(REPO, path);
    let current = null;
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      current = null;
    }
    if (current === rendered[key]) continue;
    if (write) {
      writeFileSync(target, rendered[key]);
      console.log(`  wrote ${path}`);
    } else {
      drift += 1;
      console.log(`DRIFT ${path} differs from what Vesu and mainnet derive now; review, then run with --write`);
    }
  }
  if (drift > 0) process.exit(1);
  console.log(write ? 'Written.' : 'The pinned list matches Vesu and mainnet.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
