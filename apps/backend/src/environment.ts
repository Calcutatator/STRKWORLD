import type { AvnuPaymasterOptions } from './avnu-paymaster.js';
import type { AvnuSwapQuotesOptions } from './avnu-swap-quotes.js';
import {
  DEGEN_MAX_CACHE_TTL_MS,
  DEGEN_MAX_MIN_DAILY_VOLUME_USD,
  DEGEN_MIN_CACHE_TTL_MS,
  DEGEN_TAGS,
} from './degen-catalog.js';
import { DEFAULT_POOL_VALUE_URL } from './pool-stats.js';
import type { StarknetRpcOptions } from './starknet-rpc.js';
import type { BackendConfig, DegenConfig, DegenTag, PrivateRoute, RoutePolicy } from './types.js';
import { isFelt } from './validation.js';

const MAINNET_CHAIN_ID = '0x534e5f4d41494e';
const MAX_U128 = (1n << 128n) - 1n;
const MAX_NODE_TIMEOUT_MS = 2_147_483_647;
const PLACEHOLDER = /(?:REPLACE(?:_|-|$)|PLACEHOLDER|CHANGE[_-]?ME|YOUR[_-])/i;

type Environment = Readonly<Record<string, string | undefined>>;

export interface ParsedBackendEnvironment {
  port: number;
  maxRequestBytes: number;
  backend: BackendConfig;
  paymaster: AvnuPaymasterOptions;
  rpc: StarknetRpcOptions;
  /** D-084: avnu's keyless public swap API, for the quote proxy. */
  swapQuotes: AvnuSwapQuotesOptions;
  authorizationSecret: string;
  /** D-080: the Privacy Plaza's external pool-value aggregate. */
  poolValue: { url: string };
}

/** Strict production configuration. Errors name variables but never their values. */
export function parseBackendEnvironment(environment: Environment): ParsedBackendEnvironment {
  const poolAddress = parseFelt(environment, 'STRK20_POOL_ADDRESS');
  const feeToken = parseFelt(environment, 'STRK20_FEE_TOKEN');
  const noteMaturityBlocks = parseInteger(environment, 'STRK20_NOTE_MATURITY_BLOCKS', 1);
  const transfer = parsePoolRoute(environment, 'TRANSFER');
  const unshield = parsePoolRoute(environment, 'UNSHIELD');
  const swap = parseSwapRoute(environment);
  const stake = parseStakeRoute(environment);
  const degen = parseDegenCatalog(environment);
  const rpcUrl = parseUrl(environment, 'STARKNET_RPC_URL');
  const paymasterBaseUrl = parseOptionalUrl(environment, 'AVNU_PAYMASTER_BASE_URL');
  const avnuBaseUrl = parseOptionalUrl(environment, 'AVNU_BASE_URL');
  // D-080: public, no key; strkprice.com's default applies when unset. https
  // only, like every other URL here (parseOptionalUrl), and fails closed on
  // a placeholder or malformed value rather than silently falling back.
  const poolValueUrl = parseOptionalUrl(environment, 'PLAZA_POOL_VALUE_URL') ?? DEFAULT_POOL_VALUE_URL;
  const requestTimeoutMs = parseInteger(environment, 'BACKEND_REQUEST_TIMEOUT_MS', 1, MAX_NODE_TIMEOUT_MS);
  requireDelayWithinDeadline(requestTimeoutMs, { transfer, unshield, ...(stake ? { stake } : {}) });

  return {
    port: parseInteger(environment, 'PORT', 1, 65_535),
    maxRequestBytes: parseInteger(environment, 'BACKEND_MAX_REQUEST_BYTES', 1),
    backend: {
      poolAddress,
      feeToken,
      maxCalldataItems: parseInteger(environment, 'BACKEND_MAX_CALLDATA_ITEMS', 1),
      maxProofBytes: parseInteger(environment, 'BACKEND_MAX_PROOF_BYTES', 1),
      requestTimeoutMs,
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
      routes: { transfer, unshield, swap, ...(stake ? { stake } : {}) },
      ...(degen ? { degen } : {}),
      debugLogsEnabled: parseDebugLogsEnabled(environment),
    },
    paymaster: {
      // D-068/D-070: optional at startup, but avnu refuses sponsored_private
      // without a Portal key, so relayed routes answer RELAY_NOT_CONFIGURED
      // until one is set. It is an access credential, not a budget: the relay
      // fee withdrawn in each private transaction still repays avnu. A key
      // stays server-side (D-014).
      ...optionalSecret(environment, 'AVNU_PAYMASTER_API_KEY', 'apiKey'),
      ...(paymasterBaseUrl ? { paymasterBaseUrl } : {}),
    },
    rpc: { rpcUrl, poolAddress, feeToken, noteMaturityBlocks },
    swapQuotes: {
      chainId: parseMainnetChainId(environment),
      ...(avnuBaseUrl ? { baseUrl: avnuBaseUrl } : {}),
    },
    authorizationSecret: parseSecret(environment, 'FEE_AUTHORIZATION_SECRET', 32),
    poolValue: { url: poolValueUrl },
  };
}

/** Time the relay needs after the delay to submit through the paymaster. */
export const RELAY_SUBMISSION_HEADROOM_MS = 5_000;

/**
 * Relayed routes submit as soon as they are validated (D-066): a zero queue
 * delay is the normal setting, not a placeholder, and is exempt here. A
 * nonzero delay remains possible, but it runs inside the request deadline, so
 * a delay the deadline cannot outlast turns into a 504 with nothing submitted
 * — after the player has already approved the proof (a 2026-09-27
 * privacy-audit finding: the example paired a 45 s delay with a 20 s
 * deadline). That is a startup error here, never a runtime surprise.
 */
function requireDelayWithinDeadline(
  requestTimeoutMs: number,
  routes: Readonly<Record<string, RoutePolicy>>,
): void {
  for (const [route, policy] of Object.entries(routes)) {
    if (!policy.enabled || policy.maxQueueDelayMs === 0) continue;
    if (policy.maxQueueDelayMs + RELAY_SUBMISSION_HEADROOM_MS > requestTimeoutMs) {
      throw new Error(
        `BACKEND_ROUTE_${route.toUpperCase()}_MAX_QUEUE_DELAY_MS must leave ${RELAY_SUBMISSION_HEADROOM_MS} ms of BACKEND_REQUEST_TIMEOUT_MS for submission.`,
      );
    }
  }
}

function parsePoolRoute(environment: Environment, name: 'TRANSFER' | 'UNSHIELD'): RoutePolicy {
  return {
    enabled: parseBoolean(environment, `BACKEND_ROUTE_${name}_ENABLED`),
    maxRelayFee: parseUnsignedBigint(environment, `BACKEND_ROUTE_${name}_MAX_RELAY_FEE`, MAX_U128),
    // Zero, no artificial delay, is the D-066 setting.
    maxQueueDelayMs: parseInteger(
      environment,
      `BACKEND_ROUTE_${name}_MAX_QUEUE_DELAY_MS`,
      0,
      MAX_NODE_TIMEOUT_MS,
    ),
    quoteBound: false,
    allowedTokens: parseAllowedTokens(environment, `BACKEND_ROUTE_${name}_ALLOWED_TOKENS`),
  };
}

/**
 * The swap route (D-084): it is never relayed, so it has no relay fee and no
 * queue; it admits the tokens the quote proxy may quote, and caps the
 * slippage a quote may ask for. `BACKEND_ROUTE_SWAP_MAX_RELAY_FEE` and
 * `BACKEND_ROUTE_SWAP_MAX_QUEUE_DELAY_MS` are no longer read.
 */
function parseSwapRoute(environment: Environment): RoutePolicy {
  return {
    enabled: parseBoolean(environment, 'BACKEND_ROUTE_SWAP_ENABLED'),
    maxRelayFee: 0n,
    maxQueueDelayMs: 0,
    quoteBound: true,
    allowedTokens: parseAllowedTokens(environment, 'BACKEND_ROUTE_SWAP_ALLOWED_TOKENS'),
    // D-084: at most 3%, so the floor the chain enforces stays within 6% of the oracle.
    maxSlippageBps: parseInteger(environment, 'BACKEND_ROUTE_SWAP_MAX_SLIPPAGE_BPS', 1, 300),
  };
}

const STAKE_ROUTE_VARIABLES = [
  'BACKEND_ROUTE_STAKE_MAX_RELAY_FEE',
  'BACKEND_ROUTE_STAKE_MAX_QUEUE_DELAY_MS',
  'BACKEND_ROUTE_STAKE_ALLOWED_TOKENS',
] as const;

/**
 * Endur staking (D-063), disabled by default. Without
 * `BACKEND_ROUTE_STAKE_ENABLED` the route is absent, and any other stake
 * variable is a startup error rather than a silently ignored half
 * configuration. Once it is set, every stake variable is required and strictly
 * validated as for the other routes. Not quote-bound, so like transfer and
 * unshield it takes the ordinary submission queue, with zero artificial delay
 * as the normal setting (D-066); the pinned STRK-only allowlist is enforced
 * when the `BackendApi` validates its configuration.
 */
function parseStakeRoute(environment: Environment): RoutePolicy | undefined {
  if (isUnset(environment.BACKEND_ROUTE_STAKE_ENABLED)) {
    if (STAKE_ROUTE_VARIABLES.some((name) => !isUnset(environment[name]))) {
      throw new Error('Missing required BACKEND_ROUTE_STAKE_ENABLED.');
    }
    return undefined;
  }
  return {
    enabled: parseBoolean(environment, 'BACKEND_ROUTE_STAKE_ENABLED'),
    maxRelayFee: parseUnsignedBigint(environment, 'BACKEND_ROUTE_STAKE_MAX_RELAY_FEE', MAX_U128),
    maxQueueDelayMs: parseInteger(
      environment,
      'BACKEND_ROUTE_STAKE_MAX_QUEUE_DELAY_MS',
      0,
      MAX_NODE_TIMEOUT_MS,
    ),
    quoteBound: false,
    allowedTokens: parseAllowedTokens(environment, 'BACKEND_ROUTE_STAKE_ALLOWED_TOKENS'),
  };
}

const DEGEN_CATALOG_VARIABLES = [
  'BACKEND_DEGEN_TAGS',
  'BACKEND_DEGEN_MIN_DAILY_VOLUME_USD',
  'BACKEND_DEGEN_CACHE_TTL_MS',
] as const;

/**
 * The degen floor's catalog (D-067), off by default, in the stake route's
 * pattern. Without `BACKEND_DEGEN_ENABLED` it is absent and the swap route
 * admits only its own allowlist; any other degen variable is then a startup
 * error rather than a silently ignored half configuration. Once it is set,
 * every degen variable is required: a non-empty, duplicate-free subset of
 * avnu's `Verified`, `Community`, `Unruggable` and `AVNU` tags (`Unknown` is
 * never admissible), a positive whole-dollar daily-volume floor, and a cache
 * lifetime of one minute to one day. It widens an enabled swap route only; it
 * never enables swap.
 */
function parseDegenCatalog(environment: Environment): DegenConfig | undefined {
  if (isUnset(environment.BACKEND_DEGEN_ENABLED)) {
    if (DEGEN_CATALOG_VARIABLES.some((name) => !isUnset(environment[name]))) {
      throw new Error('Missing required BACKEND_DEGEN_ENABLED.');
    }
    return undefined;
  }
  return {
    enabled: parseBoolean(environment, 'BACKEND_DEGEN_ENABLED'),
    tags: parseDegenTags(environment, 'BACKEND_DEGEN_TAGS'),
    minDailyVolumeUsd: parseInteger(
      environment,
      'BACKEND_DEGEN_MIN_DAILY_VOLUME_USD',
      1,
      DEGEN_MAX_MIN_DAILY_VOLUME_USD,
    ),
    cacheTtlMs: parseInteger(
      environment,
      'BACKEND_DEGEN_CACHE_TTL_MS',
      DEGEN_MIN_CACHE_TTL_MS,
      DEGEN_MAX_CACHE_TTL_MS,
    ),
  };
}

/**
 * Opt-in debug logs for a test deployment (D-069), fail-closed: unset or
 * empty is off, and only exactly `true` turns them on. Any other value fails
 * startup like every other switch, so a typo can never half-enable them.
 * Never set for a launch.
 */
function parseDebugLogsEnabled(environment: Environment): boolean {
  if (isUnset(environment.BACKEND_DEBUG_LOGS_ENABLED)) return false;
  return parseBoolean(environment, 'BACKEND_DEBUG_LOGS_ENABLED');
}

function parseDegenTags(environment: Environment, name: string): readonly DegenTag[] {
  const tags = readRequired(environment, name).split(',').map((tag) => tag.trim());
  if (
    tags.some((tag) => !(DEGEN_TAGS as readonly string[]).includes(tag)) ||
    new Set(tags).size !== tags.length
  ) {
    throw new Error(`Invalid ${name}.`);
  }
  return Object.freeze(tags as DegenTag[]);
}

function isUnset(value: string | undefined): boolean {
  return value === undefined || value === '';
}

function readRequired(environment: Environment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new Error(`Missing required ${name}.`);
  if (value !== value.trim() || PLACEHOLDER.test(value)) throw new Error(`Invalid ${name}.`);
  return value;
}

/** An absent or empty secret is omitted; a present one is validated like any other. */
function optionalSecret<K extends string>(
  environment: Environment,
  name: string,
  key: K,
): Partial<Record<K, string>> {
  if (isUnset(environment[name])) return {};
  return { [key]: parseSecret(environment, name, 1) } as Partial<Record<K, string>>;
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
