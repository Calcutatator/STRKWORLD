import { AVNU_SWAP_MAX_CALLDATA } from './avnu-swap-quotes.js';
import { BORROW_MARKET_PATH, BORROW_POSITION_PATH } from './borrow.js';
import { DEBUG_LOGS_PATH, DebugLogSink } from './debug-logs.js';
import type { LeaderboardService } from './leaderboard.js';
import { SWAP_DEGEN_MAX_SLIPPAGE_BPS, publicDegenToken, validateDegenConfig } from './degen-catalog.js';
import { ENDUR_XSTRK_ASSET } from './endur.js';
import {
  AggregateBudget,
  AggregateMetrics,
  AggregateRateLimiter,
  type RequestRateLimiterPort,
  type SponsorshipBudgetPort,
} from './metrics.js';
import { PerClientRateLimiter } from './client-key.js';
import { POOL_STATS_RATE_LIMIT } from './pool-stats.js';
import {
  RELAY_NOT_CONFIGURED_CODE,
  RELAY_NOT_CONFIGURED_MESSAGE,
  RelayNotConfiguredError,
  refusedRelayRoutes,
} from './relay.js';
import { validateServerActionRoute } from './server-actions.js';
import {
  BoundedSubmissionQueue,
  SubmissionQueueFullError,
  type SubmissionQueuePort,
} from './submission-queue.js';
import type {
  ApiRequest,
  ApiResponse,
  AuthorizationCodec,
  BackendConfig,
  BorrowRpcPort,
  DegenCatalogPort,
  FeeAuthorizationClaims,
  PaymasterPort,
  PoolRpcPort,
  PoolStatsPort,
  PrivateRoute,
  RelayRoute,
  RoutePolicy,
  SwapQuotePort,
  VaultRatesPort,
  VaultRpcPort,
  EndurRpcPort,
} from './types.js';
import { VAULT_POSITION_PATH, VAULT_RATES_PATH, VAULT_SHADOW_ACCOUNT_PATH } from './vault.js';
import { ENDUR_RATE_PATH, ENDUR_UNSTAKE_PATH } from './endur.js';
import {
  ApiFailure,
  isFelt,
  requireFelt,
  requireNonzeroFelt,
  requirePositiveInteger,
  requireRecord,
  requireRoute,
  requireVersion,
  sameAddress,
  validateArtifact,
} from './validation.js';

const MAX_NODE_TIMEOUT_MS = 2_147_483_647;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAINNET_CHAIN_ID = '0x534e5f4d41494e';
/** The degen floor's token list (D-067): the one GET route, and it reads nothing from the request. */
export const DEGEN_TOKENS_PATH = '/v1/degen/tokens';
/** The Privacy Plaza's public pool stats (D-076): aggregates from the background cache. */
export const POOL_STATS_PATH = '/v1/rpc/pool-stats';
/** The private swap's keyless quote proxy (D-084). */
export const SWAP_QUOTE_PATH = '/v1/swap/quote';
/**
 * The quote proxy's own aggregate window (D-084), besides a slot in the
 * shared one: every request is two to avnu's public API, which rate-limits
 * by caller, and this service is one caller for every player.
 */
export const SWAP_QUOTE_RATE_LIMIT = Object.freeze({ maxRequests: 60, windowMs: 60_000 });
/**
 * Each client's own quote bucket (D-084): 10 at once, one more every 6 s, so
 * no one client can spend the shared window for everyone. Keyed by a salted
 * hash of the client's address (`client-key.ts`), held in memory, never logged.
 */
export const SWAP_QUOTE_CLIENT_RATE_LIMIT = Object.freeze({ capacity: 10, refillMs: 6_000 });
/** The most a swap may sell: a pool note holds a u128. */
const U128_BOUND = 1n << 128n;
/** Starknet contract addresses lie below 2^251. */
const CONTRACT_ADDRESS_BOUND = 1n << 251n;

export interface BackendApiOptions {
  config: BackendConfig;
  paymaster: PaymasterPort;
  rpc: PoolRpcPort;
  authorizations: AuthorizationCodec;
  randomInt?: (maxInclusive: number) => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** avnu's keyless swap quotes (D-084). Without it, the quote route answers 503. */
  swapQuotes?: SwapQuotePort;
  /** The backend's own degen list (D-067). Without it, degen mode stays off whatever the config says. */
  degenCatalog?: DegenCatalogPort;
  /** The Privacy Plaza's cached pool stats (D-076). Without it, that route answers 503. */
  poolStats?: PoolStatsPort;
  rateLimiter?: RequestRateLimiterPort;
  /** The pool-stats route's own rate window (D-076), apart from `rateLimiter`'s. */
  poolStatsRateLimiter?: RequestRateLimiterPort;
  /** The swap quote route's own window (D-084), taken besides a slot in `rateLimiter`'s. */
  swapQuoteRateLimiter?: RequestRateLimiterPort;
  /** Each client's own quote bucket (D-084), taken before the route's window. */
  swapQuoteClientRateLimiter?: PerClientRateLimiter;
  /** The Vault's two pinned public reads (D-077). Without it, both routes answer 503. */
  vault?: VaultRpcPort;
  /** Vesu's supply APY for the pinned vaults (D-079). Without it, that route answers 503. */
  vaultRates?: VaultRatesPort;
  /** The Borrow counter's two pinned public reads (D-083). Without it, both routes answer 503. */
  borrow?: BorrowRpcPort;
  /** Endur unstaking's pinned reads (D-085). Without it, that route answers 503. */
  endur?: EndurRpcPort;
  sponsorshipBudget?: SponsorshipBudgetPort;
  submissionQueue?: SubmissionQueuePort;
  /**
   * The opt-in debug sink (D-069). Reachable only while
   * `config.debugLogsEnabled` is true; by default it writes to stdout.
   */
  debugLogs?: DebugLogSink;
  /**
   * Leaderboard phase 1's blind tally. Reachable only while
   * `config.leaderboard` is set; otherwise its paths are unknown.
   */
  leaderboard?: LeaderboardService;
}

export class BackendApi {
  readonly metrics = new AggregateMetrics();
  private readonly limiter: RequestRateLimiterPort;
  private readonly poolStatsLimiter: RequestRateLimiterPort;
  private readonly swapQuoteLimiter: RequestRateLimiterPort;
  private readonly swapQuoteClientLimiter: PerClientRateLimiter;
  private readonly config: BackendConfig;
  private readonly requestTimeoutMs: number;
  private readonly paymaster: PaymasterPort;
  private readonly rpc: PoolRpcPort;
  private readonly authorizations: AuthorizationCodec;
  private readonly randomInt: (maxInclusive: number) => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly swapQuotes?: SwapQuotePort;
  private readonly degenCatalog?: DegenCatalogPort;
  private readonly poolStatsPort?: PoolStatsPort;
  private readonly vault?: VaultRpcPort;
  private readonly vaultRates?: VaultRatesPort;
  private readonly borrow?: BorrowRpcPort;
  private readonly endur?: EndurRpcPort;
  private readonly clockNow: () => number;
  private readonly budget: SponsorshipBudgetPort;
  private readonly submissionQueue: SubmissionQueuePort;
  private readonly debugLogs: DebugLogSink;
  private readonly leaderboard?: LeaderboardService;

  constructor(options: BackendApiOptions) {
    validateBackendConfig(options.config);
    this.config = options.config;
    this.requestTimeoutMs = options.config.requestTimeoutMs;
    this.paymaster = options.paymaster;
    this.rpc = options.rpc;
    this.authorizations = options.authorizations;
    this.randomInt = options.randomInt ?? ((max) => Math.floor(Math.random() * (max + 1)));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.swapQuotes = options.swapQuotes;
    this.degenCatalog = options.degenCatalog;
    this.poolStatsPort = options.poolStats;
    this.vault = options.vault;
    this.vaultRates = options.vaultRates;
    this.borrow = options.borrow;
    this.endur = options.endur;
    const now = options.now ?? Date.now;
    this.clockNow = now;
    this.limiter = options.rateLimiter ?? new AggregateRateLimiter(
      this.config.rateLimit.maxRequests, this.config.rateLimit.windowMs, now,
    );
    this.poolStatsLimiter = options.poolStatsRateLimiter ?? new AggregateRateLimiter(
      POOL_STATS_RATE_LIMIT.maxRequests, POOL_STATS_RATE_LIMIT.windowMs, now,
    );
    this.swapQuoteLimiter = options.swapQuoteRateLimiter ?? new AggregateRateLimiter(
      SWAP_QUOTE_RATE_LIMIT.maxRequests, SWAP_QUOTE_RATE_LIMIT.windowMs, now,
    );
    this.swapQuoteClientLimiter = options.swapQuoteClientRateLimiter ?? new PerClientRateLimiter(
      SWAP_QUOTE_CLIENT_RATE_LIMIT.capacity, SWAP_QUOTE_CLIENT_RATE_LIMIT.refillMs, now,
    );
    this.budget = options.sponsorshipBudget ?? new AggregateBudget(
      this.config.sponsorshipBudget.maxFeeAmount, this.config.sponsorshipBudget.windowMs, now,
    );
    this.submissionQueue = options.submissionQueue ?? new BoundedSubmissionQueue(
      this.config.submissionQueue.maxInFlight,
      this.config.submissionQueue.maxQueued,
    );
    this.debugLogs = options.debugLogs ?? new DebugLogSink({ now });
    this.leaderboard = options.config.leaderboard ? options.leaderboard : undefined;
  }

  async handle(request: ApiRequest): Promise<ApiResponse> {
    // D-069: the opt-in debug sink stands apart from the private routes. It
    // takes no slot in the players' shared rate window, has its own entry
    // limit, and keeps working while the private kill switch is off. Switched
    // off, this path is not a route: it falls through and answers exactly as
    // any unknown path does.
    if (this.config.debugLogsEnabled === true && request.path === DEBUG_LOGS_PATH) {
      return this.debugLogs.handle(request);
    }
    this.metrics.request();
    const deadline = createRequestDeadline(request.signal, this.requestTimeoutMs);
    try {
      if (deadline.signal.aborted) throw abortReason(deadline.signal);
      if (this.config.globalEnabled && request.method === 'POST' && request.path === '/v1/private/submissions') {
        preflightSubmission(request.body, this.config);
      }
      // Leaderboard phase 1: its own rate windows (every route per client, and
      // check-ins besides), never a slot in the private routes' shared one.
      // It obeys the global kill switch like everything else.
      if (this.leaderboard?.owns(request.path)) {
        if (!this.config.globalEnabled) {
          this.metrics.failure();
          return { status: 503, body: { code: 'SERVICE_DISABLED', message: 'Private operations are temporarily disabled.' } };
        }
        const response = await abortable(this.leaderboard.handle(request, deadline.signal), deadline.signal);
        if (response.status === 429) this.metrics.limited();
        else this.metrics.success();
        return response;
      }
      // D-076: the plaza's pool stats come from memory and cost the chain
      // nothing, so they take their own rate window, never a slot in the one
      // the private routes share.
      const limiter = request.path === POOL_STATS_PATH ? this.poolStatsLimiter : this.limiter;
      if (!await abortable(Promise.resolve(limiter.take()), deadline.signal)) {
        this.metrics.limited();
        return { status: 429, body: { code: 'RATE_LIMITED', message: 'Service is busy. Try again shortly.' } };
      }
      if (!this.config.globalEnabled) {
        this.metrics.failure();
        return { status: 503, body: { code: 'SERVICE_DISABLED', message: 'Private operations are temporarily disabled.' } };
      }
      // One read-only GET route (D-067); every other route is POST-only.
      const degenList = request.method === 'GET' && request.path === DEGEN_TOKENS_PATH;
      if (request.method !== 'POST' && !degenList) return this.failure(new ApiFailure(405, 'Method not allowed.'));

      let response: ApiResponse;
      if (degenList) {
        response = await abortable(this.degenTokens(request.body, deadline.signal), deadline.signal);
      } else {
        switch (request.path) {
          case '/v1/private/fees': response = await abortable(this.fee(request.body, deadline.signal), deadline.signal); break;
          case '/v1/private/submissions': response = await abortable(this.submit(request.body, deadline.signal), deadline.signal); break;
          case SWAP_QUOTE_PATH: response = await abortable(this.swapQuote(request.body, request.client, deadline.signal), deadline.signal); break;
          case '/v1/rpc/pool-config': response = await abortable(this.poolConfig(request.body, deadline.signal), deadline.signal); break;
          case '/v1/rpc/public-key': response = await abortable(this.publicKey(request.body, deadline.signal), deadline.signal); break;
          case '/v1/rpc/receipt': response = await abortable(this.receipt(request.body, deadline.signal), deadline.signal); break;
          case POOL_STATS_PATH: response = this.poolStats(request.body); break;
          case VAULT_SHADOW_ACCOUNT_PATH: response = await abortable(this.shadowAccount(request.body, deadline.signal), deadline.signal); break;
          case VAULT_POSITION_PATH: response = await abortable(this.vaultPosition(request.body, deadline.signal), deadline.signal); break;
          case VAULT_RATES_PATH: response = await abortable(this.vaultRateList(request.body, deadline.signal), deadline.signal); break;
          case BORROW_MARKET_PATH: response = await abortable(this.borrowMarket(request.body, deadline.signal), deadline.signal); break;
          case BORROW_POSITION_PATH: response = await abortable(this.borrowPosition(request.body, deadline.signal), deadline.signal); break;
          case ENDUR_UNSTAKE_PATH: response = await abortable(this.endurUnstake(request.body, deadline.signal), deadline.signal); break;
          case ENDUR_RATE_PATH: response = await abortable(this.endurRate(request.body, deadline.signal), deadline.signal); break;
          case DEGEN_TOKENS_PATH: throw new ApiFailure(405, 'Method not allowed.');
          default: throw new ApiFailure(404, 'Endpoint not found.');
        }
      }
      this.metrics.success();
      return response;
    } catch (error) {
      deadline.cancel();
      return this.failure(error);
    } finally {
      deadline.dispose();
    }
  }

  private async fee(body: unknown, signal: AbortSignal): Promise<ApiResponse> {
    const value = requireRecord(body, ['v', 'route', 'feeToken', 'operationToken']);
    requireVersion(value);
    const route = requireRoute(value.route);
    const policy = this.routePolicy(route);
    this.requireRelay();
    const feeToken = requireFelt(value.feeToken, 'fee token');
    const operationToken = requireFelt(value.operationToken, 'operation token');
    if (!sameAddress(feeToken, this.config.feeToken)) {
      throw new ApiFailure(400, 'Fee token is not allowlisted.');
    }
    if (!policy.allowedTokens.some((token) => sameAddress(token, operationToken))) {
      throw new ApiFailure(400, 'Operation token is not allowlisted for this route.');
    }
    const [fee, poolConfig, block] = await Promise.all([
      this.paymaster.buildFee({
        route,
        poolAddress: this.config.poolAddress,
        feeToken,
        operationToken,
        signal,
      }),
      this.rpc.getPoolConfig(signal),
      this.rpc.getBlockNumber(signal),
    ]);
    requireFelt(fee.token, 'paymaster fee token');
    const feeAmount = requireProviderFeeAmount(fee.amount);
    if (!sameAddress(fee.token, feeToken)) throw new ApiFailure(400, 'Paymaster changed the fee token.');
    requireNonzeroFelt(fee.recipient, 'fee recipient');
    if (feeAmount <= 0n || feeAmount > policy.maxRelayFee) {
      throw new ApiFailure(400, 'Paymaster fee exceeds the route ceiling.');
    }
    const expiresAtBlock = safeBlockExpiry(block, poolConfig.proofValidityBlocks);
    const claims: FeeAuthorizationClaims = {
      v: 1,
      route,
      feeToken,
      operationToken,
      token: fee.token,
      recipient: fee.recipient,
      amount: feeAmount,
      issuedAtBlock: block,
      expiresAtBlock,
    };
    return {
      status: 200,
      body: {
        token: fee.token,
        recipient: fee.recipient,
        amount: feeAmount.toString(),
        authorization: await this.authorizations.issue(claims),
        expiresAtBlock: claims.expiresAtBlock,
      },
    };
  }

  private async submit(body: unknown, signal: AbortSignal): Promise<ApiResponse> {
    const value = requireRecord(
      body,
      ['v', 'route', 'artifact', 'feeAuthorization', 'proofValidityBlocks'],
    );
    requireVersion(value);
    const route = requireRoute(value.route);
    const policy = this.routePolicy(route);
    this.requireRelay();
    const artifact = validateArtifact(value.artifact, this.config);
    if (typeof value.feeAuthorization !== 'string' || !value.feeAuthorization) {
      throw new ApiFailure(400, 'Fee authorization is required.');
    }
    const validity = requirePositiveInteger(value.proofValidityBlocks, 'proof validity');
    const claims = await this.authorizations.verify(value.feeAuthorization);
    if (!claims) throw new ApiFailure(401, 'Fee authorization is invalid.');
    this.validateClaims(claims, route, validity, policy);
    validateServerActionRoute(route, artifact, {
      token: claims.token,
      recipient: claims.recipient,
      amount: claims.amount,
    }, claims.operationToken);

    await this.assertCurrentProofFreshness(claims, signal, 'Prepared proof has expired.');
    // D-066: a zero delay, the normal setting, goes straight to the queue. A
    // delay cannot hide timing, since the proof publishes its reference block.
    if (!policy.quoteBound && policy.maxQueueDelayMs > 0) {
      const delay = clamp(this.randomInt(policy.maxQueueDelayMs), 0, policy.maxQueueDelayMs);
      if (delay > 0) await abortable(this.sleep(delay), signal);
      await this.assertCurrentProofFreshness(claims, signal, 'Prepared proof expired in the queue.');
    }
    try {
      return await this.submissionQueue.run(async () => {
        if (!this.config.globalEnabled) {
          throw new ApiFailure(503, 'Private operations are temporarily disabled.');
        }
        // Admission is checked again against the current policy.
        this.validateClaims(claims, route, validity, this.routePolicy(route));
        await this.assertCurrentProofFreshness(
          claims,
          signal,
          'Prepared proof expired in the submission queue.',
        );
        throwIfAborted(signal);
        const budgetAvailable = await this.budget.take(claims.amount);
        throwIfAborted(signal);
        if (!budgetAvailable) {
          this.metrics.budgetLimited();
          throw new ApiFailure(503, 'The private sponsorship budget is temporarily exhausted.');
        }
        const result = await this.paymaster.submit({
          route,
          artifact,
          fee: { token: claims.token, recipient: claims.recipient, amount: claims.amount },
          signal,
        });
        const transactionHash = requireProviderTransactionHash(result);
        return { status: 200, body: { transactionHash } };
      }, { allowQueue: !policy.quoteBound, signal });
    } catch (error) {
      if (error instanceof SubmissionQueueFullError) {
        this.metrics.queueLimited();
        throw new ApiFailure(503, 'The private submission queue is full. Try again shortly.');
      }
      throw error;
    }
  }

  private async poolConfig(body: unknown, signal: AbortSignal): Promise<ApiResponse> {
    const value = requireRecord(body, ['v']);
    requireVersion(value);
    const config = await this.rpc.getPoolConfig(signal);
    return {
      status: 200,
      body: {
        feeAmount: config.feeAmount.toString(),
        feeToken: config.feeToken,
        proofValidityBlocks: config.proofValidityBlocks,
        noteMaturityBlocks: config.noteMaturityBlocks,
      },
    };
  }

  /**
   * D-084: avnu's public, keyless swap quote and built call for the player's
   * swap stand-in, fetched here so avnu never sees the player's IP next to
   * that address and the amounts. A thin proxy: no key, no relay, no fee,
   * nothing logged or kept. The request names two tokens, an amount, the
   * stand-in and a slippage; the tokens must be ones the swap route admits
   * (its allowlist, or the degen list, D-067), the slippage within the
   * route's ceiling. The browser checks every field of the answer again.
   */
  private async swapQuote(body: unknown, client: string | undefined, signal: AbortSignal): Promise<ApiResponse> {
    const value = requireRecord(body, ['v', 'sellToken', 'buyToken', 'sellAmount', 'taker', 'slippageBps']);
    requireVersion(value);
    const policy = this.routePolicy('swap');
    if (!this.swapQuotes) throw new ApiFailure(503, 'The swap quotes are unavailable.');
    const sellToken = requireNonzeroFelt(value.sellToken, 'sell token');
    const buyToken = requireNonzeroFelt(value.buyToken, 'buy token');
    const taker = requireNonzeroFelt(value.taker, 'taker');
    const sellAmount = requireBigintString(value.sellAmount, 'sell amount');
    const slippageBps = requirePositiveInteger(value.slippageBps, 'slippage');
    if (sameAddress(sellToken, buyToken)) throw new ApiFailure(400, 'A swap needs two different tokens.');
    if (BigInt(taker) >= CONTRACT_ADDRESS_BOUND) throw new ApiFailure(400, 'Invalid taker.');
    if (sellAmount >= U128_BOUND) throw new ApiFailure(400, 'Invalid sell amount.');
    // D-126: the swap route has two slippage ceilings — the Exchange's, and
    // the degen floor's wider one for the thin tokens only the degen list
    // admits. Which applies depends on the pair, so the widest of the two is
    // refused first (nothing above it can be admitted on either floor, and a
    // plainly-bad request must not cost a catalog read), then the exact one.
    const groundCeilingBps = policy.maxSlippageBps ?? 500;
    const degenCeilingBps = policy.degenMaxSlippageBps ?? groundCeilingBps;
    if (slippageBps > Math.max(groundCeilingBps, degenCeilingBps)) {
      throw new ApiFailure(400, 'Swap slippage exceeds route policy.');
    }
    const allowlist = policy.allowedTokens;
    const listed = (token: string) => allowlist.some((allowed) => sameAddress(allowed, token));
    // The ground floor's pair is one the static allowlist names on both sides.
    const groundFloor = listed(sellToken) && listed(buyToken);
    if (!groundFloor) {
      // D-067: beyond the static allowlist, only the backend's own degen list
      // admits a token. The request's addresses are checked, never added.
      const degen = await this.degenAdmissions(signal);
      const admitted = (token: string) => listed(token) || degen.some((address) => sameAddress(address, token));
      if (!admitted(sellToken) || !admitted(buyToken)) {
        throw new ApiFailure(400, 'Swap token is not allowlisted.');
      }
    }
    if (slippageBps > (groundFloor ? groundCeilingBps : degenCeilingBps)) {
      throw new ApiFailure(400, 'Swap slippage exceeds route policy.');
    }
    // A quote also takes a slot in its own window, which bounds what this
    // service asks of avnu's public API for every player at once. Taken only
    // once the request is admitted, so malformed or refused requests cannot
    // spend it.
    // The client's own bucket first, so one client cannot spend the shared
    // window; a request with no key (a direct call in tests) shares one.
    if (!this.swapQuoteClientLimiter.take(client ?? 'unkeyed')) throw new RateLimitedError();
    if (!this.swapQuoteLimiter.take()) throw new RateLimitedError();
    const quote = await this.swapQuotes.quote({ sellToken, buyToken, sellAmount, taker, slippageBps, signal });
    if (
      quote.chainId !== MAINNET_CHAIN_ID
      || quote.sellAmount !== sellAmount
      || !sameAddress(quote.sellToken, sellToken)
      || !sameAddress(quote.buyToken, buyToken)
      || quote.calls.length !== 1
      // The swap's own bound, never the relay's maxCalldataItems: the wallet
      // submits a swap (D-084), and degen routes run past the relay's limit.
      || quote.calls.some((call) => call.calldata.length > AVNU_SWAP_MAX_CALLDATA)
    ) {
      throw new ApiFailure(502, 'avnu returned an invalid swap quote.');
    }
    return {
      status: 200,
      body: {
        quoteId: quote.quoteId,
        chainId: quote.chainId,
        sellToken,
        buyToken,
        sellAmount: quote.sellAmount.toString(),
        buyAmount: quote.buyAmount.toString(),
        calls: quote.calls.map((call) => ({
          contractAddress: call.contractAddress,
          entrypoint: call.entrypoint,
          calldata: [...call.calldata],
        })),
      },
    };
  }

  private async publicKey(body: unknown, signal: AbortSignal): Promise<ApiResponse> {
    const value = requireRecord(body, ['v', 'address']);
    requireVersion(value);
    const address = requireFelt(value.address, 'address');
    return { status: 200, body: { publicKey: await this.rpc.getPublicKey(address, signal) } };
  }

  /**
   * D-072: a public receipt read. A hash the node has not seen yet answers
   * 200 with `null`, so the browser can tell "not mined yet" from this route
   * failing (a 429, 502, 503 or 504), which it reports as a check it could
   * not make rather than as a deposit still on its way.
   */
  private async receipt(body: unknown, signal: AbortSignal): Promise<ApiResponse> {
    const value = requireRecord(body, ['v', 'transactionHash']);
    requireVersion(value);
    const hash = requireNonzeroFelt(value.transactionHash, 'transaction hash');
    return { status: 200, body: await this.rpc.getReceipt(hash, signal) };
  }

  /**
   * D-077: the Vault's stand-in address, from the pinned anonymizer's own
   * view. The request carries the partial commitment and nothing else: no
   * contract, selector or nonce range can be chosen here.
   */
  private async shadowAccount(body: unknown, signal: AbortSignal): Promise<ApiResponse> {
    const value = requireRecord(body, ['v', 'partialCommitment']);
    requireVersion(value);
    const partialCommitment = requireNonzeroFelt(value.partialCommitment, 'partial commitment');
    if (!this.vault) throw new ApiFailure(503, 'The Vault reads are unavailable.');
    const read = await this.vault.getShadowAccount(partialCommitment, signal);
    return { status: 200, body: { address: read.address, deployed: read.deployed } };
  }

  /**
   * D-077, D-079: a stand-in address's position in every pinned vault, one
   * row each, as decimal base units, or `ok: false` for a vault whose read
   * failed. Public data, read here rather than from the browser so the
   * player's IP never reaches a third-party RPC next to the address. The
   * request names the address alone: never a vault.
   */
  private async vaultPosition(body: unknown, signal: AbortSignal): Promise<ApiResponse> {
    const value = requireRecord(body, ['v', 'account']);
    requireVersion(value);
    const account = requireNonzeroFelt(value.account, 'account');
    if (!this.vault) throw new ApiFailure(503, 'The Vault reads are unavailable.');
    const rows = await this.vault.getVaultPositions(account, signal);
    return {
      status: 200,
      body: {
        positions: rows.map((row) => (row.ok
          ? {
              vault: row.vault,
              ok: true,
              shares: row.shares.toString(),
              assets: row.assets.toString(),
              maxWithdraw: row.maxWithdraw.toString(),
              maxRedeem: row.maxRedeem.toString(),
            }
          : { vault: row.vault, ok: false })),
      },
    };
  }

  /**
   * D-085: what a stand-in address holds at Endur's withdrawal queue: its
   * requests in the scan window, its STRK and xSTRK, its count of queue
   * NFTs, and the chain's clock, as decimal strings and integers. Public
   * data, read here so the player's IP never reaches a third-party RPC next
   * to the address. The request names the address alone.
   */
  private async endurUnstake(body: unknown, signal: AbortSignal): Promise<ApiResponse> {
    const value = requireRecord(body, ['v', 'account']);
    requireVersion(value);
    const account = requireNonzeroFelt(value.account, 'account');
    if (!this.endur) throw new ApiFailure(503, 'The unstaking reads are unavailable.');
    const read = await this.endur.getEndurUnstake(account, signal);
    return {
      status: 200,
      body: {
        chainTime: read.chainTime,
        strk: read.strk.toString(),
        xstrk: read.xstrk.toString(),
        outstanding: read.outstanding.toString(),
        requests: read.requests.map((request) => ({
          requestId: request.requestId.toString(),
          assets: request.assets.toString(),
          shares: request.shares.toString(),
          claimed: request.claimed,
          requestedAt: request.requestedAt,
          claimableAt: request.claimableAt,
          claimableNow: request.claimableNow,
        })),
        complete: read.complete,
      },
    };
  }

  /**
   * D-091: xSTRK's exchange rate, the STRK one whole xSTRK converts to now,
   * as a decimal string. The request carries a version and nothing else, and
   * the answer holds nothing about any player.
   */
  private async endurRate(body: unknown, signal: AbortSignal): Promise<ApiResponse> {
    requireVersion(requireRecord(body, ['v']));
    if (!this.endur) throw new ApiFailure(503, 'The unstaking reads are unavailable.');
    const strkPerXstrk = await this.endur.getEndurRate(signal);
    return { status: 200, body: { strkPerXstrk: strkPerXstrk.toString() } };
  }

  /**
   * D-079: Vesu's supply APY for each pinned vault, from this service's own
   * cached read of Vesu's public API. The request carries a version and
   * nothing else, and the answer holds only pinned vaults and their rates:
   * nothing about any player.
   */
  private async vaultRateList(body: unknown, signal: AbortSignal): Promise<ApiResponse> {
    requireVersion(requireRecord(body, ['v']));
    if (!this.vaultRates) throw new ApiFailure(503, 'The Vault rates are unavailable.');
    const rates = await this.vaultRates.rates(signal);
    return {
      status: 200,
      body: {
        rates: rates.map((rate) => ({
          vault: rate.vault,
          supplyApy: { value: rate.supplyApy.value.toString(), decimals: rate.supplyApy.decimals },
        })),
      },
    };
  }

  /**
   * D-083: the Borrow counter's market figures, from the pinned Prime pool:
   * one row per pinned token and one per pinned pair, as decimal integers, or
   * `ok: false` for a row whose reads failed. The request carries a version
   * and nothing else, and the answer holds nothing about any player.
   */
  private async borrowMarket(body: unknown, signal: AbortSignal): Promise<ApiResponse> {
    requireVersion(requireRecord(body, ['v']));
    if (!this.borrow) throw new ApiFailure(503, 'The borrow reads are unavailable.');
    const market = await this.borrow.getBorrowMarket(signal);
    return {
      status: 200,
      body: {
        assets: market.assets.map((row) => (row.ok
          ? {
              token: row.token,
              ok: true,
              price: row.price.toString(),
              priceValid: row.priceValid,
              scale: row.scale.toString(),
              floor: row.floor.toString(),
              reserve: row.reserve.toString(),
              totalNominalDebt: row.totalNominalDebt.toString(),
              rateAccumulator: row.rateAccumulator.toString(),
              maxUtilization: row.maxUtilization.toString(),
            }
          : { token: row.token, ok: false })),
        pairs: market.pairs.map((row) => (row.ok
          ? {
              collateral: row.collateral,
              debt: row.debt,
              ok: true,
              maxLtv: row.maxLtv.toString(),
              liquidationFactor: row.liquidationFactor.toString(),
              debtCap: row.debtCap.toString(),
              totalNominalDebt: row.totalNominalDebt.toString(),
            }
          : { collateral: row.collateral, debt: row.debt, ok: false })),
      },
    };
  }

  /**
   * D-083: a stand-in address's position in every pinned pair of the Prime
   * pool, one row each, as decimal integers, or `ok: false` for a pair whose
   * read failed. Public data, read here rather than from the browser so the
   * player's IP never reaches a third-party RPC next to the address. The
   * request names the address alone: never a pool, a pair or a token.
   */
  private async borrowPosition(body: unknown, signal: AbortSignal): Promise<ApiResponse> {
    const value = requireRecord(body, ['v', 'account']);
    requireVersion(value);
    const account = requireNonzeroFelt(value.account, 'account');
    if (!this.borrow) throw new ApiFailure(503, 'The borrow reads are unavailable.');
    const rows = await this.borrow.getBorrowPositions(account, signal);
    return {
      status: 200,
      body: {
        positions: rows.map((row) => (row.ok
          ? {
              collateral: row.collateral,
              debt: row.debt,
              ok: true,
              collateralShares: row.collateralShares.toString(),
              nominalDebt: row.nominalDebt.toString(),
              collateralAmount: row.collateralAmount.toString(),
              debtAmount: row.debtAmount.toString(),
            }
          : { collateral: row.collateral, debt: row.debt, ok: false })),
      },
    };
  }

  /**
   * D-076: the Privacy Plaza's public pool stats, straight from the cache,
   * which never waits on the chain or the value aggregate. Aggregates only:
   * two counts, the pool's USD value and its top holdings by value (D-080),
   * each null until the background scan or fetch has one. The request
   * carries nothing but the version, so no player can choose, add or probe a
   * contract here.
   */
  private poolStats(body: unknown): ApiResponse {
    requireVersion(requireRecord(body, ['v']));
    if (!this.poolStatsPort) throw new ApiFailure(503, 'Pool stats are unavailable.');
    const snapshot = this.poolStatsPort.snapshot();
    return {
      status: 200,
      body: {
        accounts: snapshot.accounts,
        deposits24h: snapshot.deposits24h,
        valueUsd: snapshot.valueUsd,
        topHoldings: snapshot.topHoldings === null
          ? null
          : snapshot.topHoldings.map(({ symbol, usd }) => ({ symbol, usd })),
        valueAsOf: snapshot.valueAsOf,
        tokenCount: snapshot.tokenCount,
      },
    };
  }

  /**
   * Start the pool stats' background refresh at boot, so the first visitor
   * to the plaza need not wait for the first registration scan. Nothing
   * while the kill switch is off: the route would refuse every read anyway.
   */
  warmPoolStats(): void {
    if (!this.config.globalEnabled) return;
    this.poolStatsPort?.warm?.();
  }

  /**
   * The degen floor's list (D-067): the curated core plus the backend's own
   * filtered copy of avnu's live list. The request carries nothing — no body,
   * and the HTTP edge refuses query strings — so no player can add, choose or
   * probe a token here. It exists only to serve the swap route, so it is shut
   * whenever swap or degen mode is.
   */
  private async degenTokens(body: unknown, signal: AbortSignal): Promise<ApiResponse> {
    if (body !== null) throw new ApiFailure(400, 'The degen token list takes no request body.');
    this.routePolicy('swap');
    if (!this.config.degen?.enabled || !this.degenCatalog) {
      throw new ApiFailure(503, 'Degen mode is disabled.');
    }
    const snapshot = await this.degenCatalog.snapshot(signal);
    return {
      status: 200,
      body: { source: snapshot.source, tokens: snapshot.tokens.map(publicDegenToken) },
    };
  }

  /** Addresses the degen list admits right now, or none while degen mode is off (D-067). */
  private async degenAdmissions(signal: AbortSignal): Promise<readonly string[]> {
    if (!this.config.degen?.enabled || !this.degenCatalog) return [];
    const snapshot = await this.degenCatalog.snapshot(signal);
    return snapshot.tokens
      .map((token) => token.address)
      .filter((address) => typeof address === 'string' && isFelt(address) && BigInt(address) !== 0n);
  }

  private routePolicy(route: PrivateRoute): RoutePolicy {
    // An unconfigured optional route (stake, D-063) is disabled, not an error.
    const policy = this.config.routes[route];
    if (!policy?.enabled) throw new ApiFailure(503, 'This private route is disabled.');
    return policy;
  }

  /**
   * D-070: avnu refuses `sponsored_private` without a Portal key, so a relay
   * holding none refuses an enabled route here, before avnu or the chain is
   * asked anything. A disabled route has already answered as disabled.
   */
  private requireRelay(): void {
    if (this.paymaster.configured === false) throw new RelayNotConfiguredError();
  }

  /**
   * The enabled routes this relay refuses for want of a key (D-070), for its
   * one startup line. Read from the same switch the routes themselves check.
   */
  relayRefusedRoutes(): readonly RelayRoute[] {
    return refusedRelayRoutes(this.config, this.paymaster.configured !== false);
  }

  private validateClaims(
    claims: FeeAuthorizationClaims,
    route: RelayRoute,
    validity: number,
    policy: RoutePolicy,
  ): void {
    if (claims.v !== 1 || claims.route !== route) throw new ApiFailure(401, 'Fee authorization route mismatch.');
    if (!sameAddress(claims.feeToken, this.config.feeToken) || !sameAddress(claims.token, this.config.feeToken)) {
      throw new ApiFailure(401, 'Fee authorization token mismatch.');
    }
    if (claims.amount <= 0n || claims.amount > policy.maxRelayFee) {
      throw new ApiFailure(401, 'Fee authorization exceeds policy.');
    }
    if (!policy.allowedTokens.some((allowed) => sameAddress(allowed, claims.operationToken))) {
      throw new ApiFailure(401, 'Fee authorization operation token is no longer allowlisted.');
    }
    requireFelt(claims.recipient, 'authorized fee recipient');
    if (
      !Number.isSafeInteger(claims.issuedAtBlock) ||
      !Number.isSafeInteger(claims.expiresAtBlock) ||
      claims.issuedAtBlock < 0 ||
      claims.expiresAtBlock - claims.issuedAtBlock !== validity
    ) {
      throw new ApiFailure(401, 'Proof-validity claim mismatch.');
    }
  }

  private async assertCurrentProofFreshness(
    claims: FeeAuthorizationClaims,
    signal: AbortSignal,
    message: string,
  ): Promise<void> {
    const [block, poolConfig] = await Promise.all([
      this.rpc.getBlockNumber(signal),
      this.rpc.getPoolConfig(signal),
    ]);
    const currentExpiry = claims.issuedAtBlock + poolConfig.proofValidityBlocks;
    if (!Number.isSafeInteger(currentExpiry) || block > Math.min(claims.expiresAtBlock, currentExpiry)) {
      throw new ApiFailure(409, message);
    }
  }

  private failure(error: unknown): ApiResponse {
    if (error instanceof RateLimitedError) {
      this.metrics.limited();
      return { status: 429, body: { code: 'RATE_LIMITED', message: 'Service is busy. Try again shortly.' } };
    }
    this.metrics.failure();
    // D-070: no key, or a key avnu rejects. One fixed answer, never avnu's text.
    if (error instanceof RelayNotConfiguredError) {
      return { status: 503, body: { code: RELAY_NOT_CONFIGURED_CODE, message: RELAY_NOT_CONFIGURED_MESSAGE } };
    }
    if (error instanceof ApiFailure) {
      return { status: error.status, body: { code: `HTTP_${error.status}`, message: error.message } };
    }
    if (isAbortFailure(error)) {
      return { status: 504, body: { code: 'UPSTREAM_TIMEOUT', message: 'A private service dependency timed out.' } };
    }
    return { status: 502, body: { code: 'UPSTREAM_FAILURE', message: 'A private service dependency failed.' } };
  }
}

/** A route's own rate window is spent (D-084): answered exactly as the shared limiter answers. */
class RateLimitedError extends Error {
  constructor() {
    super('Service is busy. Try again shortly.');
    this.name = 'RateLimitedError';
  }
}

function requireProviderTransactionHash(result: unknown): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Paymaster returned an invalid transaction hash.');
  }
  const descriptor = Object.getOwnPropertyDescriptor(result, 'transactionHash');
  const value = descriptor?.value;
  if (typeof value !== 'string' || !isFelt(value) || BigInt(value) === 0n) {
    throw new Error('Paymaster returned an invalid transaction hash.');
  }
  return value;
}

function requireProviderFeeAmount(value: unknown): bigint {
  if (typeof value !== 'bigint') {
    throw new Error('Paymaster returned an invalid fee amount.');
  }
  return value;
}

function safeBlockExpiry(issuedAtBlock: number, validity: number): number {
  const expiry = issuedAtBlock + validity;
  if (!Number.isSafeInteger(expiry)) {
    throw new Error('Pool proof-validity window exceeds the safe block bound.');
  }
  return expiry;
}

function requireBigintString(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new ApiFailure(400, `Invalid ${label}.`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_UINT256) throw new ApiFailure(400, `Invalid ${label}.`);
  return parsed;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function preflightSubmission(body: unknown, config: BackendConfig): void {
  const value = requireRecord(
    body,
    ['v', 'route', 'artifact', 'feeAuthorization', 'proofValidityBlocks'],
  );
  requireVersion(value);
  requireRoute(value.route);
  if (typeof value.feeAuthorization !== 'string' || value.feeAuthorization.length === 0) {
    throw new ApiFailure(400, 'Fee authorization is required.');
  }
  requirePositiveInteger(value.proofValidityBlocks, 'proof validity');
  const artifact = requireRecord(value.artifact, ['call', 'proof']);
  const call = requireRecord(artifact.call, ['contract_address', 'entry_point', 'calldata']);
  const proof = requireRecord(artifact.proof, ['data', 'output', 'proof_facts']);
  const contractAddress = requireFelt(call.contract_address, 'submission target');
  if (!sameAddress(contractAddress, config.poolAddress)) {
    throw new ApiFailure(400, 'Submission target is not the configured privacy pool.');
  }
  if (call.entry_point !== 'apply_actions') {
    throw new ApiFailure(400, 'Submission entry point is not allowlisted.');
  }

  if (!Array.isArray(call.calldata) || call.calldata.length === 0) {
    throw new ApiFailure(400, 'Invalid call calldata.');
  }
  if (call.calldata.length > config.maxCalldataItems) {
    throw new ApiFailure(400, 'Invalid call calldata.');
  }
  call.calldata.forEach((item) => requireFelt(item, 'call calldata'));
  if (typeof proof.data !== 'string' || proof.data.length === 0) {
    throw new ApiFailure(400, 'Prepared proof is empty.');
  }
  if (
    proof.data.length > config.maxProofBytes ||
    new TextEncoder().encode(proof.data).byteLength > config.maxProofBytes
  ) {
    throw new ApiFailure(413, 'Prepared proof is too large.');
  }
  if (!Array.isArray(proof.output) || proof.output.length === 0 || proof.output.length > config.maxCalldataItems + 1) {
    throw new ApiFailure(400, 'Invalid proof output.');
  }
  proof.output.forEach((item) => requireFelt(item, 'proof output'));
  if (!Array.isArray(proof.proof_facts) || proof.proof_facts.length === 0 || proof.proof_facts.length > 64) {
    throw new ApiFailure(400, 'Invalid proof facts.');
  }
  proof.proof_facts.forEach((item) => requireFelt(item, 'proof facts'));
}

function validateBackendConfig(config: BackendConfig): void {
  if (!isFelt(config.poolAddress) || !isFelt(config.feeToken)) {
    throw new Error('Backend pool and fee-token addresses must be felts.');
  }
  if (
    !Number.isSafeInteger(config.maxCalldataItems) || config.maxCalldataItems <= 0 ||
    !Number.isSafeInteger(config.maxProofBytes) || config.maxProofBytes <= 0 ||
    !Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs <= 0 ||
    config.requestTimeoutMs > MAX_NODE_TIMEOUT_MS ||
    !Number.isSafeInteger(config.rateLimit.maxRequests) || config.rateLimit.maxRequests <= 0 ||
    !Number.isSafeInteger(config.rateLimit.windowMs) || config.rateLimit.windowMs <= 0
    || config.sponsorshipBudget.maxFeeAmount < 0n
    || !Number.isSafeInteger(config.sponsorshipBudget.windowMs)
    || config.sponsorshipBudget.windowMs <= 0
    || !Number.isSafeInteger(config.submissionQueue.maxInFlight)
    || config.submissionQueue.maxInFlight <= 0
    || !Number.isSafeInteger(config.submissionQueue.maxQueued)
    || config.submissionQueue.maxQueued < 0
  ) {
    throw new Error('Backend size and rate limits must be positive integers.');
  }
  for (const [route, policy] of Object.entries(config.routes)) {
    if (policy === undefined) continue;
    if (
      policy.maxRelayFee < 0n ||
      !Number.isSafeInteger(policy.maxQueueDelayMs) ||
      policy.maxQueueDelayMs < 0 ||
      policy.maxQueueDelayMs > MAX_NODE_TIMEOUT_MS ||
      policy.allowedTokens.length === 0 ||
      policy.allowedTokens.some((token) => !isFelt(token))
    ) {
      throw new Error(`Backend ${route} policy has invalid limits.`);
    }
  }
  // Relayed pool routes submit as soon as they are validated (D-066): a zero
  // queue delay is valid, and the per-route limits above bound a nonzero one.
  // They are never quote-bound, so they may still wait in the bounded queue.
  for (const route of ['transfer', 'unshield'] as const) {
    if (config.routes[route].quoteBound) {
      throw new Error(`Backend ${route} route policy must not be quote-bound.`);
    }
  }
  const stake = config.routes.stake;
  if (stake) {
    // No quote binds a stake, so it takes the ordinary submission queue (D-066).
    if (stake.quoteBound) {
      throw new Error('Backend stake route policy must not be quote-bound.');
    }
    // D-063 admits STRK in only; the anonymizer itself pins no pair.
    if (
      stake.enabled &&
      (stake.allowedTokens.length !== 1 || !sameAddress(stake.allowedTokens[0]!, ENDUR_XSTRK_ASSET))
    ) {
      throw new Error('Backend stake route must admit exactly STRK, the xSTRK asset.');
    }
  }
  const swap = config.routes.swap;
  if (
    !swap.quoteBound ||
    swap.maxQueueDelayMs !== 0 ||
    !Number.isSafeInteger(swap.maxSlippageBps) ||
    (swap.maxSlippageBps ?? 0) <= 0 ||
    (swap.maxSlippageBps ?? 0) > 300
  ) {
    throw new Error('Backend swap policy must be quote-bound, immediate and allowlisted.');
  }
  // D-126: the degen floor's own ceiling, where it is set, is at most 8% and
  // never narrower than the ground floor's — a degen pair is the thin case, so
  // a "degen" ceiling under the Exchange's own would be a misconfiguration
  // rather than a tightening.
  if (
    swap.degenMaxSlippageBps !== undefined
    && (!Number.isSafeInteger(swap.degenMaxSlippageBps)
      || swap.degenMaxSlippageBps <= 0
      || swap.degenMaxSlippageBps > SWAP_DEGEN_MAX_SLIPPAGE_BPS
      || swap.degenMaxSlippageBps < (swap.maxSlippageBps ?? 0))
  ) {
    throw new Error(`Backend degen swap slippage ceiling must be from the swap ceiling to ${SWAP_DEGEN_MAX_SLIPPAGE_BPS} bps.`);
  }
  if (config.degen !== undefined) validateDegenConfig(config.degen);
  if (config.debugLogsEnabled !== undefined && typeof config.debugLogsEnabled !== 'boolean') {
    throw new Error('Backend debug-log switch must be a boolean.');
  }
  if (
    config.leaderboard !== undefined
    && (!isFelt(config.leaderboard.ledger) || BigInt(config.leaderboard.ledger) === 0n
      || (config.leaderboard.storePath !== null && typeof config.leaderboard.storePath !== 'string'))
  ) {
    throw new Error('Backend leaderboard configuration is invalid.');
  }
}

function createRequestDeadline(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cancel: () => void; dispose: () => void } {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(
    parent?.reason ?? new DOMException('Request aborted.', 'AbortError'),
  );
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener('abort', onParentAbort, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new DOMException('Request deadline exceeded.', 'TimeoutError'));
  }, timeoutMs);
  let disposed = false;
  return {
    signal: controller.signal,
    cancel: () => {
      if (controller.signal.aborted) return;
      controller.abort(new DOMException('Request failed.', 'AbortError'));
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(timeout);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Request aborted.', 'AbortError');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function isAbortFailure(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
