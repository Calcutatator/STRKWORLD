import type { WalletSessionOptions } from '@strkworld/privacy';

const MAINNET_NAME = 'SN_MAIN';
const MAINNET_CHAIN_ID = '0x534e5f4d41494e';
const MAX_U128 = (1n << 128n) - 1n;
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const STRK_TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

type WalletEnvironment = Record<string, string | boolean | undefined>;

export function usesProductionWallet(environment: WalletEnvironment): boolean {
  return environment.PROD === true || environment.VITE_WALLET_MODE === 'real';
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
 */
function parseRoutePolicy(environment: WalletEnvironment): WalletSessionOptions['policy'] {
  const transfer = parseTransferRoute(environment);
  const shield = parseShieldRoute(environment);
  const enabledRoutes: Array<'shield' | 'transfer'> = [];
  const shieldTokens: string[] = [];
  const transferTokens: string[] = [];
  let maxIntents = 0;
  let maxRelayFee = 0n;

  if (shield) {
    enabledRoutes.push('shield');
    maxIntents = shield.maxIntents;
    shieldTokens.push(...shield.allowedTokens);
  }
  if (transfer) {
    enabledRoutes.push('transfer');
    maxIntents = maxIntents === 0 ? transfer.maxIntents : Math.min(maxIntents, transfer.maxIntents);
    maxRelayFee = transfer.maxRelayFee;
    transferTokens.push(...transfer.allowedTokens);
  }
  if (enabledRoutes.length === 0) return denyAllPolicy();

  return Object.freeze({
    maxIntents,
    maxRelayFee,
    enabledRoutes: Object.freeze(enabledRoutes),
    allowedTokens: Object.freeze({
      shield: Object.freeze(shieldTokens),
      unshield: Object.freeze([]),
      transfer: Object.freeze(transferTokens),
      swap: Object.freeze([]),
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

function parseShieldRoute(environment: WalletEnvironment): Pick<ParsedTransferRoute, 'maxIntents' | 'allowedTokens'> | null {
  if (environment.VITE_STRK20_SHIELD_ENABLED !== 'true') return null;
  const maxIntents = parsePositiveSafeInteger(environment.VITE_STRK20_SHIELD_MAX_INTENTS);
  const allowedTokens = parseAllowedTokens(environment.VITE_STRK20_SHIELD_ALLOWED_TOKENS);
  if (maxIntents === null || allowedTokens === null || allowedTokens.length !== 1) return null;
  try {
    if (BigInt(allowedTokens[0]!) !== BigInt(STRK_TOKEN)) return null;
  } catch {
    return null;
  }
  return { maxIntents, allowedTokens };
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
