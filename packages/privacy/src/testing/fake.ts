import {
  PrivacyError,
  type Address,
  type OperationProgress,
  type PrivacyErrorKind,
  type PrivateBalance,
  type ProgressCallback,
  type RecipientStatus,
  type TxResult,
} from '../types.js';
import type {
  BatchWarning,
  Intent,
  PoolConfig,
  PreparedBatch,
  PrivacyOperations,
  WalletCapability,
} from '../operations.js';

/**
 * A deterministic, in-memory `PrivacyOperations`.
 *
 * This exists so the Shell and World lanes can build and test every building
 * without a wallet, without mainnet, and without spending 6 STRK per action.
 * It is the thing that makes the mainnet-only decision (D-001) survivable.
 *
 * Deterministic on purpose: no clocks, no randomness, no network. Block height
 * only advances when a test says so. Two runs of the same script produce byte
 * identical results, which is what makes it usable in CI.
 *
 * It models the sharp edges rather than the happy path, because the happy path
 * is not what breaks:
 *   - notes are unspendable until they mature
 *   - the pool fee comes out of the same balance being spent
 *   - the fee can change between prepare and confirm
 *   - a shield cannot be batched with the transfer it funds
 *   - deposits are always to self
 */

export interface FakeConfig {
  /** Starting shielded balances, token → amount. */
  balances?: Record<Address, bigint>;
  /** Addresses registered in the pool and able to receive. */
  registered?: Address[];
  poolConfig?: Partial<PoolConfig>;
  capability?: Partial<WalletCapability>;
  /** Simulated latency in ms. Tests usually want 0. */
  latencyMs?: number;
}

const DEFAULT_POOL: PoolConfig = {
  feeAmount: 6_000000000000000000n, // 6 STRK — the live mainnet value
  feeToken: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
  proofValidityBlocks: 450,
  noteMaturityBlocks: 10,
};

/** A fault the next matching call will raise. Consumed on use unless `sticky`. */
export interface Fault {
  kind: PrivacyErrorKind;
  /** Limit to one method. Omit to affect the next call of any kind. */
  on?: 'capability' | 'poolConfig' | 'balances' | 'recipientStatus' | 'prepare' | 'confirm';
  message?: string;
  sticky?: boolean;
}

interface MaturingNote {
  token: Address;
  amount: bigint;
  matureAtBlock: number;
}

export class FakePrivacyOperations implements PrivacyOperations {
  private spendable = new Map<Address, bigint>();
  private maturing: MaturingNote[] = [];
  private registeredAddrs: Set<string>;
  private pool: PoolConfig;
  private cap: WalletCapability;
  private faults: Fault[] = [];
  private latency: number;
  private block = 0;
  private txCounter = 0;

  /** Every confirmed batch, in order. Assert against this in tests. */
  readonly submitted: Intent[][] = [];

  constructor(config: FakeConfig = {}) {
    for (const [token, amount] of Object.entries(config.balances ?? {})) {
      this.spendable.set(token, amount);
    }
    this.registeredAddrs = new Set(
      (config.registered ?? []).map((a) => normalise(a)),
    );
    this.pool = { ...DEFAULT_POOL, ...config.poolConfig };
    this.cap = {
      supportsStrk20: true,
      walletApiVersion: '0.10.3',
      registration: 'registered',
      ...config.capability,
    };
    this.latency = config.latencyMs ?? 0;
  }

  // -- test controls --------------------------------------------------------

  /** Make the next matching call fail. */
  injectFault(fault: Fault): void {
    this.faults.push(fault);
  }

  /** Advance the chain. Matures any notes whose time has come. */
  advanceBlocks(n: number): void {
    this.block += n;
    const stillMaturing: MaturingNote[] = [];
    for (const note of this.maturing) {
      if (note.matureAtBlock <= this.block) {
        this.credit(note.token, note.amount);
      } else {
        stillMaturing.push(note);
      }
    }
    this.maturing = stillMaturing;
  }

  /**
   * Change the pool fee mid-flight.
   *
   * The real fee is governance-settable and has already moved once, so a
   * batch prepared at one fee can be confirmed at another. `confirm` must
   * reject when that breaches the ceiling — this is how you test it.
   */
  setPoolFee(feeAmount: bigint): void {
    this.pool = { ...this.pool, feeAmount };
  }

  get currentBlock(): number {
    return this.block;
  }

  // -- PrivacyOperations ----------------------------------------------------

  async capability(signal?: AbortSignal): Promise<WalletCapability> {
    await this.tick('capability', signal);
    return { ...this.cap };
  }

  async poolConfig(signal?: AbortSignal): Promise<PoolConfig> {
    await this.tick('poolConfig', signal);
    return { ...this.pool };
  }

  async balances(tokens?: Address[], signal?: AbortSignal): Promise<PrivateBalance[]> {
    await this.tick('balances', signal);
    const keys = tokens?.length
      ? tokens
      : [...new Set([...this.spendable.keys(), ...this.maturing.map((n) => n.token)])];
    return keys.map((token) => {
      const spendable = this.spendable.get(token) ?? 0n;
      const maturing = this.maturing
        .filter((n) => sameAddress(n.token, token))
        .reduce((sum, n) => sum + n.amount, 0n);
      return { token, spendable, maturing, total: spendable + maturing, maturityKnown: true };
    });
  }

  async recipientStatus(address: Address, signal?: AbortSignal): Promise<RecipientStatus> {
    await this.tick('recipientStatus', signal);
    return this.registeredAddrs.has(normalise(address)) ? 'registered' : 'unregistered';
  }

  async prepare(intents: Intent[], signal?: AbortSignal): Promise<PreparedBatch> {
    await this.tick('prepare', signal);
    if (intents.length === 0) {
      throw new PrivacyError('unknown', 'prepare called with no intents');
    }
    for (const intent of intents) {
      const amount = intent.kind === 'swap' ? intent.amountIn : intent.amount;
      if (amount <= 0n) throw new PrivacyError('unknown', 'Amounts must be positive.');
      if (intent.kind === 'swap' && intent.minAmountOut <= 0n) {
        throw new PrivacyError('unknown', 'Minimum output must be positive.');
      }
    }

    const warnings: BatchWarning[] = [];
    const feeAtPrepare = this.pool.feeAmount;

    // A shield cannot ride along with the transfer it funds: the deposit's
    // public leg names the depositor, so bundling publishes the link.
    const hasShield = intents.some((i) => i.kind === 'shield');
    const hasSpend = intents.some((i) => i.kind !== 'shield');
    if (hasShield && hasSpend) {
      throw new PrivacyError(
        'privacy-leak',
        'Shielding and private spending must be prepared as separate operations.',
      );
    }
    const kinds = new Set(intents.map((intent) => intent.kind));
    if (!hasShield && kinds.size > 1) {
      throw new PrivacyError('unknown', 'A private batch may contain only one approved route type.');
    }
    if (kinds.has('swap') && intents.length > 1) {
      throw new PrivacyError('unknown', 'A private swap must be prepared one at a time.');
    }
    const promptCount = 1;

    for (const intent of intents) {
      if (intent.kind === 'shield') {
        warnings.push({
          kind: 'public-leg',
          detail: `Depositing ${intent.amount} is public: the amount and your address are visible on-chain.`,
        });
      }
      if (intent.kind === 'unshield') {
        warnings.push({
          kind: 'public-leg',
          detail: `Withdrawing reveals the amount and ${intent.recipient} on-chain.`,
        });
      }
      if (intent.kind === 'transfer' && !this.registeredAddrs.has(normalise(intent.recipient))) {
        throw new PrivacyError(
          'not-registered',
          'The recipient is not registered with the privacy pool.',
        );
      }
    }

    // Charge spends in their own token and the pool fee in the fee token.
    const spendByToken = new Map<string, bigint>();
    for (const intent of intents) {
      if (intent.kind === 'shield') continue;
      const token = intent.kind === 'swap' ? intent.tokenIn : intent.token;
      const amount = intent.kind === 'swap' ? intent.amountIn : intent.amount;
      spendByToken.set(normalise(token), (spendByToken.get(normalise(token)) ?? 0n) + amount);
    }
    if (hasSpend) {
      const feeToken = normalise(this.pool.feeToken);
      spendByToken.set(feeToken, (spendByToken.get(feeToken) ?? 0n) + feeAtPrepare);
    }
    for (const [token, required] of spendByToken) {
      const have = this.spendable.get(token) ?? this.lookupLoose(token);
      const remaining = have - required;
      if (remaining < 0n) {
        throw new PrivacyError(
          'insufficient-balance',
          `Needs ${required}, has ${have}. Remember the pool fee is paid in ${this.pool.feeToken}.`,
        );
      }
      if (sameAddress(token, this.pool.feeToken) && remaining < feeAtPrepare) {
        warnings.push({ kind: 'leaves-below-fee', remaining, feeEstimate: feeAtPrepare });
      }
    }

    const maturingTotal = this.maturing.reduce((s, n) => s + n.amount, 0n);
    if (maturingTotal > 0n) {
      const soonest = Math.min(...this.maturing.map((n) => n.matureAtBlock));
      warnings.push({
        kind: 'funds-maturing',
        maturingAmount: maturingTotal,
        blocksRemaining: Math.max(0, soonest - this.block),
      });
    }

    const gasEstimate = 1_000000000000000n;
    const self = this;
    let discarded = false;
    let confirmationAttempted = false;

    return {
      intents: [...intents],
      poolFee: feeAtPrepare,
      gasEstimate,
      totalCost: feeAtPrepare + gasEstimate,
      warnings,
      promptCount,
      async confirm({ feeCeiling, onProgress, signal: sig }) {
        if (discarded) throw new PrivacyError('unknown', 'batch already discarded');
        if (confirmationAttempted) {
          throw new PrivacyError('unknown', 'This batch was already confirmed or attempted. Prepare a new batch.');
        }
        confirmationAttempted = true;
        await self.tick('confirm', sig);

        // The fee can move between prepare and confirm. This is the guard.
        if (self.pool.feeAmount > feeCeiling) {
          throw new PrivacyError(
            'unknown',
            `Pool fee is now ${self.pool.feeAmount}, above the ceiling of ${feeCeiling}. Re-prepare.`,
          );
        }

        emitProgress(onProgress, { stage: 'awaiting-approval', message: 'Confirm in your wallet' });
        emitProgress(onProgress, { stage: 'proving', message: 'Your wallet is generating a proof' });
        emitProgress(onProgress, { stage: 'submitting', message: 'Submitting' });

        self.applyIntents(intents, self.pool.feeAmount);
        self.submitted.push([...intents]);
        emitProgress(onProgress, { stage: 'done', message: 'Done' });
        return { transactionHash: `0xfake${(++self.txCounter).toString(16).padStart(4, '0')}` };
      },
      discard() {
        discarded = true;
      },
    };
  }

  // -- internals ------------------------------------------------------------

  private applyIntents(intents: Intent[], fee: bigint): void {
    let feeCharged = false;
    for (const intent of intents) {
      switch (intent.kind) {
        case 'shield':
          // Always to self, and not spendable until it matures.
          this.maturing.push({
            token: intent.token,
            amount: intent.amount,
            matureAtBlock: this.block + this.pool.noteMaturityBlocks,
          });
          break;
        case 'unshield':
        case 'transfer':
          this.debit(intent.token, intent.amount);
          break;
        case 'swap':
          this.debit(intent.tokenIn, intent.amountIn);
          this.maturing.push({
            token: intent.tokenOut,
            amount: intent.minAmountOut,
            matureAtBlock: this.block + this.pool.noteMaturityBlocks,
          });
          break;
      }
      if (!feeCharged && intent.kind !== 'shield') {
        this.debit(this.pool.feeToken, fee);
        feeCharged = true;
      }
    }
  }

  private lookupLoose(token: string): bigint {
    for (const [key, value] of this.spendable) {
      if (sameAddress(key, token)) return value;
    }
    return 0n;
  }

  private credit(token: Address, amount: bigint): void {
    for (const key of this.spendable.keys()) {
      if (sameAddress(key, token)) {
        this.spendable.set(key, (this.spendable.get(key) ?? 0n) + amount);
        return;
      }
    }
    this.spendable.set(token, amount);
  }

  private debit(token: Address, amount: bigint): void {
    for (const key of this.spendable.keys()) {
      if (sameAddress(key, token)) {
        this.spendable.set(key, (this.spendable.get(key) ?? 0n) - amount);
        return;
      }
    }
    this.spendable.set(token, -amount);
  }

  private async tick(method: Fault['on'], signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new PrivacyError('user-rejected', 'aborted');
    if (this.latency > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latency));
      if (signal?.aborted) throw new PrivacyError('user-rejected', 'aborted');
    }
    const index = this.faults.findIndex((f) => !f.on || f.on === method);
    if (index >= 0) {
      const fault = this.faults[index]!;
      if (!fault.sticky) this.faults.splice(index, 1);
      throw new PrivacyError(fault.kind, fault.message ?? `injected fault: ${fault.kind}`);
    }
  }
}

/**
 * Addresses arrive padded and unpadded. Never compare with `===`.
 *
 * Keeps the `0x` prefix so the result is still parseable by `BigInt` — an
 * earlier version returned a bare hex string, which made every downstream
 * comparison silently fall back to string equality.
 */
function normalise(address: string): string {
  return `0x${BigInt(address).toString(16)}`;
}

function sameAddress(a: string, b: string): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return a === b;
  }
}

function emitProgress(callback: ProgressCallback | undefined, progress: OperationProgress): void {
  try { callback?.(progress); } catch { /* Observers cannot alter a financial operation. */ }
}
