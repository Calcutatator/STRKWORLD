import type { AvnuPaymasterOptions } from './avnu-paymaster.js';
import type { AvnuSwapPlannerOptions } from './avnu-swap-planner.js';
import type { StarknetRpcOptions } from './starknet-rpc.js';
import type { BackendConfig, PrivateRoute, RoutePolicy } from './types.js';
import { isFelt } from './validation.js';

const MAINNET_CHAIN_ID = '0x534e5f4d41494e';
const MAX_U128 = (1n << 128n) - 1n;
const PLACEHOLDER = /(?:REPLACE(?:_|-|$)|PLACEHOLDER|CHANGE[_-]?ME|YOUR[_-])/i;

type Environment = Readonly<Record<string, string | undefined>>;

export interface ParsedBackendEnvironment {
  port: number;
  maxRequestBytes: number;
  backend: BackendConfig;
  paymaster: AvnuPaymasterOptions;
  rpc: StarknetRpcOptions;
  swapPlanner: AvnuSwapPlannerOptions;
  authorizationSecret: string;
}

/** Strict production configuration. Errors name variables but never their values. */
export function parseBackendEnvironment(environment: Environment): ParsedBackendEnvironment {
  const poolAddress = parseFelt(environment, 'STRK20_POOL_ADDRESS');
  const feeToken = parseFelt(environment, 'STRK20_FEE_TOKEN');
  const noteMaturityBlocks = parseInteger(environment, 'STRK20_NOTE_MATURITY_BLOCKS', 1);
  const transfer = parsePoolRoute(environment, 'TRANSFER');
  const unshield = parsePoolRoute(environment, 'UNSHIELD');
  const swap = parseSwapRoute(environment);
  const rpcUrl = parseUrl(environment, 'STARKNET_RPC_URL');
  const paymasterBaseUrl = parseOptionalUrl(environment, 'AVNU_PAYMASTER_BASE_URL');
  const avnuBaseUrl = parseOptionalUrl(environment, 'AVNU_BASE_URL');

  return {
    port: parseInteger(environment, 'PORT', 1, 65_535),
    maxRequestBytes: parseInteger(environment, 'BACKEND_MAX_REQUEST_BYTES', 1),
    backend: {
      poolAddress,
      feeToken,
      maxCalldataItems: parseInteger(environment, 'BACKEND_MAX_CALLDATA_ITEMS', 1),
      maxProofBytes: parseInteger(environment, 'BACKEND_MAX_PROOF_BYTES', 1),
      requestTimeoutMs: parseInteger(environment, 'BACKEND_REQUEST_TIMEOUT_MS', 1),
      globalEnabled: parseBoolean(environment, 'BACKEND_GLOBAL_ENABLED'),
      rateLimit: {
        maxRequests: parseInteger(environment, 'BACKEND_RATE_LIMIT_MAX_REQUESTS', 1),
        windowMs: parseInteger(environment, 'BACKEND_RATE_LIMIT_WINDOW_MS', 1),
      },
      sponsorshipBudget: {
        maxFeeAmount: parseUnsignedBigint(
          environment,
          'BACKEND_SPONSORSHIP_MAX_FEE_AMOUNT',
          MAX_U128,
        ),
        windowMs: parseInteger(environment, 'BACKEND_SPONSORSHIP_WINDOW_MS', 1),
      },
      submissionQueue: {
        maxInFlight: parseInteger(environment, 'BACKEND_QUEUE_MAX_IN_FLIGHT', 1),
        maxQueued: parseInteger(environment, 'BACKEND_QUEUE_MAX_QUEUED', 0),
      },
      routes: { transfer, unshield, swap },
    },
    paymaster: {
      apiKey: parseSecret(environment, 'AVNU_PAYMASTER_API_KEY', 1),
      ...(paymasterBaseUrl ? { paymasterBaseUrl } : {}),
    },
    rpc: { rpcUrl, poolAddress, feeToken, noteMaturityBlocks },
    swapPlanner: {
      chainId: parseMainnetChainId(environment),
      ...(avnuBaseUrl ? { baseUrl: avnuBaseUrl } : {}),
    },
    authorizationSecret: parseSecret(environment, 'FEE_AUTHORIZATION_SECRET', 32),
  };
}

function parsePoolRoute(environment: Environment, name: 'TRANSFER' | 'UNSHIELD'): RoutePolicy {
  return {
    enabled: parseBoolean(environment, `BACKEND_ROUTE_${name}_ENABLED`),
    maxRelayFee: parseUnsignedBigint(environment, `BACKEND_ROUTE_${name}_MAX_RELAY_FEE`, MAX_U128),
    maxQueueDelayMs: parseInteger(environment, `BACKEND_ROUTE_${name}_MAX_QUEUE_DELAY_MS`, 1),
    quoteBound: false,
    allowedTokens: parseAllowedTokens(environment, `BACKEND_ROUTE_${name}_ALLOWED_TOKENS`),
  };
}

function parseSwapRoute(environment: Environment): RoutePolicy {
  return {
    enabled: parseBoolean(environment, 'BACKEND_ROUTE_SWAP_ENABLED'),
    maxRelayFee: parseUnsignedBigint(environment, 'BACKEND_ROUTE_SWAP_MAX_RELAY_FEE', MAX_U128),
    maxQueueDelayMs: parseInteger(environment, 'BACKEND_ROUTE_SWAP_MAX_QUEUE_DELAY_MS', 0, 0),
    quoteBound: true,
    allowedTokens: parseAllowedTokens(environment, 'BACKEND_ROUTE_SWAP_ALLOWED_TOKENS'),
    maxSlippageBps: parseInteger(environment, 'BACKEND_ROUTE_SWAP_MAX_SLIPPAGE_BPS', 1, 1_000),
  };
}

function readRequired(environment: Environment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new Error(`Missing required ${name}.`);
  if (value !== value.trim() || PLACEHOLDER.test(value)) throw new Error(`Invalid ${name}.`);
  return value;
}

function parseSecret(environment: Environment, name: string, minimumLength: number): string {
  const value = readRequired(environment, name);
  if (value.length < minimumLength) throw new Error(`Invalid ${name}.`);
  return value;
}

function parseInteger(
  environment: Environment,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = readRequired(environment, name);
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid ${name}.`);
  const parsed = BigInt(value);
  if (parsed < BigInt(minimum) || parsed > BigInt(maximum)) throw new Error(`Invalid ${name}.`);
  return Number(parsed);
}

function parseUnsignedBigint(environment: Environment, name: string, maximum: bigint): bigint {
  const value = readRequired(environment, name);
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid ${name}.`);
  const parsed = BigInt(value);
  if (parsed > maximum) throw new Error(`Invalid ${name}.`);
  return parsed;
}

function parseBoolean(environment: Environment, name: string): boolean {
  const value = readRequired(environment, name);
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid ${name}.`);
}

function parseFelt(environment: Environment, name: string): string {
  const value = readRequired(environment, name);
  if (!isFelt(value) || BigInt(value) === 0n) throw new Error(`Invalid ${name}.`);
  return value;
}

function parseAllowedTokens(environment: Environment, name: string): readonly string[] {
  const value = readRequired(environment, name);
  const tokens = value.split(',').map((token) => token.trim());
  if (tokens.some((token) => !isFelt(token) || BigInt(token) === 0n)) {
    throw new Error(`Invalid ${name}.`);
  }
  const normalized = tokens.map((token) => BigInt(token).toString(16));
  if (new Set(normalized).size !== tokens.length) throw new Error(`Invalid ${name}.`);
  return tokens;
}

function parseUrl(environment: Environment, name: string): string {
  return validateUrl(readRequired(environment, name), name);
}

function parseOptionalUrl(environment: Environment, name: string): string | undefined {
  const value = environment[name];
  if (value === undefined || value === '') return undefined;
  if (value !== value.trim() || PLACEHOLDER.test(value)) throw new Error(`Invalid ${name}.`);
  return validateUrl(value, name);
}

function validateUrl(value: string, name: string): string {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

function parseMainnetChainId(environment: Environment): string {
  const value = readRequired(environment, 'STARKNET_CHAIN_ID');
  if (value === 'SN_MAIN' || value.toLowerCase() === MAINNET_CHAIN_ID) return MAINNET_CHAIN_ID;
  throw new Error('Invalid STARKNET_CHAIN_ID.');
}

export type { Environment };
