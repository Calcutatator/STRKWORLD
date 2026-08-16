import { AggregateMetrics, AggregateRateLimiter } from './metrics.js';
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

interface BackendApiOptions {
  config: BackendConfig;
  paymaster: PaymasterPort;
  rpc: PoolRpcPort;
  authorizations: AuthorizationCodec;
  randomInt?: (maxInclusive: number) => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class BackendApi {
  readonly metrics = new AggregateMetrics();
  private readonly limiter: AggregateRateLimiter;
  private readonly config: BackendConfig;
  private readonly paymaster: PaymasterPort;
  private readonly rpc: PoolRpcPort;
  private readonly authorizations: AuthorizationCodec;
  private readonly randomInt: (maxInclusive: number) => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: BackendApiOptions) {
    this.config = options.config;
    this.paymaster = options.paymaster;
    this.rpc = options.rpc;
    this.authorizations = options.authorizations;
    this.randomInt = options.randomInt ?? ((max) => Math.floor(Math.random() * (max + 1)));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const now = options.now ?? Date.now;
    this.limiter = new AggregateRateLimiter(
      this.config.rateLimit.maxRequests,
      this.config.rateLimit.windowMs,
      now,
    );
  }

  async handle(request: ApiRequest): Promise<ApiResponse> {
    this.metrics.request();
    if (!this.limiter.take()) {
      this.metrics.limited();
      return { status: 429, body: { code: 'RATE_LIMITED', message: 'Service is busy. Try again shortly.' } };
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
    const feeToken = requireFelt(value.feeToken, 'fee token');
    const operationToken = requireFelt(value.operationToken, 'operation token');
    if (!sameAddress(feeToken, this.config.feeToken)) {
      throw new ApiFailure(400, 'Fee token is not allowlisted.');
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
    if (fee.amount < 0n || fee.amount > policy.maxRelayFee) {
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
    validateServerActionRoute(route, artifact, {
      token: claims.token,
      recipient: claims.recipient,
      amount: claims.amount,
    });

    let block = await this.rpc.getBlockNumber();
    if (block > claims.expiresAtBlock) throw new ApiFailure(409, 'Prepared proof has expired.');
    if (!policy.quoteBound && policy.maxQueueDelayMs > 0) {
      const delay = clamp(this.randomInt(policy.maxQueueDelayMs), 0, policy.maxQueueDelayMs);
      if (delay > 0) await this.sleep(delay);
      block = await this.rpc.getBlockNumber();
      if (block > claims.expiresAtBlock) throw new ApiFailure(409, 'Prepared proof expired in the queue.');
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
    if (claims.amount < 0n || claims.amount > maxFee) throw new ApiFailure(401, 'Fee authorization exceeds policy.');
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

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
