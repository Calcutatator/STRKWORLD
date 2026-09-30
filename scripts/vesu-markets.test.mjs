import { readFileSync } from 'node:fs';
import { hash } from 'starknet';
import { describe, expect, it } from 'vitest';
import {
  AnswerError,
  DECISION,
  MAX_MARKETS,
  OUTPUTS,
  POLICY,
  SELECTORS,
  TOKEN_SHAPES,
  VAULT_SHAPES,
  VESU_POOL_FACTORY,
  VESU_VTOKEN_CLASS_HASH,
  canonical,
  decodeString,
  deriveMarkets,
  renderAll,
  renderJson,
  selectCandidates,
  verifyCandidate,
} from './vesu-markets.mjs';

/**
 * D-081: the Vault's pinned Vesu markets. The committed list is pinned here
 * entry by entry, the three package copies must be exactly what the generator
 * renders from it, and the policy and the on-chain checks are exercised
 * against a fake Vesu and a fake chain, so nothing here touches the network.
 * The live re-derivation is `node scripts/vesu-markets.mjs`.
 */

const repo = new URL('../', import.meta.url);
const committed = (path) => readFileSync(new URL(path, repo), 'utf8');
const LIST = JSON.parse(committed(OUTPUTS.json));

const PRIME = '0x0451fe483d5921a2919ddd81d0de6696669bccdacd859f72a4fba7656b97c3b5';
const RE7_XBTC = '0x03a8416bf20d036df5b1cf3447630a2e1cb04685f6b0c3a70ed7fb1473548ecf';
const RE7_ECOSYSTEM = '0x0486294fe74daf3d964523e7a1f4e5d686f153934b2c183ececa0cab9dd2f3e6';
const RE7_USDC_STABLE_CORE = '0x073702fce24aba36da1eac539bd4bae62d4d6a76747b7cdd3e016da754d7a135';
const CLEARSTAR = '0x01bc5de51365ed7fbb11ebc81cef9fd66b70050ec10fd898f0c4698765bf5803';

describe('the pinned list (D-081)', () => {
  it('pins exactly these sixteen markets, in the counter’s order', () => {
    expect(LIST.markets.map(({ symbol, group, poolName, curation }) => `${symbol} ${group} ${poolName} ${curation}`)).toEqual([
      'STRK majors Prime prime',
      'ETH majors Prime prime',
      'USDC stables Prime prime',
      'USDT stables Prime prime',
      'USDC.e stables Prime prime',
      'WBTC btc Prime prime',
      'strkBTC btc Re7 xBTC curated',
      'tBTC btc Re7 xBTC curated',
      'SolvBTC btc Re7 xBTC curated',
      'xSTRK staking Prime prime',
      'wstETH staking Prime prime',
      'xWBTC staking Prime prime',
      'xstrkBTC staking Re7 xBTC curated',
      'xtBTC staking Re7 xBTC curated',
      'LBTC staking Re7 xBTC curated',
      'EKUBO ecosystem Re7 Labs Starknet Ecosystem curated',
    ]);
    expect(LIST.markets.map(({ symbol, token, vault, decimals }) => [symbol, token, vault, decimals])).toEqual([
      ['STRK', '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d', '0x06d6d2bf905dd199c78f2e421521d8473042737be9f47904e7578536c10f279d', 18],
      ['ETH', '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7', '0x006ac248c18c69e57573aa3eeccbb7f8cd29e3024561be252ee7b34b96c1043e', 18],
      ['USDC', '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb', '0x00387e8ddbb1ab36ca08874d9abc702ef4872ad600dcf76b7f240b71d7bc4e65', 6],
      ['USDT', '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8', '0x06be9f8980779930045b93c295105c6810d38191ec522b5175ddf7dbf9b22f9d', 6],
      ['USDC.e', '0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8', '0x00079c83c3eb20df05d9e3ebdd45990060101bd126666181de622e432948f3e9', 6],
      ['WBTC', '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac', '0x04ecb0667140b9f45b067d026953ed79f22723f1cfac05a7b26c3ac06c88f56c', 8],
      ['strkBTC', '0x0787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135', '0x04269987e8971bc613be4f8161e04a4d2652f5e6ade9aa3f2820b1fc3f7ef848', 8],
      ['tBTC', '0x04daa17763b286d1e59b97c283c0b8c949994c361e426a28f743c67bdfe9a32f', '0x04cbe8b13ebadd744254b09a40f4395f580e8a4a30acb2653849f61d12bfa039', 18],
      ['SolvBTC', '0x0593e034dda23eea82d2ba9a30960ed42cf4a01502cc2351dc9b9881f9931a68', '0x0590117befc944f23b39ca5b0401e6aaa7834e90f2eb284baa2bfc475bd66190', 18],
      ['xSTRK', '0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a', '0x073f369a935c8d8c9c793b371c5d384988060a96e7b11fb1dd2e5718d34639ad', 18],
      ['wstETH', '0x0057912720381af14b0e5c87aa4718ed5e527eab60b3801ebf702ab09139e38b', '0x07d231447ac838f45740ed823c3ae0982d94377bc9f165f751a371a41e9c1740', 18],
      ['xWBTC', '0x06a567e68c805323525fe1649adb80b03cddf92c23d2629a6779f54192dffc13', '0x00beb129889ac800bb84a8d31dfaa39c8710ee8f6310386ee03a37e79e6d7e1f', 8],
      ['xstrkBTC', '0x047751b3532fabca89b0f2e35ca1cb45e5a7b11d5e3d3663dfa1f4406b45fd88', '0x01196b589bbc3379aa43bbba6ac40e89766d7e5242b098f47e587f2afc577c7a', 8],
      ['xtBTC', '0x043a35c1425a0125ef8c171f1a75c6f31ef8648edcc8324b55ce1917db3f9b91', '0x03d90538d9b66c7fa3e582e7af5e96018a4f8f1e43d5eace23ba820fbe06ff70', 18],
      ['LBTC', '0x036834a40984312f7f7de8d31e3f6305b325389eaeea5b1c0664b2fb936461a4', '0x073476ed5b0d781182ede4c806241a93cb47cb00b6de354855a1fc6233a13b35', 8],
      ['EKUBO', '0x075afe6402ad5a5c20dd25e10ec3b3986acaa647b77e4ae24b0cbc9a54a27a87', '0x04fcf9064c23d146f6921b3fd9301bbec6384b37b87c173809a79f91b4d46fc4', 18],
    ]);
    const pools = { Prime: PRIME, 'Re7 xBTC': RE7_XBTC, 'Re7 Labs Starknet Ecosystem': RE7_ECOSYSTEM };
    for (const market of LIST.markets) {
      expect(market.pool, market.symbol).toBe(pools[market.poolName]);
      // Every pinned vault runs vSTRK's class, the PoolFactory's own vToken class.
      expect(market.vaultClass, market.symbol).toBe(canonical(VESU_VTOKEN_CLASS_HASH));
    }
    expect(LIST.markets.length).toBeLessThanOrEqual(MAX_MARKETS);
    expect(MAX_MARKETS).toBe(48);
  });

  it('keeps D-079’s five vaults, and adds strkBTC through Re7 xBTC as the lead chose', () => {
    const bySymbol = Object.fromEntries(LIST.markets.map((market) => [market.symbol, market]));
    expect(bySymbol.STRK.vault).toBe('0x06d6d2bf905dd199c78f2e421521d8473042737be9f47904e7578536c10f279d');
    for (const symbol of ['STRK', 'ETH', 'USDC', 'USDT', 'WBTC']) expect(bySymbol[symbol].pool, symbol).toBe(PRIME);
    expect(bySymbol.strkBTC).toMatchObject({ pool: RE7_XBTC, curation: 'curated' });
  });

  it('reports every Vesu token it leaves out, and why', () => {
    expect(LIST.skipped.map(({ symbol, reason }) => `${symbol} ${reason}`)).toEqual([
      'sUSN never-held',
      'mRe7YIELD never-held',
      'uniBTC never-held',
      'YBTC.B never-held',
      'mRe7BTC never-held',
      'xLBTC never-held',
      'xsBTC never-held',
    ]);
  });

  it.each(Object.entries(OUTPUTS))('renders %s exactly as committed, from the one list', (key, path) => {
    expect(committed(path)).toBe(renderAll(LIST)[key]);
  });

  it('names its decision in every file it writes', () => {
    for (const path of Object.values(OUTPUTS)) expect(committed(path), path).toContain(DECISION);
  });

  it('round-trips its own JSON', () => {
    expect(renderJson(JSON.parse(renderJson(LIST)))).toBe(committed(OUTPUTS.json));
  });
});

describe('the pinned contracts and selectors', () => {
  it.each(Object.entries(SELECTORS))('pins %s by its own sn_keccak', (name, selector) => {
    expect(BigInt(selector)).toBe(BigInt(hash.getSelectorFromName(name)));
  });

  it('pins Vesu’s PoolFactory and vToken class, as its docs and the chain give them', () => {
    expect(VESU_POOL_FACTORY).toBe('0x03760f903a37948f97302736f89ce30290e45f441559325026842b7a6fb388c0');
    expect(VESU_VTOKEN_CLASS_HASH).toBe('0x41b16e0ca0565a58d1379ffc3c7eab7459b382ba8f8208b3b87d18d2aed4f78');
  });
});

describe('decoding a symbol', () => {
  const felt = (text) => `0x${Buffer.from(text, 'latin1').toString('hex')}`;

  it.each([
    ['a short string', [felt('EKUBO')], 'EKUBO'],
    ['a ByteArray with only a pending word', ['0x0', felt('USDC'), '0x4'], 'USDC'],
    ['a ByteArray with a full word', ['0x1', felt('A'.repeat(31)), felt('BC'), '0x2'], `${'A'.repeat(31)}BC`],
    // sUSN's own answer: a zero word, then the symbol.
    ['sUSN’s zero-padded ByteArray', ['0x1', '0x0', '0x7355534e', '0x4'], 'sUSN'],
  ])('reads %s', (_label, answer, text) => {
    expect(decodeString(answer)).toBe(text);
  });

  it.each([
    ['nothing', []],
    ['a ByteArray whose length disagrees', ['0x2', felt('A'), '0x0', '0x0']],
    ['a word longer than it says', ['0x0', felt('USDC'), '0x2']],
    ['a non-printable byte', [felt('US\nDC')]],
  ])('refuses %s as an answer, not an outage', (_label, answer) => {
    expect(() => decodeString(answer)).toThrow(AnswerError);
  });
});

// ---------------------------------------------------------------------------
// A fake Vesu and a fake chain
// ---------------------------------------------------------------------------

const TOKENS = {
  STRK: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
  STRKBTC: '0x0787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135',
  USDC_E: '0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8',
  SUSN: '0x02411565ef1a14decfbe83d2e987cced918cd752508a3d9c55deb67148d14d17',
  EKUBO: '0x075afe6402ad5a5c20dd25e10ec3b3986acaa647b77e4ae24b0cbc9a54a27a87',
  UNKNOWN: '0x0777777777777777777777777777777777777777777777777777777777777777',
};
const SYMBOLS = { STRK: 'STRK', STRKBTC: 'strkBTC', USDC_E: 'USDC.e', SUSN: 'sUSN', EKUBO: 'EKUBO', UNKNOWN: 'NEW' };
const vaultOf = (pool, token) => `0x${((BigInt(pool) * 7n + BigInt(token)) % (1n << 250n)).toString(16).padStart(64, '0')}`;

function asset(key, pool) {
  return { address: TOKENS[key], symbol: SYMBOLS[key], decimals: key === 'STRKBTC' ? 8 : key === 'USDC_E' ? 6 : 18, vToken: { address: vaultOf(pool, TOKENS[key]) } };
}

function vesuPool(id, name, keys, fields = {}) {
  return { id, name, protocolVersion: 'v2', isDeprecated: false, isVerified: true, isPaused: false, shutdownConfig: null, assets: keys.map((key) => asset(key, id)), ...fields };
}

/** Vesu's pool list, in the shape its API answers, cut to what the generator reads. */
function vesuPools() {
  return [
    vesuPool(PRIME, 'Prime', ['STRK', 'USDC_E']),
    vesuPool(RE7_XBTC, 'Re7 xBTC', ['STRKBTC']),
    vesuPool(CLEARSTAR, 'Clearstar USDC Reactor', ['STRKBTC', 'SUSN']),
    vesuPool(RE7_USDC_STABLE_CORE, 'Re7 USDC Stable Core', ['SUSN']),
    vesuPool(RE7_ECOSYSTEM, 'Re7 Labs Starknet Ecosystem ', ['EKUBO', 'STRK']),
    // Ignored: unverified, deprecated, V1 and paused pools.
    vesuPool('0x01', 'test24', ['UNKNOWN'], { isVerified: false }),
    vesuPool('0x02', 'Genesis', ['UNKNOWN'], { isDeprecated: true }),
    vesuPool('0x03', 'Old', ['UNKNOWN'], { protocolVersion: 'v1' }),
    vesuPool('0x04', 'Frozen', ['UNKNOWN'], { isPaused: true }),
  ];
}

const policy = {
  ...POLICY,
  groups: [
    { group: 'majors', tokens: [TOKENS.STRK] },
    { group: 'stables', tokens: [TOKENS.USDC_E, TOKENS.SUSN] },
    { group: 'btc', tokens: [TOKENS.STRKBTC] },
    { group: 'ecosystem', tokens: [TOKENS.EKUBO] },
  ],
};

const TYPE = { u256: 'core::integer::u256', address: 'core::starknet::contract_address::ContractAddress', bool: 'core::bool' };
const fn = (name, inputs, output) => ({ type: 'function', name, inputs: inputs.map((type, index) => ({ name: `a${index}`, type })), outputs: output ? [{ type: output }] : [] });
const abiFor = (shapes) => [{ type: 'interface', name: 'I', items: Object.entries(shapes).map(([name, shape]) => fn(name, shape.inputs, shape.output)) }];
const felt = (text) => `0x${Buffer.from(text, 'latin1').toString('hex')}`;

/**
 * A chain that agrees with `vesuPools()` everywhere, except where `lie`
 * says otherwise: `lie(contract, selector, calldata, answer)` returns the
 * answer to give instead.
 */
function chain({ lie = (_contract, _selector, _calldata, answer) => answer, held = new Set(Object.values(TOKENS)), classes = {}, abis = {} } = {}) {
  const pools = vesuPools();
  const vaults = new Map();
  for (const pool of pools) for (const entry of pool.assets) vaults.set(canonical(entry.vToken.address), { pool: canonical(pool.id), token: canonical(entry.address), entry, poolName: pool.name });
  const tokens = new Map(Object.entries(TOKENS).map(([key, token]) => [canonical(token), key]));
  const answer = (contract, selector, calldata) => {
    const address = canonical(contract);
    if (address === canonical(VESU_POOL_FACTORY)) {
      if (selector === SELECTORS.v_token_for_asset) return [vaultOf(calldata[0], calldata[1])];
      if (selector === SELECTORS.asset_for_v_token) return [vaults.get(canonical(calldata[1]))?.token ?? '0x0'];
    }
    const vault = vaults.get(address);
    if (vault) {
      if (selector === SELECTORS.asset) return [vault.token];
      if (selector === SELECTORS.pool_contract) return [vault.pool];
    }
    const pool = pools.find((candidate) => canonical(candidate.id) === address);
    if (pool) {
      if (selector === SELECTORS.pool_name) return [felt(pool.name)];
      if (selector === SELECTORS.is_paused) return ['0x0'];
    }
    const key = tokens.get(address);
    if (key) {
      if (selector === SELECTORS.decimals) return [`0x${asset(key, PRIME).decimals.toString(16)}`];
      if (selector === SELECTORS.symbol) return [felt(key === 'USDC_E' ? 'USDC' : SYMBOLS[key])];
    }
    throw new AnswerError(`no such entry point on ${address}`);
  };
  return {
    async classHashAt(address) {
      const key = canonical(address);
      if (classes[key]) return classes[key];
      return vaults.has(key) ? VESU_VTOKEN_CLASS_HASH : '0x7070';
    },
    async classAbi(classHash) {
      return abis[canonical(classHash)] ?? (canonical(classHash) === canonical('0x7070') ? abiFor(TOKEN_SHAPES) : abiFor(VAULT_SHAPES));
    },
    async call(contract, selector, calldata) {
      return lie(canonical(contract), selector, calldata, answer(contract, selector, calldata));
    },
    async poolCreditsToken(token) {
      return held.has(token) || [...held].some((entry) => BigInt(entry) === BigInt(token)) ? { block: 9_000_000 } : null;
    },
  };
}

describe('choosing one vault per token (D-081 policy)', () => {
  const chosen = (pools = vesuPools(), withPolicy = policy) => Object.fromEntries(
    selectCandidates(pools, withPolicy).candidates.map(({ symbol, poolName }) => [symbol, poolName]),
  );

  it('takes Prime’s vault whenever Prime lists the token, over every curated pool', () => {
    expect(chosen()).toMatchObject({ STRK: 'Prime', 'USDC.e': 'Prime' });
  });

  it('takes Re7 xBTC for strkBTC, the lead’s choice, though Clearstar lists it too', () => {
    expect(chosen().strkBTC).toBe('Re7 xBTC');
  });

  it('takes the only pool that lists a token, and the policy’s choice when several curated pools do', () => {
    expect(chosen()).toMatchObject({ EKUBO: 'Re7 Labs Starknet Ecosystem', sUSN: 'Re7 USDC Stable Core' });
    expect(POLICY.choices[TOKENS.SUSN]).toMatchObject({ pool: RE7_USDC_STABLE_CORE });
    expect(POLICY.choices[TOKENS.SUSN].why).toMatch(/collateral only/);
  });

  it('asks for a decision rather than guessing when several curated pools list a token and the policy names none', () => {
    const { skipped } = selectCandidates(vesuPools(), { ...policy, choices: {} });
    expect(skipped).toContainEqual({ symbol: 'sUSN', token: canonical(TOKENS.SUSN), reason: 'no-pool' });
  });

  it('never chooses a pool the policy does not approve by address, whatever Vesu calls it', () => {
    const pools = vesuPools().filter((pool) => pool.id !== RE7_ECOSYSTEM);
    pools.push(vesuPool('0x0666', 'Re7 Labs Starknet Ecosystem', ['EKUBO']));
    expect(selectCandidates(pools, policy).skipped).toContainEqual({ symbol: 'EKUBO', token: canonical(TOKENS.EKUBO), reason: 'no-pool' });
  });

  it('ignores unverified, deprecated, V1 and paused pools, and leaves a token Vesu lists nowhere else unplaced', () => {
    const { candidates, skipped } = selectCandidates(vesuPools(), policy);
    expect(candidates.map(({ token }) => token)).not.toContain(canonical(TOKENS.UNKNOWN));
    expect(skipped.map(({ reason }) => reason)).not.toContain('unclassified');
    const listed = [...vesuPools(), vesuPool(RE7_USDC_STABLE_CORE, 'Re7 USDC Stable Core', ['UNKNOWN'])];
    expect(selectCandidates(listed, policy).skipped).toContainEqual({ symbol: 'NEW', token: canonical(TOKENS.UNKNOWN), reason: 'unclassified' });
  });

  it('places every token Vesu lists today in exactly one group, and approves every pool it may choose', () => {
    const placed = POLICY.groups.flatMap(({ tokens }) => tokens.map(canonical));
    expect(new Set(placed).size).toBe(placed.length);
    for (const market of [...LIST.markets, ...LIST.skipped]) expect(placed, market.symbol).toContain(market.token);
    for (const market of LIST.markets) expect(POLICY.pools[market.pool], market.symbol).toMatchObject({ poolName: market.poolName, curation: market.curation });
    expect(POLICY.pools[PRIME].curation).toBe('prime');
    expect(Object.entries(POLICY.pools).filter(([, entry]) => entry.curation === 'prime').map(([address]) => address)).toEqual([PRIME]);
  });
});

describe('verifying a market on mainnet', () => {
  const candidateFor = (symbol) => selectCandidates(vesuPools(), policy).candidates.find((candidate) => candidate.symbol === symbol);

  it('pins a market mainnet agrees with, with the policy’s display symbol', async () => {
    await expect(verifyCandidate(chain(), candidateFor('USDC.e'), policy)).resolves.toEqual({
      ok: true,
      market: {
        symbol: 'USDC.e',
        token: canonical(TOKENS.USDC_E),
        decimals: 6,
        group: 'stables',
        vault: vaultOf(PRIME, TOKENS.USDC_E),
        vaultClass: canonical(VESU_VTOKEN_CLASS_HASH),
        pool: PRIME,
        poolName: 'Prime',
        curation: 'prime',
      },
    });
  });

  it.each([
    ['vault asset()', (contract, selector, _calldata, answer) => (selector === SELECTORS.asset ? [TOKENS.STRK] : answer)],
    ['vault pool_contract()', (contract, selector, _calldata, answer) => (selector === SELECTORS.pool_contract ? [CLEARSTAR] : answer)],
    ['factory v_token_for_asset', (contract, selector, _calldata, answer) => (selector === SELECTORS.v_token_for_asset ? ['0x1234'] : answer)],
    ['factory asset_for_v_token', (contract, selector, _calldata, answer) => (selector === SELECTORS.asset_for_v_token ? ['0x0'] : answer)],
    ['pool name', (contract, selector, _calldata, answer) => (selector === SELECTORS.pool_name ? [felt('Re7 xBTC 2')] : answer)],
    ['pool paused', (contract, selector, _calldata, answer) => (selector === SELECTORS.is_paused ? ['0x1'] : answer)],
    ['token decimals()', (contract, selector, _calldata, answer) => (selector === SELECTORS.decimals ? ['0x12'] : answer)],
    ['token symbol()', (contract, selector, _calldata, answer) => (selector === SELECTORS.symbol ? [felt('BTC')] : answer)],
    ['vault asset()', (contract, selector, _calldata, answer) => (selector === SELECTORS.asset ? [TOKENS.STRKBTC, '0x0'] : answer)],
  ])('skips strkBTC when mainnet disagrees on %s', async (check, lie) => {
    await expect(verifyCandidate(chain({ lie }), candidateFor('strkBTC'), policy)).resolves.toEqual({
      ok: false,
      skip: { symbol: 'strkBTC', token: canonical(TOKENS.STRKBTC), reason: `failed: ${check}` },
    });
  });

  it('accepts a vault of another class only when its ABI has every entry point the builders call, in their shapes', async () => {
    const vault = vaultOf(RE7_XBTC, TOKENS.STRKBTC);
    const other = canonical('0x0abc');
    const good = chain({ classes: { [vault]: other }, abis: { [other]: abiFor(VAULT_SHAPES) } });
    await expect(verifyCandidate(good, candidateFor('strkBTC'), policy)).resolves.toMatchObject({ ok: true, market: { vaultClass: other } });
    const { redeem: _redeem, ...withoutRedeem } = VAULT_SHAPES;
    const bad = chain({ classes: { [vault]: other }, abis: { [other]: abiFor(withoutRedeem) } });
    await expect(verifyCandidate(bad, candidateFor('strkBTC'), policy)).resolves.toMatchObject({ skip: { reason: 'failed: vault entry points' } });
    const wrongShape = chain({ classes: { [vault]: other }, abis: { [other]: abiFor({ ...VAULT_SHAPES, deposit: { inputs: [TYPE.u256], output: TYPE.u256 } }) } });
    await expect(verifyCandidate(wrongShape, candidateFor('strkBTC'), policy)).resolves.toMatchObject({ skip: { reason: 'failed: vault entry points' } });
  });

  it('skips a token that is not an ordinary ERC-20: an approve of another shape', async () => {
    const token = canonical(TOKENS.STRKBTC);
    const odd = canonical('0x0dd');
    const reader = chain({ classes: { [token]: odd }, abis: { [odd]: abiFor({ ...TOKEN_SHAPES, approve: { inputs: [TYPE.address, TYPE.u256], output: '' } }) } });
    await expect(verifyCandidate(reader, candidateFor('strkBTC'), policy)).resolves.toMatchObject({ skip: { reason: 'failed: token entry points' } });
  });

  it('skips a token the STRK20 pool has never credited to a note', async () => {
    const reader = chain({ held: new Set([TOKENS.STRK]) });
    await expect(verifyCandidate(reader, candidateFor('EKUBO'), policy)).resolves.toEqual({
      ok: false,
      skip: { symbol: 'EKUBO', token: canonical(TOKENS.EKUBO), reason: 'never-held' },
    });
  });

  it('aborts on a node that cannot answer, so a flaky RPC never shrinks the list', async () => {
    const reader = chain({ lie: () => { throw new Error('HTTP 429'); } });
    await expect(verifyCandidate(reader, candidateFor('strkBTC'), policy)).rejects.toThrow('HTTP 429');
  });
});

describe('the whole derivation', () => {
  it('pins what the policy chooses and mainnet agrees with, and reports the rest in the policy’s order', async () => {
    const list = await deriveMarkets(vesuPools(), chain({ held: new Set([TOKENS.STRK, TOKENS.USDC_E, TOKENS.STRKBTC, TOKENS.EKUBO]) }), policy);
    expect(list.markets.map(({ symbol, poolName }) => `${symbol} ${poolName}`)).toEqual([
      'STRK Prime', 'USDC.e Prime', 'strkBTC Re7 xBTC', 'EKUBO Re7 Labs Starknet Ecosystem',
    ]);
    expect(list.skipped).toEqual([{ symbol: 'sUSN', token: canonical(TOKENS.SUSN), reason: 'never-held' }]);
    expect(renderJson(list)).toBe(renderJson(await deriveMarkets(vesuPools(), chain({ held: new Set([TOKENS.STRK, TOKENS.USDC_E, TOKENS.STRKBTC, TOKENS.EKUBO]) }), policy)));
  });

  it('refuses a list with two markets showing one symbol', async () => {
    // EKUBO's contract and Vesu both calling it STRK: every check passes, and the list must still refuse it.
    const pools = vesuPools().map((pool) => ({
      ...pool,
      assets: pool.assets.map((entry) => (BigInt(entry.address) === BigInt(TOKENS.EKUBO) ? { ...entry, symbol: 'STRK' } : entry)),
    }));
    const lie = (contract, selector, _calldata, answer) => (
      contract === canonical(TOKENS.EKUBO) && selector === SELECTORS.symbol ? [felt('STRK')] : answer
    );
    await expect(deriveMarkets(pools, chain({ lie }), policy)).rejects.toThrow(/same symbol/);
  });

  it('skips a display symbol the policy records against a label Vesu no longer uses', async () => {
    const renamed = { ...policy, symbols: { [TOKENS.USDC_E]: { symbol: 'USDC.x', onChain: 'USDC', why: 'test' } } };
    const list = await deriveMarkets(vesuPools(), chain(), renamed);
    expect(list.skipped).toContainEqual({ symbol: 'USDC.x', token: canonical(TOKENS.USDC_E), reason: 'failed: token symbol()' });
  });

  it('refuses a list with no market at all', async () => {
    await expect(deriveMarkets(vesuPools(), chain({ held: new Set() }), policy)).rejects.toThrow(/1 to 48 markets/);
  });
});
