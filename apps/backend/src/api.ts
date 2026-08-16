import {
  AggregateBudget,
  AggregateMetrics,
  AggregateRateLimiter,
  type RequestRateLimiterPort,
  type SponsorshipBudgetPort,
} from './metrics.js';
import { validateServerActionRoute } from './server-actions.js';
import type {
  ApiRequest,
  ApiResponse,
  AuthorizationCodec,
  BackendConfig,
  FeeAuthorizationClaims,
  PaymasterPort,
  PoolRpcPort,
  PrivateRoute,
  SwapPlannerPort,
} from './types.js';
import {
  ApiFailure,
  requireFelt,
  requirePositiveInteger,
  requireRecord,
  requireRoute,
  requireVersion,
  sameAddress,
  validateArtifact,
} from './validation.js';

export interface BackendApiOptions {
  config: BackendConfig;
  paymaster: PaymasterPort;
  rpc: PoolRpcPort;
  authorizations: AuthorizationCodec;
  randomInt?: (maxInclusive: number) => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  swapPlanner?: SwapPlannerPort;
  rateLimiter?: RequestRateLimiterPort;
  sponsorshipBudget?: SponsorshipBudgetPort;
}

export class BackendApi {
  readonly metrics = new AggregateMetrics();
  private readonly limiter: RequestRateLimiterPort;
  private readonly config: BackendConfig;
  private readonly paymaster: PaymasterPort;
  private readonly rpc: PoolRpcPort;
  private readonly authorizations: AuthorizationCodec;
  private readonly randomInt: (maxInclusive: number) => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly swapPlanner?: SwapPlannerPort;
  private readonly clockNow: () => number;
  private readonly budget: SponsorshipBudgetPort;

  constructor(options: BackendApiOptions) {
    validateBackendConfig(options.config);
    this.config = options.config;
    this.paymaster = options.paymaster;
    this.rpc = options.rpc;
    this.authorizations = options.authorizations;
    this.randomInt = options.randomInt ?? ((max) => Math.floor(Math.random() * (max + 1)));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.swapPlanner = options.swapPlanner;
    const now = options.now ?? Date.now;
    this.clockNow = now;
    this.limiter = options.rateLimiter ?? new AggregateRateLimiter(
      this.config.rateLimit.maxRequests, this.config.rateLimit.windowMs, now,
    );
    this.budget = options.sponsorshipBudget ?? new AggregateBudget(
      this.config.sponsorshipBudget.maxFeeAmount, this.config.sponsorshipBudget.windowMs, now,
    );
  }

  async handle(request: ApiRequest): Promise<ApiResponse> {
    this.metrics.request();
    try {
      if (!await this.limiter.take()) {
        this.metrics.limited();
        return { status: 429, body: { code: 'RATE_LIMITED', message: 'Service is busy. Try again shortly.' } };
      }
    } catch (error) {
      return this.failure(error);
    }
    if (!this.config.globalEnabled) {
      this.metrics.failure();
      return { status: 503, body: { code: 'SERVICE_DISABLED', message: 'Private operations are temporarily disabled.' } };
    }
    if (request.method !== 'POST') return this.failure(new ApiFailure(405, 'Method not allowed.'));

    try {
      let response: ApiResponse;
      switch (request.path) {
        case '/v1/private/fees': response = await this.fee(request.body); break;
        case '/v1/private/submissions': response = await this.submit(request.body); break;
        case '/v1/private/swaps/prepare': response = await this.prepareSwap(request.body); break;
        case '/v1/rpc/pool-config': response = await this.poolConfig(request.body); break;
        case '/v1/rpc/public-key': response = await this.publicKey(request.body); break;
        case '/v1/rpc/receipt': response = await this.receipt(request.body); break;
        default: throw new ApiFailure(404, 'Endpoint not found.');
      }
      this.metrics.success();
      return response;
    } catch (error) {
      return this.failure(error);
    }
  }

  private async fee(body: unknown): Promise<ApiResponse> {
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
      }),
      this.rpc.getPoolConfig(),
      this.rpc.getBlockNumber(),
    ]);
    if (!sameAddress(fee.token, feeToken)) throw new ApiFailure(400, 'Paymaster changed the fee token.');
    requireFelt(fee.recipient, 'fee recipient');
    if (fee.amount <= 0n || fee.amount > policy.maxRelayFee) {
      throw new ApiFailure(400, 'Paymaster fee exceeds the route ceiling.');
    }
    const claims: FeeAuthorizationClaims = {
      v: 1,
      route,
      feeToken,
      operationToken,
      token: fee.token,
      recipient: fee.recipient,
      amount: fee.amount,
      issuedAtBlock: block,
      expiresAtBlock: block + poolConfig.proofValidityBlocks,
    };
    return {
      status: 200,
      body: {
        token: fee.token,
        recipient: fee.recipient,
        amount: fee.amount.toString(),
        authorization: await this.authorizations.issue(claims),
        expiresAtBlock: claims.expiresAtBlock,
      },
    };
  }

  private async submit(body: unknown): Promise<ApiResponse> {
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
    this.validateClaims(claims, route, validity, policy.maxRelayFee);
    if (claims.swap && claims.swap.quoteExpiresAt <= this.clockNow()) {
      throw new ApiFailure(409, 'The private swap quote has expired.');
    }
    validateServerActionRoute(route, artifact, {
      token: claims.token,
      recipient: claims.recipient,
      amount: claims.amount,
    }, claims.operationToken, claims.swap);

    let block = await this.rpc.getBlockNumber();
    if (block > claims.expiresAtBlock) throw new ApiFailure(409, 'Prepared proof has expired.');
    if (!policy.quoteBound && policy.maxQueueDelayMs > 0) {
      const delay = clamp(this.randomInt(policy.maxQueueDelayMs), 0, policy.maxQueueDelayMs);
      if (delay > 0) await this.sleep(delay);
      block = await this.rpc.getBlockNumber();
      if (block > claims.expiresAtBlock) throw new ApiFailure(409, 'Prepared proof expired in the queue.');
    }
    if (!await this.budget.take(claims.amount)) {
      this.metrics.budgetLimited();
      throw new ApiFailure(503, 'The private sponsorship budget is temporarily exhausted.');
    }
    const result = await this.paymaster.submit({
      route,
      artifact,
      fee: { token: claims.token, recipient: claims.recipient, amount: claims.amount },
    });
    return { status: 200, body: result };
  }

  private async poolConfig(body: unknown): Promise<ApiResponse> {
    const value = requireRecord(body, ['v']);
    requireVersion(value);
    const config = await this.rpc.getPoolConfig();
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

  private async prepareSwap(body: unknown): Promise<ApiResponse> {
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
    if (
      !allowlist.some((token) => sameAddress(token, sellToken)) ||
      !allowlist.some((token) => sameAddress(token, buyToken))
    ) {
      throw new ApiFailure(400, 'Swap token is not allowlisted.');
    }

    const [plan, block, poolConfig] = await Promise.all([
      this.swapPlanner.prepare({ sellToken, buyToken, sellAmount, minAmountOut, slippageBps }),
      this.rpc.getBlockNumber(),
      this.rpc.getPoolConfig(),
    ]);
    if (
      !plan.quoteId ||
      !plan.chainId ||
      !isFelt(plan.executorAddress) ||
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
    });
    if (
      !sameAddress(fee.token, this.config.feeToken) ||
      fee.amount <= 0n ||
      fee.amount > policy.maxRelayFee
    ) {
      throw new ApiFailure(400, 'Paymaster fee exceeds swap policy.');
    }
    requireFelt(fee.recipient, 'fee recipient');
    const invokePrefix = [buyToken, ...serializeCairo1Calls(plan.executorCalls)];
    // count + two TransferTo actions + Invoke header + buy token/open-note id
    if (invokePrefix.length + 13 > this.config.maxCalldataItems) {
      throw new ApiFailure(413, 'AVNU private executor plan is too large.');
    }
    const claims: FeeAuthorizationClaims = {
      v: 1,
      route: 'swap',
      feeToken: this.config.feeToken,
      operationToken: sellToken,
      token: fee.token,
      recipient: fee.recipient,
      amount: fee.amount,
      issuedAtBlock: block,
      expiresAtBlock: block + poolConfig.proofValidityBlocks,
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
          amount: fee.amount.toString(),
          authorization: await this.authorizations.issue(claims),
          expiresAtBlock: claims.expiresAtBlock,
        },
      },
    };
  }

  private async publicKey(body: unknown): Promise<ApiResponse> {
    const value = requireRecord(body, ['v', 'address']);
    requireVersion(value);
    const address = requireFelt(value.address, 'address');
    return { status: 200, body: { publicKey: await this.rpc.getPublicKey(address) } };
  }

  private async receipt(body: unknown): Promise<ApiResponse> {
    const value = requireRecord(body, ['v', 'transactionHash']);
    requireVersion(value);
    const hash = requireFelt(value.transactionHash, 'transaction hash');
    return { status: 200, body: await this.rpc.getReceipt(hash) };
  }

  private routePolicy(route: PrivateRoute) {
    const policy = this.config.routes[route];
    if (!policy.enabled) throw new ApiFailure(503, 'This private route is disabled.');
    return policy;
  }

  private validateClaims(
    claims: FeeAuthorizationClaims,
    route: PrivateRoute,
    validity: number,
    maxFee: bigint,
  ): void {
    if (claims.v !== 1 || claims.route !== route) throw new ApiFailure(401, 'Fee authorization route mismatch.');
    if (!sameAddress(claims.feeToken, this.config.feeToken) || !sameAddress(claims.token, this.config.feeToken)) {
      throw new ApiFailure(401, 'Fee authorization token mismatch.');
    }
    if (claims.amount <= 0n || claims.amount > maxFee) throw new ApiFailure(401, 'Fee authorization exceeds policy.');
    requireFelt(claims.recipient, 'authorized fee recipient');
    if (claims.expiresAtBlock - claims.issuedAtBlock !== validity) {
      throw new ApiFailure(401, 'Proof-validity claim mismatch.');
    }
  }

  private failure(error: unknown): ApiResponse {
    this.metrics.failure();
    if (error instanceof ApiFailure) {
      return { status: error.status, body: { code: `HTTP_${error.status}`, message: error.message } };
    }
    return { status: 502, body: { code: 'UPSTREAM_FAILURE', message: 'A private service dependency failed.' } };
  }
}

function requireBigintString(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new ApiFailure(400, `Invalid ${label}.`);
  }
  return BigInt(value);
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

function isFelt(value: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(value);
}

function toFelt(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function validateBackendConfig(config: BackendConfig): void {
  if (!isFelt(config.poolAddress) || !isFelt(config.feeToken)) {
    throw new Error('Backend pool and fee-token addresses must be felts.');
  }
  if (
    !Number.isSafeInteger(config.maxCalldataItems) || config.maxCalldataItems <= 0 ||
    !Number.isSafeInteger(config.maxProofBytes) || config.maxProofBytes <= 0 ||
    !Number.isSafeInteger(config.rateLimit.maxRequests) || config.rateLimit.maxRequests <= 0 ||
    !Number.isSafeInteger(config.rateLimit.windowMs) || config.rateLimit.windowMs <= 0
    || config.sponsorshipBudget.maxFeeAmount < 0n
    || !Number.isSafeInteger(config.sponsorshipBudget.windowMs)
    || config.sponsorshipBudget.windowMs <= 0
  ) {
    throw new Error('Backend size and rate limits must be positive integers.');
  }
  for (const [route, policy] of Object.entries(config.routes)) {
    if (
      policy.maxRelayFee < 0n ||
      !Number.isSafeInteger(policy.maxQueueDelayMs) ||
      policy.maxQueueDelayMs < 0 ||
      policy.allowedTokens.length === 0 ||
      policy.allowedTokens.some((token) => !isFelt(token))
    ) {
      throw new Error(`Backend ${route} policy has invalid limits.`);
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
}
