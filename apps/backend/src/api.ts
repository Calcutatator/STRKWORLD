import { DEBUG_LOGS_PATH, DebugLogSink } from './debug-logs.js';
import { publicDegenToken, validateDegenConfig } from './degen-catalog.js';
import { ENDUR_XSTRK_ASSET } from './endur.js';
import {
  AggregateBudget,
  AggregateMetrics,
  AggregateRateLimiter,
  type RequestRateLimiterPort,
  type SponsorshipBudgetPort,
} from './metrics.js';
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
  DegenCatalogPort,
  FeeAuthorizationClaims,
  PaymasterPort,
  PoolRpcPort,
  PrivateRoute,
  RoutePolicy,
  SwapPlannerPort,
} from './types.js';
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

export interface BackendApiOptions {
  config: BackendConfig;
  paymaster: PaymasterPort;
  rpc: PoolRpcPort;
  authorizations: AuthorizationCodec;
  randomInt?: (maxInclusive: number) => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  swapPlanner?: SwapPlannerPort;
  /** The backend's own degen list (D-067). Without it, degen mode stays off whatever the config says. */
  degenCatalog?: DegenCatalogPort;
  rateLimiter?: RequestRateLimiterPort;
  sponsorshipBudget?: SponsorshipBudgetPort;
  submissionQueue?: SubmissionQueuePort;
  /**
   * The opt-in debug sink (D-069). Reachable only while
   * `config.debugLogsEnabled` is true; by default it writes to stdout.
   */
  debugLogs?: DebugLogSink;
}

export class BackendApi {
  readonly metrics = new AggregateMetrics();
  private readonly limiter: RequestRateLimiterPort;
  private readonly config: BackendConfig;
  private readonly requestTimeoutMs: number;
  private readonly paymaster: PaymasterPort;
  private readonly rpc: PoolRpcPort;
  private readonly authorizations: AuthorizationCodec;
  private readonly randomInt: (maxInclusive: number) => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly swapPlanner?: SwapPlannerPort;
  private readonly degenCatalog?: DegenCatalogPort;
  private readonly clockNow: () => number;
  private readonly budget: SponsorshipBudgetPort;
  private readonly submissionQueue: SubmissionQueuePort;
  private readonly debugLogs: DebugLogSink;

  constructor(options: BackendApiOptions) {
    validateBackendConfig(options.config);
    this.config = options.config;
    this.requestTimeoutMs = options.config.requestTimeoutMs;
    this.paymaster = options.paymaster;
    this.rpc = options.rpc;
    this.authorizations = options.authorizations;
    this.randomInt = options.randomInt ?? ((max) => Math.floor(Math.random() * (max + 1)));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.swapPlanner = options.swapPlanner;
    this.degenCatalog = options.degenCatalog;
    const now = options.now ?? Date.now;
    this.clockNow = now;
    this.limiter = options.rateLimiter ?? new AggregateRateLimiter(
      this.config.rateLimit.maxRequests, this.config.rateLimit.windowMs, now,
    );
    this.budget = options.sponsorshipBudget ?? new AggregateBudget(
      this.config.sponsorshipBudget.maxFeeAmount, this.config.sponsorshipBudget.windowMs, now,
    );
    this.submissionQueue = options.submissionQueue ?? new BoundedSubmissionQueue(
      this.config.submissionQueue.maxInFlight,
      this.config.submissionQueue.maxQueued,
    );
    this.debugLogs = options.debugLogs ?? new DebugLogSink({ now });
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
      if (!await abortable(Promise.resolve(this.limiter.take()), deadline.signal)) {
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
          case '/v1/private/swaps/prepare': response = await abortable(this.prepareSwap(request.body, deadline.signal), deadline.signal); break;
          case '/v1/rpc/pool-config': response = await abortable(this.poolConfig(request.body, deadline.signal), deadline.signal); break;
          case '/v1/rpc/public-key': response = await abortable(this.publicKey(request.body, deadline.signal), deadline.signal); break;
          case '/v1/rpc/receipt': response = await abortable(this.receipt(request.body, deadline.signal), deadline.signal); break;
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
    if (route === 'swap') {
      throw new ApiFailure(400, 'Use the quote-bound swap preparation endpoint.');
    }
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
    const artifact = validateArtifact(value.artifact, this.config);
    if (typeof value.feeAuthorization !== 'string' || !value.feeAuthorization) {
      throw new ApiFailure(400, 'Fee authorization is required.');
    }
    const validity = requirePositiveInteger(value.proofValidityBlocks, 'proof validity');
    const claims = await this.authorizations.verify(value.feeAuthorization);
    if (!claims) throw new ApiFailure(401, 'Fee authorization is invalid.');
    this.validateClaims(claims, route, validity, policy, await this.degenSwapAdmissions(route, claims, policy, signal));
    if (claims.swap && claims.swap.quoteExpiresAt <= this.clockNow()) {
      throw new ApiFailure(409, 'The private swap quote has expired.');
    }
    validateServerActionRoute(route, artifact, {
      token: claims.token,
      recipient: claims.recipient,
      amount: claims.amount,
    }, claims.operationToken, claims.swap);

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
        const currentPolicy = this.routePolicy(route);
        // Admission is checked again against the current degen list: a token
        // avnu dropped since the quote no longer relays.
        this.validateClaims(
          claims,
          route,
          validity,
          currentPolicy,
          await this.degenSwapAdmissions(route, claims, currentPolicy, signal),
        );
        await this.assertCurrentProofFreshness(
          claims,
          signal,
          'Prepared proof expired in the submission queue.',
        );
        throwIfAborted(signal);
        if (claims.swap && claims.swap.quoteExpiresAt <= this.clockNow()) {
          throw new ApiFailure(409, 'The private swap quote expired before submission.');
        }
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

  private async prepareSwap(body: unknown, signal: AbortSignal): Promise<ApiResponse> {
    if (!this.swapPlanner) throw new ApiFailure(503, 'The private swap planner is unavailable.');
    const value = requireRecord(
      body,
      ['v', 'sellToken', 'buyToken', 'sellAmount', 'minAmountOut', 'slippageBps'],
    );
    requireVersion(value);
    const policy = this.routePolicy('swap');
    const sellToken = requireFelt(value.sellToken, 'sell token');
    const buyToken = requireFelt(value.buyToken, 'buy token');
    const sellAmount = requireBigintString(value.sellAmount, 'sell amount');
    const minAmountOut = requireBigintString(value.minAmountOut, 'minimum output');
    const slippageBps = requirePositiveInteger(value.slippageBps, 'slippage');
    if (slippageBps > (policy.maxSlippageBps ?? 500)) {
      throw new ApiFailure(400, 'Swap slippage exceeds route policy.');
    }
    const allowlist = policy.allowedTokens;
    const listed = (token: string) => allowlist.some((allowed) => sameAddress(allowed, token));
    if (!listed(sellToken) || !listed(buyToken)) {
      // D-067: beyond the static allowlist, only the backend's own degen list
      // admits a token. The request's addresses are checked, never added.
      const degen = await this.degenAdmissions(signal);
      const admitted = (token: string) => listed(token) || degen.some((address) => sameAddress(address, token));
      if (!admitted(sellToken) || !admitted(buyToken)) {
        throw new ApiFailure(400, 'Swap token is not allowlisted.');
      }
    }

    const [plan, block, poolConfig] = await Promise.all([
      this.swapPlanner.prepare({ sellToken, buyToken, sellAmount, minAmountOut, slippageBps, signal }),
      this.rpc.getBlockNumber(signal),
      this.rpc.getPoolConfig(signal),
    ]);
    if (
      typeof plan.quoteId !== 'string' ||
      plan.quoteId.length === 0 ||
      plan.chainId !== MAINNET_CHAIN_ID ||
      !isFelt(plan.executorAddress) ||
      BigInt(plan.executorAddress) === 0n ||
      typeof plan.buyAmount !== 'bigint' ||
      plan.buyAmount > MAX_UINT256 ||
      plan.buyAmount < minAmountOut ||
      !Number.isSafeInteger(plan.expiresAt) ||
      plan.expiresAt <= this.clockNow() ||
      plan.executorCalls.length === 0
    ) {
      throw new ApiFailure(409, 'AVNU returned a stale or invalid private quote.');
    }
    for (const call of plan.executorCalls) {
      if (
        !isFelt(call.contractAddress) ||
        BigInt(call.contractAddress) === 0n ||
        !isFelt(call.selector) ||
        !call.entrypoint ||
        call.calldata.some((felt) => !isFelt(felt))
      ) {
        throw new ApiFailure(502, 'AVNU returned malformed private executor calls.');
      }
    }
    const fee = await this.paymaster.buildFee({
      route: 'swap',
      poolAddress: this.config.poolAddress,
      feeToken: this.config.feeToken,
      operationToken: sellToken,
      signal,
    });
    requireFelt(fee.token, 'paymaster fee token');
    const feeAmount = requireProviderFeeAmount(fee.amount);
    if (
      !sameAddress(fee.token, this.config.feeToken) ||
      feeAmount <= 0n ||
      feeAmount > policy.maxRelayFee
    ) {
      throw new ApiFailure(400, 'Paymaster fee exceeds swap policy.');
    }
    requireNonzeroFelt(fee.recipient, 'fee recipient');
    const invokePrefix = [buyToken, ...serializeCairo1Calls(plan.executorCalls)];
    // count + two TransferTo actions + Invoke header + buy token/open-note id
    if (invokePrefix.length + 13 > this.config.maxCalldataItems) {
      throw new ApiFailure(413, 'AVNU private executor plan is too large.');
    }
    const expiresAtBlock = safeBlockExpiry(block, poolConfig.proofValidityBlocks);
    const claims: FeeAuthorizationClaims = {
      v: 1,
      route: 'swap',
      feeToken: this.config.feeToken,
      operationToken: sellToken,
      token: fee.token,
      recipient: fee.recipient,
      amount: feeAmount,
      issuedAtBlock: block,
      expiresAtBlock,
      swap: {
        executor: plan.executorAddress,
        sellToken,
        buyToken,
        sellAmount,
        quoteExpiresAt: plan.expiresAt,
        invokePrefix,
      },
    };
    return {
      status: 200,
      body: {
        quoteId: plan.quoteId,
        buyAmount: plan.buyAmount.toString(),
        expiresAt: plan.expiresAt,
        chainId: plan.chainId,
        executorAddress: plan.executorAddress,
        executorCalls: plan.executorCalls,
        fee: {
          token: fee.token,
          recipient: fee.recipient,
          amount: feeAmount.toString(),
          authorization: await this.authorizations.issue(claims),
          expiresAtBlock: claims.expiresAtBlock,
        },
      },
    };
  }

  private async publicKey(body: unknown, signal: AbortSignal): Promise<ApiResponse> {
    const value = requireRecord(body, ['v', 'address']);
    requireVersion(value);
    const address = requireFelt(value.address, 'address');
    return { status: 200, body: { publicKey: await this.rpc.getPublicKey(address, signal) } };
  }

  private async receipt(body: unknown, signal: AbortSignal): Promise<ApiResponse> {
    const value = requireRecord(body, ['v', 'transactionHash']);
    requireVersion(value);
    const hash = requireNonzeroFelt(value.transactionHash, 'transaction hash');
    return { status: 200, body: await this.rpc.getReceipt(hash, signal) };
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

  /**
   * The degen list is consulted only for a swap whose tokens the static
   * allowlist does not already cover, so an ordinary swap never waits on
   * avnu's token list.
   */
  private async degenSwapAdmissions(
    route: PrivateRoute,
    claims: FeeAuthorizationClaims,
    policy: RoutePolicy,
    signal: AbortSignal,
  ): Promise<readonly string[]> {
    const swap = claims.swap;
    if (route !== 'swap' || claims.route !== 'swap' || !swap) return [];
    const listed = (token: string) => policy.allowedTokens.some((allowed) => sameAddress(allowed, token));
    if ([claims.operationToken, swap.sellToken, swap.buyToken].every(listed)) return [];
    return this.degenAdmissions(signal);
  }

  private routePolicy(route: PrivateRoute): RoutePolicy {
    // An unconfigured optional route (stake, D-063) is disabled, not an error.
    const policy = this.config.routes[route];
    if (!policy?.enabled) throw new ApiFailure(503, 'This private route is disabled.');
    return policy;
  }

  private validateClaims(
    claims: FeeAuthorizationClaims,
    route: PrivateRoute,
    validity: number,
    policy: RoutePolicy,
    /** The degen list's current addresses (D-067); they widen the swap route only. */
    degenTokens: readonly string[] = [],
  ): void {
    if (claims.v !== 1 || claims.route !== route) throw new ApiFailure(401, 'Fee authorization route mismatch.');
    if (!sameAddress(claims.feeToken, this.config.feeToken) || !sameAddress(claims.token, this.config.feeToken)) {
      throw new ApiFailure(401, 'Fee authorization token mismatch.');
    }
    if (claims.amount <= 0n || claims.amount > policy.maxRelayFee) {
      throw new ApiFailure(401, 'Fee authorization exceeds policy.');
    }
    const admitted = (token: string) =>
      policy.allowedTokens.some((allowed) => sameAddress(allowed, token)) ||
      (route === 'swap' && degenTokens.some((address) => sameAddress(address, token)));
    if (!admitted(claims.operationToken)) {
      throw new ApiFailure(401, 'Fee authorization operation token is no longer allowlisted.');
    }
    if ((route === 'swap') !== Boolean(claims.swap)) {
      throw new ApiFailure(401, 'Fee authorization private-route binding is invalid.');
    }
    const swap = claims.swap;
    if (swap && (
      !sameAddress(swap.sellToken, claims.operationToken) ||
      !admitted(swap.sellToken) ||
      !admitted(swap.buyToken)
    )) {
      throw new ApiFailure(401, 'Fee authorization swap token is no longer allowlisted.');
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
    this.metrics.failure();
    if (error instanceof ApiFailure) {
      return { status: error.status, body: { code: `HTTP_${error.status}`, message: error.message } };
    }
    if (isAbortFailure(error)) {
      return { status: 504, body: { code: 'UPSTREAM_TIMEOUT', message: 'A private service dependency timed out.' } };
    }
    return { status: 502, body: { code: 'UPSTREAM_FAILURE', message: 'A private service dependency failed.' } };
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

function serializeCairo1Calls(
  calls: Array<{ contractAddress: string; selector: string; calldata: string[] }>,
): string[] {
  return [
    toFelt(BigInt(calls.length)),
    ...calls.flatMap((call) => [
      call.contractAddress,
      call.selector,
      toFelt(BigInt(call.calldata.length)),
      ...call.calldata,
    ]),
  ];
}

function toFelt(value: bigint): string {
  return `0x${value.toString(16)}`;
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
    (swap.maxSlippageBps ?? 0) > 1_000
  ) {
    throw new Error('Backend swap policy must be quote-bound, immediate and allowlisted.');
  }
  if (config.degen !== undefined) validateDegenConfig(config.degen);
  if (config.debugLogsEnabled !== undefined && typeof config.debugLogsEnabled !== 'boolean') {
    throw new Error('Backend debug-log switch must be a boolean.');
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
