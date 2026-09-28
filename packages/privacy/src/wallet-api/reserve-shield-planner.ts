import { PrivacyError, type Address } from '../types.js';
import type {
  PoolReadClient,
  PublicShieldPlan,
  PublicShieldPlanInput,
  PublicShieldPlanner,
} from './types.js';

const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const MAX_U256 = (1n << 256n) - 1n;
const ONE_STRK = 10n ** 18n;

/**
 * Canonical Starknet STRK: the Bridge's only public denomination (D-043).
 * The floor and the gas allowance below are STRK amounts, so this planner
 * plans in nothing else.
 */
const STRK = BigInt('0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d');

/** D-061's floor: the planned reserve is never below 10 STRK. */
export const RESERVE_SHIELD_FLOOR = 10n * ONE_STRK;

/**
 * D-061's fixed public-gas allowance: 4 STRK.
 *
 * - A Ready shield is one pool transaction. Ready puts the ERC-20 approval
 *   and the pool call in one transaction
 *   (docs/research/ready-wallet-5.33.8-source-audit.md). A deposit is proved
 *   like any other pool action; its proof reads the depositor's token balance
 *   (the vendored strk20-privacy-sdk README).
 * - One STRK20 private transaction, read over mainnet JSON-RPC on 2026-08-15,
 *   cost 3.6133 STRK for 95,200,480 L2 gas. 4 STRK covers that with about 10%
 *   to spare. That margin is thin if gas prices rise, which is why the floor
 *   usually wins anyway. No shield receipt has been measured yet; D-056's
 *   funded shield is the evidence to recheck this against.
 * - It also equals today's headroom under the approved floor: 10 STRK minus
 *   the live 6 STRK fee. The reserve is therefore 10 STRK at today's fee, as
 *   the user approved, and it grows one for one with any fee rise. The STRK
 *   left for gas after the pool fee never drops below today's 4 STRK.
 * - Too large only keeps more STRK public in the player's wallet. Too small
 *   fails safe, because the shield is refused or reverts and the STRK stays
 *   public. It would still break the Bridge exactly when the pool fee rises.
 *   The Bank's own fee ceiling and the wallet's estimate stay authoritative
 *   at the commit point.
 */
export const RESERVE_SHIELD_GAS_ALLOWANCE = 4n * ONE_STRK;

export interface ReservePublicShieldPlannerOptions {
  /**
   * The backend-proxied pool read. Only `config()` is used, once per plan,
   * so the fee is always the live `get_fee_amount()` and never a cached one.
   */
  readonly pool: Pick<PoolReadClient, 'config'>;
  /**
   * The connected account, read on every plan. It is a plain function,
   * called without a receiver. The plan's recipient is whichever account is
   * connected when the plan is made, never a stored address.
   */
  readonly readAccount: () => Address | null | Promise<Address | null>;
}

/**
 * The production Bridge's shield planner (D-061).
 *
 * `plannedReserve = max(10 STRK, liveFee + gasAllowance)` and
 * `amountToShield = available - plannedReserve`. `liveFee` is the pool's
 * `get_fee_amount()`, read through `PoolReadClient.config()` on every call.
 * A governance fee change therefore reaches the next plan, and the Bridge's
 * commit-point revalidation sees it as a changed plan.
 *
 * The sanitized plan keeps D-043's arithmetic, `plannedReserve = poolFee +
 * gasEstimate`. So `gasEstimate` reports all of the reserve left for public
 * gas once the pool fee is paid: `max(gasAllowance, 10 STRK - liveFee)`.
 * When the floor wins, that is more than the fixed allowance. Whatever gas
 * does not spend stays public in the player's wallet.
 *
 * It fails closed by throwing, so the Bridge keeps its handoff locked, when:
 * - the fee read fails or returns a malformed value;
 * - the fee token or the input denomination is not STRK;
 * - no valid account is connected, it is not the expected recipient, or it
 *   changes while the fee is read;
 * - the remainder is not a positive, field-sized amount;
 * - the call is aborted.
 *
 * It never contacts the wallet, proves or submits anything. It sizes a
 * reserve and makes no claim that Ready supplies the pool-fee allowance (the
 * 2026-08-18 finding): if Ready does not, the separate shield reverts and
 * the bridged STRK stays public.
 */
export class ReservePublicShieldPlanner implements PublicShieldPlanner {
  private readonly readConfig: (signal?: AbortSignal) => Promise<unknown>;
  private readonly readAccountValue: () => unknown;

  constructor(options: ReservePublicShieldPlannerOptions) {
    let pool: unknown;
    let config: unknown;
    let readAccount: unknown;
    try {
      pool = ownData(options, 'pool');
      readAccount = ownData(options, 'readAccount');
      config = pool !== null && typeof pool === 'object' ? (pool as { config?: unknown }).config : undefined;
    } catch {
      throw invalidConfiguration();
    }
    if (typeof config !== 'function' || typeof readAccount !== 'function') throw invalidConfiguration();
    // Capture once: a later swap of `pool.config` cannot redirect the fee read.
    const readConfig = config;
    const reader = readAccount;
    const target = pool;
    this.readConfig = async (signal) => Reflect.apply(readConfig, target, [signal]) as unknown;
    this.readAccountValue = () => Reflect.apply(reader, undefined, []) as unknown;
  }

  async planMax(input: PublicShieldPlanInput, signal?: AbortSignal): Promise<PublicShieldPlan> {
    throwIfAborted(signal);
    const { available, expectedRecipient } = ownPlanInput(input);
    const recipient = await this.connectedAccount(expectedRecipient);
    throwIfAborted(signal);
    const poolFee = await this.livePoolFee(signal);
    // Reading the fee is the one slow step. An account switch during it would
    // bind the plan to an account that is no longer connected.
    if ((await this.connectedAccount(expectedRecipient)) !== recipient) {
      throw new PrivacyError('unknown', 'The connected account changed while the pool fee was read.');
    }
    throwIfAborted(signal);

    if (poolFee > MAX_U256 - RESERVE_SHIELD_GAS_ALLOWANCE) {
      throw new PrivacyError('unknown', 'The planned reserve overflows uint256.');
    }
    const feeAndGas = poolFee + RESERVE_SHIELD_GAS_ALLOWANCE;
    const plannedReserve = feeAndGas > RESERVE_SHIELD_FLOOR ? feeAndGas : RESERVE_SHIELD_FLOOR;
    const gasEstimate = plannedReserve - poolFee;
    const amountToShield = available - plannedReserve;
    if (amountToShield <= 0n || amountToShield >= STARK_FIELD_PRIME) {
      throw new PrivacyError('unknown', 'The available STRK leaves no positive field-sized shield after the reserve.');
    }
    if (gasEstimate <= 0n || poolFee + gasEstimate !== plannedReserve || amountToShield + plannedReserve > available) {
      throw new PrivacyError('unknown', 'The public shield arithmetic is inconsistent.');
    }
    return Object.freeze({
      token: hex(STRK),
      recipient,
      available,
      amountToShield,
      poolFee,
      gasEstimate,
      plannedReserve,
    });
  }

  private async connectedAccount(expectedRecipient: bigint | null): Promise<Address> {
    let raw: unknown;
    try {
      raw = await this.readAccountValue();
    } catch (error) {
      throw new PrivacyError('unknown', 'The connected account could not be read.', error);
    }
    const account = feltOf(raw);
    if (account === null) {
      throw new PrivacyError('unknown', 'No valid connected account can receive this shield.');
    }
    if (expectedRecipient !== null && account !== expectedRecipient) {
      throw new PrivacyError('unknown', 'The connected account does not match the expected recipient.');
    }
    return hex(account);
  }

  private async livePoolFee(signal?: AbortSignal): Promise<bigint> {
    let config: unknown;
    try {
      config = await this.readConfig(signal);
    } catch (error) {
      if (signal?.aborted) throw new PrivacyError('user-rejected', 'Operation cancelled.', error);
      if (error instanceof PrivacyError) throw error;
      throw new PrivacyError('unreachable', 'The live pool fee could not be read.', error);
    }
    throwIfAborted(signal);
    let feeAmount: unknown;
    let feeToken: unknown;
    try {
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid pool configuration');
      feeAmount = ownData(config, 'feeAmount');
      feeToken = ownData(config, 'feeToken');
    } catch {
      throw new PrivacyError('unknown', 'The pool returned an invalid fee.');
    }
    if (typeof feeAmount !== 'bigint' || feeAmount < 0n || feeAmount > MAX_U256) {
      throw new PrivacyError('unknown', 'The pool returned an invalid fee.');
    }
    if (feltOf(feeToken) !== STRK) {
      throw new PrivacyError('unknown', 'The pool fee is not denominated in the Bridge STRK.');
    }
    return feeAmount;
  }
}

function ownPlanInput(input: unknown): { available: bigint; expectedRecipient: bigint | null } {
  let token: unknown;
  let available: unknown;
  let expected: unknown;
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid plan input');
    token = ownData(input, 'token');
    available = ownData(input, 'available');
    expected = ownOptionalData(input, 'expectedRecipient');
  } catch {
    throw new PrivacyError('unknown', 'The public shield plan request is invalid.');
  }
  if (feltOf(token) !== STRK) {
    throw new PrivacyError('unknown', 'The public shield denomination is not the Bridge STRK.');
  }
  if (typeof available !== 'bigint' || available <= 0n || available > MAX_U256) {
    throw new PrivacyError('unknown', 'The available STRK must be a positive uint256.');
  }
  if (expected === undefined) return { available, expectedRecipient: null };
  const expectedRecipient = feltOf(expected);
  if (expectedRecipient === null) throw new PrivacyError('unknown', 'Invalid expected recipient address.');
  return { available, expectedRecipient };
}

/** A nonzero Stark field element spelled as 0x-prefixed hex, or null. */
function feltOf(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed > 0n && parsed < STARK_FIELD_PRIME ? parsed : null;
}

function hex(value: bigint): Address {
  return `0x${value.toString(16)}`;
}

/** An own data property, read without invoking an accessor. */
function ownData(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !('value' in descriptor)) throw new Error(`missing ${key}`);
  return descriptor.value;
}

function ownOptionalData(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) throw new Error(`accessor ${key}`);
  return descriptor.value;
}

function invalidConfiguration(): PrivacyError {
  return new PrivacyError('unknown', 'The reserve shield planner configuration is invalid.');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PrivacyError('user-rejected', 'Operation cancelled.', signal.reason);
}
