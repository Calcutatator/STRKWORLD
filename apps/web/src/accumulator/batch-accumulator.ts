import type { Intent } from '@strkworld/privacy';

/**
 * The batch accumulator.
 *
 * It collects typed intent during one building visit and emits a single atomic
 * `Intent[]` on confirm. Batching is the only lever the game has against
 * per-action prompts and the per-transaction pool fee (SPEC §6), so this sits
 * on the economic critical path rather than being an optimisation.
 *
 * Three properties are load-bearing:
 *
 * **It only ever holds typed game intent.** `accept()` re-validates structure
 * at runtime and rejects any object carrying a key the intent shape does not
 * have — a contract target, a selector, a raw argument array. The type system
 * already says this, but the type system is not present at runtime and the
 * whole D-018 admission gate rests on the shell being incapable of composing an
 * arbitrary transaction. CI check 4d greps for the same thing statically.
 *
 * **It refuses to mix a shield with a private spend** (D-022). A deposit names
 * the depositor in public; bundling it with the spend it funds publishes
 * exactly the link the pool exists to break. The seam rejects this too — that
 * is the enforcement point — but a rejection arriving at prepare time reads as
 * the app breaking, so the accumulator refuses at the moment of the mistake and
 * says why.
 *
 * **It never clears itself on emit.** `confirm()` hands out a frozen snapshot;
 * the visit's intent survives a failed prepare so the player is not asked to
 * retype it.
 */

export type BatchRejectionReason =
  /** Not a shape this accumulator recognises — including extra keys. */
  | { reason: 'not-an-intent'; detail: string }
  /** D-022: a deposit's public leg must not ride with a private spend. */
  | { reason: 'mixed-shield-and-spend' }
  /** One visit settles as one approved route (D-018). */
  | { reason: 'mixed-route-kinds'; queued: Intent['kind']; incoming: Intent['kind'] }
  | { reason: 'swap-must-be-alone' }
  | { reason: 'non-positive-amount' }
  | { reason: 'batch-full'; limit: number }
  | { reason: 'empty-batch' };

export type BatchResult<T> = { ok: true; value: T } | { ok: false; rejection: BatchRejectionReason };

export interface BatchAccumulator {
  readonly intents: readonly Intent[];
  /** Add one typed intent. Returns the rejection rather than throwing. */
  accept(candidate: unknown): BatchResult<readonly Intent[]>;
  remove(index: number): readonly Intent[];
  clear(): void;
  /** The one atomic array this visit settles. Does not clear the accumulator. */
  confirm(): BatchResult<readonly Intent[]>;
}

export interface AccumulatorOptions {
  /**
   * UI-level bound on one visit, not a protocol limit — `packages/privacy`
   * owns each route's real action limit. This only stops a visit growing into
   * something nobody can read before confirming.
   */
  maxIntents?: number;
}

const DEFAULT_MAX_INTENTS = 16;

export function createBatchAccumulator(options: AccumulatorOptions = {}): BatchAccumulator {
  const limit = options.maxIntents ?? DEFAULT_MAX_INTENTS;
  let intents: Intent[] = [];

  function snapshot(): readonly Intent[] {
    return Object.freeze([...intents]);
  }

  return {
    get intents() {
      return snapshot();
    },

    accept(candidate: unknown): BatchResult<readonly Intent[]> {
      const parsed = parseIntent(candidate);
      if (!parsed.ok) return parsed;
      const intent = parsed.value;

      if (amountOf(intent) <= 0n) {
        return { ok: false, rejection: { reason: 'non-positive-amount' } };
      }
      if (intents.length >= limit) {
        return { ok: false, rejection: { reason: 'batch-full', limit } };
      }

      const queued = intents[0];
      if (queued) {
        const mixesShieldAndSpend =
          (queued.kind === 'shield') !== (intent.kind === 'shield');
        if (mixesShieldAndSpend) {
          return { ok: false, rejection: { reason: 'mixed-shield-and-spend' } };
        }
        if (queued.kind === 'swap' || intent.kind === 'swap') {
          return { ok: false, rejection: { reason: 'swap-must-be-alone' } };
        }
        if (queued.kind !== intent.kind) {
          return {
            ok: false,
            rejection: { reason: 'mixed-route-kinds', queued: queued.kind, incoming: intent.kind },
          };
        }
      }

      intents = [...intents, intent];
      return { ok: true, value: snapshot() };
    },

    remove(index: number): readonly Intent[] {
      intents = intents.filter((_, i) => i !== index);
      return snapshot();
    },

    clear(): void {
      intents = [];
    },

    confirm(): BatchResult<readonly Intent[]> {
      if (intents.length === 0) {
        return { ok: false, rejection: { reason: 'empty-batch' } };
      }
      return { ok: true, value: snapshot() };
    },
  };
}

// ---------------------------------------------------------------------------
// Runtime shape validation
// ---------------------------------------------------------------------------

/**
 * The exact key set of each intent, checked both ways.
 *
 * Checking for *extra* keys is the point. A missing field is a bug; an unknown
 * extra field is an attempt — accidental or not — to smuggle protocol detail
 * through a seam that is specified to carry game intent only.
 */
const INTENT_SHAPES = {
  shield: ['kind', 'token', 'amount'],
  unshield: ['kind', 'token', 'amount', 'recipient'],
  transfer: ['kind', 'token', 'amount', 'recipient'],
  swap: ['kind', 'tokenIn', 'tokenOut', 'amountIn', 'minAmountOut'],
} as const satisfies Record<Intent['kind'], readonly string[]>;

const ADDRESS_FIELDS = ['token', 'recipient', 'tokenIn', 'tokenOut'] as const;
const AMOUNT_FIELDS = ['amount', 'amountIn', 'minAmountOut'] as const;

function parseIntent(candidate: unknown): BatchResult<Intent> {
  if (typeof candidate !== 'object' || candidate === null) {
    return reject('an intent must be an object');
  }
  const record = candidate as Record<string, unknown>;
  const kind = record['kind'];
  if (typeof kind !== 'string' || !(kind in INTENT_SHAPES)) {
    return reject(`unknown intent kind ${JSON.stringify(kind)}`);
  }

  const expected: readonly string[] = INTENT_SHAPES[kind as Intent['kind']];
  const actual = Object.keys(record);
  const extra = actual.filter((key) => !expected.includes(key));
  if (extra.length > 0) {
    return reject(`unexpected field(s) on a ${kind} intent: ${extra.join(', ')}`);
  }
  const missing = expected.filter((key) => !actual.includes(key));
  if (missing.length > 0) {
    return reject(`missing field(s) on a ${kind} intent: ${missing.join(', ')}`);
  }

  for (const field of ADDRESS_FIELDS) {
    if (!expected.includes(field)) continue;
    const value = record[field];
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
      return reject(`${field} must be a Starknet address`);
    }
  }
  for (const field of AMOUNT_FIELDS) {
    if (!expected.includes(field)) continue;
    if (typeof record[field] !== 'bigint') {
      return reject(`${field} must be a bigint — token amounts overflow number`);
    }
  }

  return { ok: true, value: Object.freeze({ ...record }) as unknown as Intent };
}

function reject(detail: string): BatchResult<never> {
  return { ok: false, rejection: { reason: 'not-an-intent', detail } };
}

function amountOf(intent: Intent): bigint {
  return intent.kind === 'swap' ? intent.amountIn : intent.amount;
}
