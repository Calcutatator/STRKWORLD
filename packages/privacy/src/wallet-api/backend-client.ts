import { PrivacyError, type PrivacyErrorKind, type TxResult } from '../types.js';
import type { PoolConfig } from '../operations.js';
import { MAX_VAULT_MARKETS } from '../vault.js';
import { BORROW_PAIRS, BORROW_TOKENS } from '../borrow.js';
import type {
  BorrowAssetRow,
  BorrowMarketRead,
  BorrowPairRow,
  BorrowPositionRow,
  BorrowReadClient,
  EndurReadClient,
  EndurUnstakeRead,
  PoolReadClient,
  PrivateSubmissionGateway,
  RelayFeeQuote,
  SwapQuoteAnswer,
  SwapQuoteClient,
  VaultPositionRow,
  VaultRateRow,
  VaultReadClient,
} from './types.js';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
/** D-079, D-081: more vault rows than the Vault can pin markets is a malformed answer, not a longer list. */
const MAX_VAULT_ROWS = MAX_VAULT_MARKETS;
/** D-079: a rate's decimal places; Vesu states 18. */
const MAX_RATE_DECIMALS = 36;
/** D-085: more unstaking request rows than this is a malformed answer. */
const MAX_ENDUR_ROWS = 64;
/** The relay's answer when it has no avnu key, or avnu rejected it (D-070). */
const RELAY_NOT_CONFIGURED = 'RELAY_NOT_CONFIGURED';

/** Browser client for the narrow, no-logging backend API. */
export class BackendPrivacyClient implements PoolReadClient, PrivateSubmissionGateway, VaultReadClient, BorrowReadClient, EndurReadClient, SwapQuoteClient {
  private readonly baseUrl: string;
  private readonly fetcher: FetchLike;

  constructor(
    baseUrl: string,
    fetcher?: FetchLike,
  ) {
    if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
      throw new PrivacyError('unknown', 'The private service URL is invalid.');
    }
    this.baseUrl = baseUrl;
    // Window fetch is a Web IDL method and rejects a non-Window receiver.
    // Calling it through this object's property would bind `this` to the
    // client, so retain injected fakes unchanged and bind the browser default
    // to the global receiver at the boundary.
    this.fetcher = fetcher
      ? ((input, init) => Reflect.apply(fetcher, undefined, [input, init]))
      : globalThis.fetch.bind(globalThis);
  }

  async config(signal?: AbortSignal): Promise<PoolConfig> {
    const value = await this.post('/v1/rpc/pool-config', { v: 1 }, signal);
    throwIfAborted(signal);
    const record = asRecord(value);
    return Object.freeze({
      feeAmount: asUint256(ownField(record, 'feeAmount')),
      feeToken: asFelt(ownField(record, 'feeToken')),
      proofValidityBlocks: asIntegerAtLeast(ownField(record, 'proofValidityBlocks'), 1),
      noteMaturityBlocks: asIntegerAtLeast(ownField(record, 'noteMaturityBlocks'), 0),
    });
  }

  async publicKey(address: string, signal?: AbortSignal): Promise<string> {
    if (typeof address !== 'string' || !isNonzeroFelt(address)) {
      throw new PrivacyError('unknown', 'The public-key address is invalid.');
    }
    const raw = await this.post('/v1/rpc/public-key', { v: 1, address }, signal);
    throwIfAborted(signal);
    const value = asRecord(raw);
    return asString(ownField(value, 'publicKey'));
  }

  /**
   * D-072: the backend's receipt lookup, returned as the chain gave it. A
   * transaction the network has not seen yet answers `null`. A failed read
   * rejects: `unreachable` when the service is down or out of reach, and
   * `unknown` for any other refusal (a 429, or a 502 from its node).
   */
  async receipt(transactionHash: string, signal?: AbortSignal): Promise<unknown> {
    if (typeof transactionHash !== 'string' || !isNonzeroFelt(transactionHash)) {
      throw new PrivacyError('unknown', 'The receipt transaction hash is invalid.');
    }
    const raw = await this.post('/v1/rpc/receipt', { v: 1, transactionHash }, signal);
    throwIfAborted(signal);
    return raw;
  }

  /**
   * D-077: the Vault's stand-in address for a partial commitment, from the
   * backend's read of the anonymizer's own view. The commitment goes to
   * STRKWORLD's backend only, never to a third-party RPC (D-014). The caller
   * cross-checks the address before anything is sent there.
   */
  async shadowAccount(partialCommitment: string, signal?: AbortSignal): Promise<{ address: string; deployed: boolean }> {
    if (typeof partialCommitment !== 'string' || !isNonzeroFelt(partialCommitment)) {
      throw new PrivacyError('unknown', 'The shadow-account commitment is invalid.');
    }
    const raw = await this.post('/v1/rpc/shadow-account', { v: 1, partialCommitment }, signal);
    throwIfAborted(signal);
    const value = asRecord(raw);
    const address = asFelt(ownField(value, 'address'));
    const deployed = ownField(value, 'deployed');
    if (BigInt(address) === 0n || typeof deployed !== 'boolean' || Reflect.ownKeys(value).length !== 2) {
      throw new PrivacyError('unknown', 'The private service returned an invalid response.');
    }
    return Object.freeze({ address, deployed });
  }

  /**
   * D-077, D-079: a stand-in address's position in every vault the backend
   * pins, in base units, one row per vault. The request names the address
   * alone; which vault a row belongs to is the caller's to check.
   */
  async vaultPositions(account: string, signal?: AbortSignal): Promise<readonly VaultPositionRow[]> {
    if (typeof account !== 'string' || !isNonzeroFelt(account)) {
      throw new PrivacyError('unknown', 'The Vault account is invalid.');
    }
    const raw = await this.post('/v1/rpc/vault-position', { v: 1, account }, signal);
    throwIfAborted(signal);
    const value = asRecord(raw);
    if (Reflect.ownKeys(value).length !== 1) {
      throw new PrivacyError('unknown', 'The private service returned an invalid response.');
    }
    const rows = asArray(ownField(value, 'positions'));
    if (rows.length > MAX_VAULT_ROWS) {
      throw new PrivacyError('unknown', 'The private service returned an invalid response.');
    }
    return Object.freeze(rows.map((item): VaultPositionRow => {
      const row = asRecord(item);
      const vault = asFelt(ownField(row, 'vault'));
      const ok = ownField(row, 'ok');
      if (BigInt(vault) === 0n || typeof ok !== 'boolean' || Reflect.ownKeys(row).length !== (ok ? 6 : 2)) {
        throw new PrivacyError('unknown', 'The private service returned an invalid response.');
      }
      if (!ok) return Object.freeze({ vault, ok: false as const });
      return Object.freeze({
        vault,
        ok: true as const,
        shares: asUint256(ownField(row, 'shares')),
        assets: asUint256(ownField(row, 'assets')),
        maxWithdraw: asUint256(ownField(row, 'maxWithdraw')),
        maxRedeem: asUint256(ownField(row, 'maxRedeem')),
      });
    }));
  }

  /**
   * D-085: what a stand-in address holds at Endur's withdrawal queue, from
   * the backend's pinned reads: its requests in the backend's scan window,
   * its STRK and xSTRK, its count of queue NFTs, and the chain's clock. The
   * request names the address alone; the caller classifies the rows.
   */
  async endurUnstake(account: string, signal?: AbortSignal): Promise<EndurUnstakeRead> {
    if (typeof account !== 'string' || !isNonzeroFelt(account)) {
      throw new PrivacyError('unknown', 'The unstaking account is invalid.');
    }
    const raw = await this.post('/v1/rpc/endur-unstake', { v: 1, account }, signal);
    throwIfAborted(signal);
    const value = asRecord(raw);
    const complete = ownField(value, 'complete');
    if (Reflect.ownKeys(value).length !== 6 || typeof complete !== 'boolean') {
      throw new PrivacyError('unknown', 'The private service returned an invalid response.');
    }
    const rows = asArray(ownField(value, 'requests'));
    if (rows.length > MAX_ENDUR_ROWS) {
      throw new PrivacyError('unknown', 'The private service returned an invalid response.');
    }
    return Object.freeze({
      chainTime: asIntegerAtLeast(ownField(value, 'chainTime'), 0),
      strk: asUint256(ownField(value, 'strk')),
      xstrk: asUint256(ownField(value, 'xstrk')),
      outstanding: asUint256(ownField(value, 'outstanding')),
      complete,
      requests: Object.freeze(rows.map((item) => {
        const row = asRecord(item);
        const claimed = ownField(row, 'claimed');
        const claimableNow = ownField(row, 'claimableNow');
        if (Reflect.ownKeys(row).length !== 7 || typeof claimed !== 'boolean' || typeof claimableNow !== 'boolean') {
          throw new PrivacyError('unknown', 'The private service returned an invalid response.');
        }
        return Object.freeze({
          requestId: asUint256(ownField(row, 'requestId')),
          assets: asUint256(ownField(row, 'assets')),
          shares: asUint256(ownField(row, 'shares')),
          claimed,
          requestedAt: asIntegerAtLeast(ownField(row, 'requestedAt'), 0),
          claimableAt: asIntegerAtLeast(ownField(row, 'claimableAt'), 0),
          claimableNow,
        });
      })),
    });
  }

  /**
   * D-079: Vesu's supply APY for each vault the backend pins, as the backend
   * last read Vesu's public API. The request carries nothing but a version.
   */
  async vaultRates(signal?: AbortSignal): Promise<readonly VaultRateRow[]> {
    const raw = await this.post('/v1/vault-rates', { v: 1 }, signal);
    throwIfAborted(signal);
    const value = asRecord(raw);
    if (Reflect.ownKeys(value).length !== 1) {
      throw new PrivacyError('unknown', 'The private service returned an invalid response.');
    }
    const rows = asArray(ownField(value, 'rates'));
    if (rows.length > MAX_VAULT_ROWS) {
      throw new PrivacyError('unknown', 'The private service returned an invalid response.');
    }
    return Object.freeze(rows.map((item) => {
      const row = asRecord(item);
      const vault = asFelt(ownField(row, 'vault'));
      const apy = asRecord(ownField(row, 'supplyApy'));
      const decimals = ownField(apy, 'decimals');
      if (
        BigInt(vault) === 0n
        || Reflect.ownKeys(row).length !== 2
        || Reflect.ownKeys(apy).length !== 2
        || !Number.isSafeInteger(decimals)
        || (decimals as number) < 0
        || (decimals as number) > MAX_RATE_DECIMALS
      ) {
        throw new PrivacyError('unknown', 'The private service returned an invalid response.');
      }
      return Object.freeze({
        vault,
        supplyApy: Object.freeze({ value: asUint256(ownField(apy, 'value')), decimals: decimals as number }),
      });
    }));
  }

  /**
   * D-083: Vesu's Prime pool as the backend read it just now, one row per
   * token and per pair it pins, raw. The request carries nothing but a
   * version. Which token or pair a row names is the caller's to check.
   */
  async borrowMarket(signal?: AbortSignal): Promise<BorrowMarketRead> {
    const raw = await this.post('/v1/rpc/borrow-market', { v: 1 }, signal);
    throwIfAborted(signal);
    const value = asRecord(raw);
    if (Reflect.ownKeys(value).length !== 2) {
      throw new PrivacyError('unknown', 'The private service returned an invalid response.');
    }
    const assetRows = asArray(ownField(value, 'assets'));
    const pairRows = asArray(ownField(value, 'pairs'));
    if (assetRows.length > BORROW_TOKENS.length || pairRows.length > BORROW_PAIRS.length) {
      throw new PrivacyError('unknown', 'The private service returned an invalid response.');
    }
    const assets = assetRows.map((item): BorrowAssetRow => {
      const row = asRecord(item);
      const token = asNonzeroAddress(ownField(row, 'token'));
      const ok = ownField(row, 'ok');
      if (typeof ok !== 'boolean' || Reflect.ownKeys(row).length !== (ok ? 10 : 2)) {
        throw new PrivacyError('unknown', 'The private service returned an invalid response.');
      }
      if (!ok) return Object.freeze({ token, ok: false as const });
      const priceValid = ownField(row, 'priceValid');
      if (typeof priceValid !== 'boolean') {
        throw new PrivacyError('unknown', 'The private service returned an invalid response.');
      }
      return Object.freeze({
        token,
        ok: true as const,
        price: asUint256(ownField(row, 'price')),
        priceValid,
        scale: asUint256(ownField(row, 'scale')),
        floor: asUint256(ownField(row, 'floor')),
        reserve: asUint256(ownField(row, 'reserve')),
        totalNominalDebt: asUint256(ownField(row, 'totalNominalDebt')),
        rateAccumulator: asUint256(ownField(row, 'rateAccumulator')),
        maxUtilization: asUint256(ownField(row, 'maxUtilization')),
      });
    });
    const pairs = pairRows.map((item): BorrowPairRow => {
      const row = asRecord(item);
      const collateral = asNonzeroAddress(ownField(row, 'collateral'));
      const debt = asNonzeroAddress(ownField(row, 'debt'));
      const ok = ownField(row, 'ok');
      if (typeof ok !== 'boolean' || Reflect.ownKeys(row).length !== (ok ? 7 : 3)) {
        throw new PrivacyError('unknown', 'The private service returned an invalid response.');
      }
      if (!ok) return Object.freeze({ collateral, debt, ok: false as const });
      return Object.freeze({
        collateral,
        debt,
        ok: true as const,
        maxLtv: asUint256(ownField(row, 'maxLtv')),
        liquidationFactor: asUint256(ownField(row, 'liquidationFactor')),
        debtCap: asUint256(ownField(row, 'debtCap')),
        totalNominalDebt: asUint256(ownField(row, 'totalNominalDebt')),
      });
    });
    return Object.freeze({ assets: Object.freeze(assets), pairs: Object.freeze(pairs) });
  }

  /**
   * D-083: a stand-in address's position in every pair the backend pins, in
   * base units, one row per pair. The request names the address alone.
   */
  async borrowPositions(account: string, signal?: AbortSignal): Promise<readonly BorrowPositionRow[]> {
    if (typeof account !== 'string' || !isNonzeroFelt(account)) {
      throw new PrivacyError('unknown', 'The borrow account is invalid.');
    }
    const raw = await this.post('/v1/rpc/borrow-position', { v: 1, account }, signal);
    throwIfAborted(signal);
    const value = asRecord(raw);
    if (Reflect.ownKeys(value).length !== 1) {
      throw new PrivacyError('unknown', 'The private service returned an invalid response.');
    }
    const rows = asArray(ownField(value, 'positions'));
    if (rows.length > BORROW_PAIRS.length) {
      throw new PrivacyError('unknown', 'The private service returned an invalid response.');
    }
    return Object.freeze(rows.map((item): BorrowPositionRow => {
      const row = asRecord(item);
      const collateral = asNonzeroAddress(ownField(row, 'collateral'));
      const debt = asNonzeroAddress(ownField(row, 'debt'));
      const ok = ownField(row, 'ok');
      if (typeof ok !== 'boolean' || Reflect.ownKeys(row).length !== (ok ? 7 : 3)) {
        throw new PrivacyError('unknown', 'The private service returned an invalid response.');
      }
      if (!ok) return Object.freeze({ collateral, debt, ok: false as const });
      return Object.freeze({
        collateral,
        debt,
        ok: true as const,
        collateralShares: asUint256(ownField(row, 'collateralShares')),
        nominalDebt: asUint256(ownField(row, 'nominalDebt')),
        collateralAmount: asUint256(ownField(row, 'collateralAmount')),
        debtAmount: asUint256(ownField(row, 'debtAmount')),
      });
    }));
  }

  async estimate(input: Parameters<PrivateSubmissionGateway['estimate']>[0]): Promise<RelayFeeQuote> {
    const route = ownInputField(input, 'route');
    const feeToken = ownInputField(input, 'feeToken');
    const operationToken = ownInputField(input, 'operationToken');
    const signal = ownOptionalInputField(input, 'signal');
    if (
      (route !== 'transfer' && route !== 'unshield' && route !== 'stake')
      || typeof feeToken !== 'string'
      || !isNonzeroFelt(feeToken)
      || typeof operationToken !== 'string'
      || !isNonzeroFelt(operationToken)
      || (signal !== undefined && !isAbortSignal(signal))
    ) {
      throw new PrivacyError('unknown', 'The relay estimate request is invalid.');
    }
    const raw = await this.post('/v1/private/fees', {
      v: 1,
      route,
      feeToken,
      operationToken,
    }, signal as AbortSignal | undefined);
    throwIfAborted(signal as AbortSignal | undefined);
    const value = asRecord(raw);
    return Object.freeze({
      token: asString(ownField(value, 'token')),
      recipient: asString(ownField(value, 'recipient')),
      amount: asDecimalBigInt(ownField(value, 'amount')),
      authorization: asString(ownField(value, 'authorization')),
      expiresAtBlock: asInteger(ownField(value, 'expiresAtBlock')),
    });
  }

  async submit(input: Parameters<PrivateSubmissionGateway['submit']>[0]): Promise<TxResult> {
    const route = ownInputField(input, 'route');
    const artifact = toWireArtifact(ownJsonValue(ownInputField(input, 'artifact')));
    const feeAuthorization = ownInputField(input, 'feeAuthorization');
    const proofValidityBlocks = ownInputField(input, 'proofValidityBlocks');
    const signal = ownOptionalInputField(input, 'signal');
    const onAccepted = ownOptionalInputField(input, 'onAccepted');
    if (
      (route !== 'transfer' && route !== 'unshield' && route !== 'stake')
      || !artifact
      || typeof artifact !== 'object'
      || Array.isArray(artifact)
      || typeof feeAuthorization !== 'string'
      || feeAuthorization.trim().length === 0
      || !Number.isSafeInteger(proofValidityBlocks)
      || (proofValidityBlocks as number) <= 0
      || (signal !== undefined && !isAbortSignal(signal))
      || (onAccepted !== undefined && typeof onAccepted !== 'function')
    ) {
      throw new PrivacyError('unknown', 'The private submission request is invalid.');
    }
    const value = asRecord(await this.post('/v1/private/submissions', {
      v: 1,
      route,
      artifact,
      feeAuthorization,
      proofValidityBlocks,
    }, signal as AbortSignal | undefined, 'submission-uncertain'));
    const transactionHash = asString(ownField(value, 'transactionHash'));
    if (!isNonzeroFelt(transactionHash)) {
      throw new PrivacyError('unknown', 'The private service returned an invalid response.');
    }
    const result = Object.freeze({ transactionHash });
    try {
      (onAccepted as ((result: TxResult) => void) | undefined)?.(result);
    } catch {
      // Acceptance observers cannot turn a validated accepted transaction
      // back into a rejected promise and invite an unsafe retry.
    }
    return result;
  }

  /**
   * avnu's public, keyless swap quote for the swap stand-in (D-084), through
   * the backend's thin proxy so the player's IP never reaches avnu next to
   * that address and the amounts (D-014). Typed here, checked by the swap.
   */
  async quoteSwap(input: Parameters<SwapQuoteClient['quoteSwap']>[0]): Promise<SwapQuoteAnswer> {
    const sellToken = ownInputField(input, 'sellToken');
    const buyToken = ownInputField(input, 'buyToken');
    const sellAmount = ownInputField(input, 'sellAmount');
    const taker = ownInputField(input, 'taker');
    const slippageBps = ownInputField(input, 'slippageBps');
    const signal = ownOptionalInputField(input, 'signal');
    if (
      typeof sellToken !== 'string'
      || !isNonzeroFelt(sellToken)
      || typeof buyToken !== 'string'
      || !isNonzeroFelt(buyToken)
      || typeof taker !== 'string'
      || !isNonzeroFelt(taker)
      || typeof sellAmount !== 'bigint'
      || sellAmount <= 0n
      || sellAmount > MAX_UINT256
      || !Number.isSafeInteger(slippageBps)
      || (slippageBps as number) <= 0
      || (slippageBps as number) > 10_000
      || (signal !== undefined && !isAbortSignal(signal))
    ) {
      throw new PrivacyError('unknown', 'The swap quote request is invalid.');
    }
    const raw = await this.post('/v1/swap/quote', {
      v: 1,
      sellToken,
      buyToken,
      sellAmount: sellAmount.toString(),
      taker,
      slippageBps,
    }, signal as AbortSignal | undefined);
    throwIfAborted(signal as AbortSignal | undefined);
    const value = asRecord(raw);
    const calls = asArray(ownField(value, 'calls')).map((entry) => {
      const call = asRecord(entry);
      return Object.freeze({
        contractAddress: asString(ownField(call, 'contractAddress')),
        entrypoint: asString(ownField(call, 'entrypoint')),
        calldata: Object.freeze(asArray(ownField(call, 'calldata')).map(asString)),
      });
    });
    return Object.freeze({
      quoteId: asNonEmptyString(ownField(value, 'quoteId')),
      chainId: asString(ownField(value, 'chainId')),
      sellToken: asString(ownField(value, 'sellToken')),
      buyToken: asString(ownField(value, 'buyToken')),
      sellAmount: asPositiveDecimalBigInt(ownField(value, 'sellAmount')),
      buyAmount: asPositiveDecimalBigInt(ownField(value, 'buyAmount')),
      calls: Object.freeze(calls),
    });
  }

  private async post(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    transportFailureKind: PrivacyErrorKind = 'unreachable',
  ): Promise<unknown> {
    throwIfAborted(signal);
    let pendingResponse: Promise<Response>;
    try {
      pendingResponse = this.fetcher(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new PrivacyError('unreachable', 'The private service could not be reached.', error);
    }
    let response: Response;
    try {
      response = await pendingResponse;
    } catch (error) {
      // Once a private submission has been dispatched, a missing response is
      // authoritative uncertainty even if the caller cancels concurrently.
      // Reclassifying it as cancellation would make an accepted transaction
      // look safely retryable.
      if (transportFailureKind !== 'submission-uncertain' && signal?.aborted) throwIfAborted(signal);
      throw new PrivacyError(
        transportFailureKind,
        transportFailureKind === 'submission-uncertain'
          ? 'The private submission response was lost.'
          : 'The private service could not be reached.',
        error,
      );
    }
    const responseMeta = ownResponseMeta(response);
    if (!responseMeta.ok) {
      const status = responseMeta.status;
      let failure: unknown;
      try {
        failure = await responseMeta.json();
      } catch (error) {
        if (transportFailureKind === 'submission-uncertain') {
          throw new PrivacyError('submission-uncertain', 'The private submission response was lost.', error);
        }
        failure = null;
      }
      const message = readErrorField(failure, 'message');
      // D-070: a definite refusal before anything was relayed, and not one a
      // retry can fix, so it is neither `unreachable` nor uncertain.
      if (status === 503 && readErrorField(failure, 'code') === RELAY_NOT_CONFIGURED) {
        throw new PrivacyError(
          'relay-not-configured',
          message ?? 'The private relay is not configured on this deployment.',
        );
      }
      throw new PrivacyError(
        status === 503 ? 'unreachable' : 'unknown',
        message ?? 'The private service rejected the request.',
      );
    }
    try {
      return await responseMeta.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new PrivacyError('unknown', 'The private service returned an invalid response.', error);
      }
      throw new PrivacyError(
        transportFailureKind,
        transportFailureKind === 'submission-uncertain'
          ? 'The private submission response was lost.'
          : 'The private service response was lost.',
        error,
      );
    }
  }
}

/**
 * The proved artifact in the shape the relay takes: the Wallet API's own
 * `STRK20_CALL_AND_PROOF`, whose call is `{ contract_address, entry_point,
 * calldata }`. That is what the wallet answers and what avnu's paymaster
 * executes. Since starknet.js 10.8 (the D-077 bump), `WalletAccountV6` hands a
 * dapp a starknet.js `Call` instead, `{ contractAddress, entrypoint, calldata }`,
 * converted from the wallet's answer, so it is converted back here, at the one
 * place that knows the relay's wire format. Anything but exactly that call and a
 * proof is refused whole, before transport.
 *
 * `value` is already this client's own JSON copy (`ownJsonValue`), so the reads
 * below touch plain data only.
 */
function toWireArtifact(value: unknown): unknown {
  // A missing or malformed artifact is refused by `submit`'s own checks.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const call = record['call'];
  if (
    Reflect.ownKeys(record).length !== 2
    || !Object.hasOwn(record, 'proof')
    || !call
    || typeof call !== 'object'
    || Array.isArray(call)
    || Reflect.ownKeys(call).length !== 3
  ) {
    throw new PrivacyError('unknown', 'The private submission request is invalid.');
  }
  const { contractAddress, entrypoint, calldata } = call as Record<string, unknown>;
  if (typeof contractAddress !== 'string' || typeof entrypoint !== 'string' || !Array.isArray(calldata)) {
    throw new PrivacyError('unknown', 'The private submission request is invalid.');
  }
  return { call: { contract_address: contractAddress, entry_point: entrypoint, calldata }, proof: record['proof'] };
}

function ownJsonValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PrivacyError('unknown', 'The private submission request is invalid.');
    return value;
  }
  if (Array.isArray(value)) {
    try {
      const length = Object.getOwnPropertyDescriptor(value, 'length');
      if (!length || !('value' in length) || !Number.isSafeInteger(length.value)
        || Reflect.ownKeys(value).length !== length.value + 1) {
        throw new Error('invalid artifact array');
      }
      const owned: unknown[] = [];
      for (let index = 0; index < length.value; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) throw new Error('invalid artifact array item');
        owned.push(ownJsonValue(descriptor.value));
      }
      return owned;
    } catch (error) {
      if (error instanceof PrivacyError) throw error;
      throw new PrivacyError('unknown', 'The private submission request is invalid.', error);
    }
  }
  if (!value || typeof value !== 'object') {
    throw new PrivacyError('unknown', 'The private submission request is invalid.');
  }
  try {
    const owned: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new Error('invalid artifact key');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw new Error('invalid artifact field');
      Object.defineProperty(owned, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: ownJsonValue(descriptor.value),
      });
    }
    return owned;
  } catch (error) {
    if (error instanceof PrivacyError) throw error;
    throw new PrivacyError('unknown', 'The private submission request is invalid.', error);
  }
}

function ownInputField(input: unknown, key: string): unknown {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('invalid input');
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor)) throw new Error('missing input field');
    return descriptor.value;
  } catch {
    throw new PrivacyError('unknown', 'The private service request is invalid.');
  }
}

function ownOptionalInputField(input: unknown, key: string): unknown {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('invalid input');
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor) return undefined;
    if (!('value' in descriptor)) throw new Error('invalid optional input field');
    return descriptor.value;
  } catch {
    throw new PrivacyError('unknown', 'The private service request is invalid.');
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    if (value instanceof AbortSignal) return true;
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype === null) return false;
    const aborted = ownSignalMember(value, prototype, 'aborted');
    const reason = ownSignalMember(value, prototype, 'reason');
    const addEventListener = ownSignalMember(value, prototype, 'addEventListener');
    const removeEventListener = ownSignalMember(value, prototype, 'removeEventListener');
    return aborted.found && typeof aborted.value === 'boolean'
      && reason.found && typeof addEventListener.value === 'function'
      && typeof removeEventListener.value === 'function';
  } catch {
    return false;
  }
}

function ownSignalMember(
  value: object,
  prototype: object,
  key: PropertyKey,
): { readonly found: boolean; readonly value: unknown } {
  for (const current of [value, prototype]) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      return 'value' in descriptor
        ? { found: true, value: descriptor.value }
        : { found: false, value: undefined };
    }
  }
  return { found: false, value: undefined };
}

function ownResponseJson(response: Response): () => Promise<unknown> {
  try {
    let current: object | null = response;
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'json');
      if (descriptor) {
        if ('value' in descriptor && typeof descriptor.value === 'function') {
          return descriptor.value.bind(response) as () => Promise<unknown>;
        }
        break;
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    // Fall through to one controlled provider-response failure.
  }
  throw new PrivacyError('unknown', 'The private service returned an invalid response.');
}

function ownResponseMeta(response: Response): { ok: boolean; status: number; json: () => Promise<unknown> } {
  try {
    if (response instanceof Response) {
      return { ok: response.ok, status: response.status, json: ownResponseJson(response) };
    }
  } catch {
    // Continue into descriptor-only validation for malformed implementations.
  }
  try {
    let current: object | null = response;
    while (current !== null) {
      const ok = Object.getOwnPropertyDescriptor(current, 'ok');
      const status = Object.getOwnPropertyDescriptor(current, 'status');
      const json = Object.getOwnPropertyDescriptor(current, 'json');
      if (ok || status) {
        if (
          ok && 'value' in ok && typeof ok.value === 'boolean'
          && status && 'value' in status && typeof status.value === 'number'
          && json && 'value' in json && typeof json.value === 'function'
        ) {
          return { ok: ok.value, status: status.value, json: json.value.bind(response) as () => Promise<unknown> };
        }
        break;
      }
      const prototype = Object.getPrototypeOf(current) as object | null;
      if (prototype === null) break;
      const prototypeOk = Object.getOwnPropertyDescriptor(prototype, 'ok');
      const prototypeStatus = Object.getOwnPropertyDescriptor(prototype, 'status');
      const prototypeJson = Object.getOwnPropertyDescriptor(prototype, 'json');
      if (
        prototypeOk && 'value' in prototypeOk && typeof prototypeOk.value === 'boolean'
        && prototypeStatus && 'value' in prototypeStatus && typeof prototypeStatus.value === 'number'
        && prototypeJson && 'value' in prototypeJson && typeof prototypeJson.value === 'function'
      ) {
        return {
          ok: prototypeOk.value,
          status: prototypeStatus.value,
          json: prototypeJson.value.bind(response) as () => Promise<unknown>,
        };
      }
      current = Object.getPrototypeOf(prototype) as object | null;
    }
  } catch {
    // Fall through to a controlled invalid response.
  }
  throw new PrivacyError('unknown', 'The private service returned an invalid response.');
}

function readErrorField(value: unknown, key: 'message' | 'code'): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value
      : null;
  } catch {
    // A descriptor trap reads as no field, never as a raw error.
    return null;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PrivacyError('user-rejected', 'Operation cancelled.', signal.reason);
}

function isNonzeroFelt(value: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(value)
    && BigInt(value) > 0n
    && BigInt(value) < STARK_FIELD_PRIME;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  return value as Record<string, unknown>;
}

function ownField(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !('value' in descriptor)) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  return descriptor.value;
}

function asUint256(value: unknown): bigint {
  const text = asString(value);
  if (!/^\d+$/.test(text)) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  let parsed: bigint;
  try {
    parsed = BigInt(text);
  } catch {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  if (parsed < 0n || parsed > MAX_UINT256) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  return parsed;
}

function asFelt(value: unknown): string {
  const text = asString(value);
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(text)) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  let parsed: bigint;
  try {
    parsed = BigInt(text);
  } catch {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  if (parsed >= STARK_FIELD_PRIME) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  return text;
}

function asNonzeroAddress(value: unknown): string {
  const felt = asFelt(value);
  if (BigInt(felt) === 0n) throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  return felt;
}

function asDecimalBigInt(value: unknown): bigint {
  const text = asString(value);
  if (!/^\d+$/.test(text)) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  try {
    return BigInt(text);
  } catch {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
}

function asPositiveDecimalBigInt(value: unknown): bigint {
  const parsed = asDecimalBigInt(value);
  if (parsed <= 0n) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  return parsed;
}

function asString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  return value;
}

function asNonEmptyString(value: unknown): string {
  const text = asString(value);
  if (text.length === 0) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  return text;
}

function asInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  return value;
}

function asIntegerAtLeast(value: unknown, minimum: number): number {
  const parsed = asInteger(value);
  if (parsed < minimum) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  return parsed;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  // `Array.prototype.map` skips holes (and invokes indexed accessors). A
  // sparse or accessor-backed response would become a different, partially
  // unchecked action/calldata list after parsing.
  let length: number;
  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      !lengthDescriptor
      || !('value' in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || Reflect.ownKeys(value).length !== lengthDescriptor.value + 1
    ) {
      throw new PrivacyError('unknown', 'The private service returned an invalid response.');
    }
    length = lengthDescriptor.value as number;
  } catch (error) {
    if (error instanceof PrivacyError) throw error;
    throw new PrivacyError('unknown', 'The private service returned an invalid response.', error);
  }
  const owned: unknown[] = [];
  try {
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) {
        throw new Error('invalid response array item');
      }
      owned.push(descriptor.value);
    }
  } catch (error) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.', error);
  }
  return owned;
}
