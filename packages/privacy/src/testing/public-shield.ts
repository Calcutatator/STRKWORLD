import { PrivacyError } from '../types.js';
import type {
  PublicShieldPlan,
  PublicShieldPlanInput,
  PublicShieldPlanner,
} from '../wallet-api/types.js';

const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const MAX_U256 = (1n << 256n) - 1n;

export interface FakePublicShieldPlannerConfig {
  /** Explicit Bridge public-STRK denomination for every configured amount. */
  token: string;
  recipient: string;
  poolFee: bigint;
  gasEstimate: bigint | readonly bigint[];
}

/** Deterministic public-shield planner; every estimate is explicit fixture data. */
export class FakePublicShieldPlanner implements PublicShieldPlanner {
  private readonly token: string;
  private readonly recipient: string;
  private readonly poolFee: bigint;
  private readonly estimates: readonly bigint[];
  private calls = 0;

  constructor(config: FakePublicShieldPlannerConfig) {
    this.token = normalise(config.token, 'fake shield token');
    this.recipient = normalise(config.recipient, 'fake recipient');
    assertU256(config.poolFee, 'fake pool fee');
    this.poolFee = config.poolFee;
    this.estimates = (Array.isArray(config.gasEstimate) ? config.gasEstimate : [config.gasEstimate]).map((value) => {
      assertU256(value, 'fake gas estimate');
      if (value <= 0n) {
        throw new PrivacyError('unknown', 'The fake gas estimate must be positive.');
      }
      return value;
    });
    if (this.estimates.length === 0) throw new PrivacyError('unknown', 'The fake gas estimate is required.');
  }

  async planMax(input: PublicShieldPlanInput, signal?: AbortSignal): Promise<PublicShieldPlan> {
    if (signal?.aborted) throw new PrivacyError('user-rejected', 'Operation cancelled.');
    const token = normalise(input.token, 'fake shield token');
    if (token !== this.token) {
      throw new PrivacyError('unknown', 'The fake public shield token denomination does not match.');
    }
    assertU256(input.available, 'fake available amount');
    if (input.available <= 0n) {
      throw new PrivacyError('unknown', 'The fake available amount must be positive.');
    }
    if (input.expectedRecipient !== undefined && normalise(input.expectedRecipient, 'expected recipient') !== this.recipient) {
      throw new PrivacyError('unknown', 'The fake account does not match the expected recipient.');
    }
    const gasEstimate = this.estimates[Math.min(this.calls, this.estimates.length - 1)]!;
    if (this.poolFee > MAX_U256 - gasEstimate) {
      throw new PrivacyError('unknown', 'The fake public reserve overflows uint256.');
    }
    const plannedReserve = this.poolFee + gasEstimate;
    const amountToShield = input.available - plannedReserve;
    if (amountToShield <= 0n || amountToShield > MAX_U256 || amountToShield >= STARK_FIELD_PRIME) {
      throw new PrivacyError('unknown', 'The fake reserve leaves no positive field-sized shield.');
    }
    if (amountToShield + plannedReserve > MAX_U256 || amountToShield + plannedReserve > input.available) {
      throw new PrivacyError('unknown', 'The fake public shield arithmetic is inconsistent.');
    }
    if (signal?.aborted) throw new PrivacyError('user-rejected', 'Operation cancelled.');
    const plan = Object.freeze({
      token,
      recipient: this.recipient,
      available: input.available,
      amountToShield,
      poolFee: this.poolFee,
      gasEstimate,
      plannedReserve,
    });
    this.calls += 1;
    return plan;
  }
}

function normalise(address: unknown, label: string): string {
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(address)) {
    throw new PrivacyError('unknown', `Invalid ${label} address.`);
  }
  let value: bigint;
  try { value = BigInt(address); } catch { throw new PrivacyError('unknown', `Invalid ${label} address.`); }
  if (value <= 0n || value >= STARK_FIELD_PRIME) throw new PrivacyError('unknown', `Invalid ${label} address.`);
  return `0x${value.toString(16)}`;
}

function assertU256(value: unknown, label: string): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_U256) {
    throw new PrivacyError('unknown', `Invalid ${label}; expected a uint256.`);
  }
}
