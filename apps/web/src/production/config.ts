import type { WalletSessionOptions } from '@strkworld/privacy';

const MAINNET_NAME = 'SN_MAIN';
const MAINNET_CHAIN_ID = '0x534e5f4d41494e';
const MAX_U128 = (1n << 128n) - 1n;
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
/**
 * Canonical Starknet mainnet STRK: the pool's money and fee token (D-013). The
 * only token unshield admits (D-062), and the one the Bank shields.
 */
export const STRK_TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
/** Endur xSTRK (D-063). Inlined like STRK so this file keeps type-only privacy imports; a test pins it to `ENDUR_XSTRK`. */
export const XSTRK_TOKEN = '0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a';
/** D-072: the most tokens a shield allowlist may name. A longer list is a mistake, not a policy. */
export const MAX_SHIELD_TOKENS = 16;
/**
 * D-079: the tokens the Vault can lend, in order, each with a Vesu Prime
 * vault pinned in `packages/privacy/src/vault.ts` (`VAULT_MARKETS`): STRK,
 * ETH, Circle's USDC, USDT and WBTC. Inlined like STRK so this file keeps
 * type-only privacy imports; `config.test.ts` pins it to that map, token for
 * token. A Vault allowlist may name only these, each at most once, so this
 * list's length is also its bound.
 */
export const VAULT_TOKENS: readonly string[] = Object.freeze([
  STRK_TOKEN,
  '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7',
  '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb',
  '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8',
  '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac',
]);
/** D-079: the most tokens a Vault allowlist may name: one per pinned vault. */
export const MAX_VAULT_TOKENS = VAULT_TOKENS.length;
/** Starknet contract addresses lie below 2^251, inside the field. */
const CONTRACT_ADDRESS_BOUND = 1n << 251n;

type WalletEnvironment = Record<string, string | boolean | undefined>;

export function usesProductionWallet(environment: WalletEnvironment): boolean {
  return environment.PROD === true || environment.VITE_WALLET_MODE === 'real';
}

/**
 * The live route policy this build actually admits, or `null` when this build
 * does not construct a production wallet at all.
 *
 * `null` means "no restriction beyond the privacy register" — the answer a
 * demo build and the test runner both need, since neither one ever builds a
 * `WalletRoutePolicy` for a route to be disabled by. Mirrors
 * `usesProductionWallet`'s own definition of production so this can never
 * disagree with whether the game bothered to build a policy in the first
 * place. Split from `detectRoutePolicy` so the fail-closed branch — no
 * `import.meta.env` at all — stays reachable from a test (mirrors
 * `../privacy/build-context.ts`).
 */
export function routePolicyFrom(environment: WalletEnvironment | undefined): WalletSessionOptions['policy'] | null {
  if (!environment || !usesProductionWallet(environment)) return null;
  return parseRoutePolicy(environment);
}

export function detectRoutePolicy(): WalletSessionOptions['policy'] | null {
  return routePolicyFrom((import.meta as ImportMeta & { env?: WalletEnvironment }).env);
}

/** Parse only public browser configuration; secrets are never accepted here. */
export function parseProductionWalletConfig(
  environment: WalletEnvironment,
): WalletSessionOptions {
  if (environment.VITE_STARKNET_CHAIN_ID !== MAINNET_NAME) {
    throw new Error('STRKWORLD wallet configuration requires SN_MAIN.');
  }
  const rpcUrl = required(environment.VITE_STARKNET_RPC_URL, 'VITE_STARKNET_RPC_URL');
  const rpc = new URL(rpcUrl);
  if (rpc.protocol !== 'https:' || rpc.username || rpc.password) {
    throw new Error('STRKWORLD wallet RPC configuration is invalid.');
  }
  const backendBaseUrl = required(
    environment.VITE_BACKEND_BASE_URL,
    'VITE_BACKEND_BASE_URL',
  );
  if (backendBaseUrl !== '/api') {
    throw new Error('STRKWORLD wallet backend must use the same-origin /api path.');
  }

  return Object.freeze({
    rpcUrl: rpc.toString().replace(/\/$/, ''),
    backendBaseUrl,
    expectedChainId: MAINNET_CHAIN_ID,
    policy: parseRoutePolicy(environment),
  });
}

/**
 * A browser build may opt into explicitly approved route tuples. Any missing,
 * malformed, zero or disabled value keeps that route denied. The backend has
 * an independent allowlist and fee ceiling; these values are public admission
 * policy, never credentials.
 *
 * Exported so the Shell's route resolution (`panels/routes.ts`) can ask what
 * this exact build actually admits, instead of only what the privacy register
 * approves — those are different questions (D-054/D-056), and conflating them
 * is how the Bank ended up offering an Unshield tab production can never open.
 */
export function parseRoutePolicy(environment: WalletEnvironment): WalletSessionOptions['policy'] {
  const shield = parseShieldRoute(environment);
  const unshield = parseUnshieldRoute(environment);
  const transfer = parseTransferRoute(environment);
  const stake = parseStakeRoute(environment);
  const vault = parseVaultRoute(environment);
  const enabledRoutes: Array<'shield' | 'unshield' | 'transfer' | 'stake' | 'vault'> = [];
  const shieldTokens: string[] = [];
  const unshieldTokens: string[] = [];
  const transferTokens: string[] = [];
  // The policy has one intent bound for every route and one relay-fee ceiling
  // that the Wallet API adapter checks every relay quote against. Where
  // several routes are enabled, the strictest configured bound wins.
  const intentBounds: number[] = [];
  const relayFeeCeilings: bigint[] = [];

  if (shield) {
    enabledRoutes.push('shield');
    intentBounds.push(shield.maxIntents);
    shieldTokens.push(...shield.allowedTokens);
  }
  if (unshield) {
    enabledRoutes.push('unshield');
    intentBounds.push(unshield.maxIntents);
    relayFeeCeilings.push(unshield.maxRelayFee);
    unshieldTokens.push(...unshield.allowedTokens);
  }
  if (transfer) {
    enabledRoutes.push('transfer');
    intentBounds.push(transfer.maxIntents);
    relayFeeCeilings.push(transfer.maxRelayFee);
    transferTokens.push(...transfer.allowedTokens);
  }
  if (stake) {
    // The adapter prepares a stake one at a time, so staking adds no intent
    // bound: enabling it never narrows another route's batch size.
    enabledRoutes.push('stake');
    relayFeeCeilings.push(stake.maxRelayFee);
  }
  if (vault) {
    // D-077: the wallet submits the Vault itself, like shield, and it is
    // prepared one action at a time: no intent bound and no relay-fee
    // authority, so enabling it narrows nothing else.
    enabledRoutes.push('vault');
  }
  if (enabledRoutes.length === 0) return denyAllPolicy();

  return Object.freeze({
    maxIntents: intentBounds.length > 0 ? Math.min(...intentBounds) : 1,
    // Shield alone is not relayed and keeps no relay-fee authority.
    maxRelayFee: relayFeeCeilings.reduce((lowest, ceiling) => (ceiling < lowest ? ceiling : lowest), relayFeeCeilings[0] ?? 0n),
    enabledRoutes: Object.freeze(enabledRoutes),
    allowedTokens: Object.freeze({
      shield: Object.freeze(shieldTokens),
      unshield: Object.freeze(unshieldTokens),
      transfer: Object.freeze(transferTokens),
      swap: Object.freeze([]),
      // Present only when staking is enabled: the adapter reads an absent list
      // as "nothing admitted" and requires a present one to name both tokens.
      ...(stake ? { stake: Object.freeze(stake.allowedTokens) } : {}),
      // D-077: present only when the Vault is enabled; since D-079 any tokens
      // with a pinned vault, in the order given.
      ...(vault ? { vault: Object.freeze(vault.allowedTokens) } : {}),
    }),
  });
}

interface ParsedTransferRoute {
  maxIntents: number;
  maxRelayFee: bigint;
  allowedTokens: string[];
}

function parseTransferRoute(environment: WalletEnvironment): ParsedTransferRoute | null {
  if (environment.VITE_STRK20_TRANSFER_ENABLED !== 'true') return null;
  const maxIntents = parsePositiveSafeInteger(environment.VITE_STRK20_TRANSFER_MAX_INTENTS);
  const maxRelayFee = parsePositiveBigint(environment.VITE_STRK20_TRANSFER_MAX_RELAY_FEE, MAX_U128);
  const allowedTokens = parseAllowedTokens(environment.VITE_STRK20_TRANSFER_ALLOWED_TOKENS);
  if (maxIntents === null || maxRelayFee === null || allowedTokens === null) return null;
  return { maxIntents, maxRelayFee, allowedTokens };
}

/**
 * D-062: the pool-native unshield route. The private-submission backend
 * relays it like transfer, so it takes transfer's four values. It admits
 * canonical STRK only (shield did too, until D-072). Missing, zero, malformed,
 * partial or disabled values keep unshield denied without touching any other
 * route, and enabling it enables nothing else.
 */
function parseUnshieldRoute(environment: WalletEnvironment): ParsedTransferRoute | null {
  if (environment.VITE_STRK20_UNSHIELD_ENABLED !== 'true') return null;
  const maxIntents = parsePositiveSafeInteger(environment.VITE_STRK20_UNSHIELD_MAX_INTENTS);
  const maxRelayFee = parsePositiveBigint(environment.VITE_STRK20_UNSHIELD_MAX_RELAY_FEE, MAX_U128);
  const allowedTokens = parseAllowedTokens(environment.VITE_STRK20_UNSHIELD_ALLOWED_TOKENS);
  if (maxIntents === null || maxRelayFee === null || allowedTokens === null || !isStrkOnly(allowedTokens)) {
    return null;
  }
  return { maxIntents, maxRelayFee, allowedTokens };
}

/**
 * D-063: Endur staking, relayed by the private-submission backend like swap.
 * It admits exactly STRK in and xSTRK out, in either order, and a positive
 * relay-fee ceiling. Missing, zero, malformed, partial or disabled values keep
 * staking denied without touching any other route; enabling it enables
 * nothing else. The backend's BACKEND_ROUTE_STAKE_* block gates it separately.
 */
function parseStakeRoute(environment: WalletEnvironment): { maxRelayFee: bigint; allowedTokens: string[] } | null {
  if (environment.VITE_STRK20_STAKE_ENABLED !== 'true') return null;
  const maxRelayFee = parsePositiveBigint(environment.VITE_STRK20_STAKE_MAX_RELAY_FEE, MAX_U128);
  const allowedTokens = parseAllowedTokens(environment.VITE_STRK20_STAKE_ALLOWED_TOKENS);
  if (maxRelayFee === null || allowedTokens === null || !isStakePair(allowedTokens)) return null;
  return { maxRelayFee, allowedTokens };
}

/**
 * D-077: the Vault, Vesu lending from the player's STRK20 shadow account. The
 * wallet proves and submits it (no relay, so no relay-fee ceiling and no
 * backend route group). It needs `VITE_STRK20_VAULT_ENABLED=true` and a
 * `VITE_STRK20_VAULT_ALLOWED_TOKENS` list, widened by D-079 from STRK alone
 * the way D-072 widened shield's: one to `MAX_VAULT_TOKENS` canonical token
 * addresses (`0x` and 1 to 64 hex digits), no two with the same field value,
 * every one in `VAULT_TOKENS`, in the order given. A missing, zero,
 * malformed, repeated, oversized, unpinned, partial or disabled value keeps
 * the whole Vault locked, as D-007's facade, without touching any other
 * route; enabling it enables nothing else.
 */
function parseVaultRoute(environment: WalletEnvironment): { allowedTokens: string[] } | null {
  if (environment.VITE_STRK20_VAULT_ENABLED !== 'true') return null;
  const allowedTokens = parseAllowedTokens(environment.VITE_STRK20_VAULT_ALLOWED_TOKENS);
  if (allowedTokens === null || !isVaultTokenList(allowedTokens)) return null;
  return { allowedTokens };
}

/**
 * One to `MAX_VAULT_TOKENS` tokens, each one the Vault pins a vault for.
 * `parseAllowedTokens` has already refused a malformed entry, zero and a
 * repeat by field value.
 */
function isVaultTokenList(tokens: readonly string[]): boolean {
  if (tokens.length === 0 || tokens.length > MAX_VAULT_TOKENS) return false;
  try {
    return tokens.every((token) => VAULT_TOKENS.some((pinned) => BigInt(pinned) === BigInt(token)));
  } catch {
    return false;
  }
}

/** Exactly STRK and xSTRK, compared by field-element value. */
function isStakePair(tokens: readonly string[]): boolean {
  if (tokens.length !== 2) return false;
  try {
    const values = new Set(tokens.map((token) => BigInt(token)));
    return values.has(BigInt(STRK_TOKEN)) && values.has(BigInt(XSTRK_TOKEN));
  } catch {
    return false;
  }
}

/**
 * D-056's pool-native shield route, widened by D-072 from canonical STRK to
 * any token: a non-empty list of at most `MAX_SHIELD_TOKENS` canonical token
 * addresses (`0x` and 1 to 64 hex digits, a contract address above zero and
 * below 2^251), no two with the same field value, in the order given. Shield
 * has no relay-fee variable or authority: the wallet submits it. A missing,
 * zero, malformed, duplicated, partial, oversized or disabled value keeps
 * shield denied, whole, without touching any other route.
 */
function parseShieldRoute(environment: WalletEnvironment): Pick<ParsedTransferRoute, 'maxIntents' | 'allowedTokens'> | null {
  if (environment.VITE_STRK20_SHIELD_ENABLED !== 'true') return null;
  const maxIntents = parsePositiveSafeInteger(environment.VITE_STRK20_SHIELD_MAX_INTENTS);
  const allowedTokens = parseAllowedTokens(environment.VITE_STRK20_SHIELD_ALLOWED_TOKENS);
  if (maxIntents === null || allowedTokens === null || !isShieldTokenList(allowedTokens)) return null;
  return { maxIntents, allowedTokens };
}

/**
 * One to `MAX_SHIELD_TOKENS` tokens, each a contract address. `parseAllowedTokens`
 * has already refused a malformed entry, zero and a repeat by field value.
 */
function isShieldTokenList(tokens: readonly string[]): boolean {
  if (tokens.length === 0 || tokens.length > MAX_SHIELD_TOKENS) return false;
  try {
    return tokens.every((token) => BigInt(token) < CONTRACT_ADDRESS_BOUND);
  } catch {
    return false;
  }
}

/** Exactly one admitted token, and it is canonical STRK by field-element value. */
function isStrkOnly(tokens: readonly string[]): boolean {
  if (tokens.length !== 1) return false;
  try {
    return BigInt(tokens[0]!) === BigInt(STRK_TOKEN);
  } catch {
    return false;
  }
}

function denyAllPolicy(): WalletSessionOptions['policy'] {
  const empty = (): readonly string[] => Object.freeze([]);
  return Object.freeze({
    maxIntents: 0,
    maxRelayFee: 0n,
    enabledRoutes: Object.freeze([]),
    allowedTokens: Object.freeze({
      shield: empty(),
      unshield: empty(),
      transfer: empty(),
      swap: empty(),
    }),
  });
}

function parsePositiveSafeInteger(value: string | boolean | undefined): number | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
  } catch {
    return null;
  }
}

function parsePositiveBigint(value: string | boolean | undefined, maximum: bigint): bigint | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= maximum ? parsed : null;
  } catch {
    return null;
  }
}

function parseAllowedTokens(value: string | boolean | undefined): string[] | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const tokens = value.split(',').map((token) => token.trim());
  if (tokens.some((token) => !/^0x[0-9a-fA-F]{1,64}$/.test(token))) return null;

  try {
    const numeric = tokens.map((token) => BigInt(token));
    if (numeric.some((token) => token <= 0n || token >= STARK_FIELD_PRIME)) return null;
    const identities = numeric.map((token) => token.toString(16));
    if (new Set(identities).size !== identities.length) return null;
    return tokens;
  } catch {
    return null;
  }
}

function required(value: string | boolean | undefined, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`STRKWORLD wallet configuration is missing ${name}.`);
  }
  return value.trim();
}
