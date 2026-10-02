import type {
  Address,
  BatchWarning,
  DepositStatus,
  OperationStage,
  PreparedBatch,
  PrivacyErrorKind,
  PrivacyOperations,
  WalletRoutePolicy,
} from '@strkworld/privacy';
import { COPY } from '../copy.js';
import { debugFailure, debugGate } from '../debug/debug-tap.js';
import { parseTokenAmount, sameAddress } from '../format.js';
import { EXCHANGE_CATALOG, catalogAsset } from '../panels/exchange/catalog.js';
import {
  ENTRY_SHIELD_ROUTE,
  routeDisclosure,
  routeDoor,
  type DoorState,
} from '../panels/routes.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { toFailure } from '../privacy/errors.js';
import { detectRoutePolicy } from '../production/config.js';
import { createStore, type ReadableStore } from '../store/store.js';
import type { EntryPassMemory } from './entry-pass.js';

/**
 * The entry gate (D-072), as a state machine.
 *
 * One check stands between a connected, STRK20-capable wallet and the city:
 * does this account hold anything in the privacy pool? A player who does
 * walks straight in. A player who does not is asked to deposit any amount of
 * any token this build admits, through the same shield route the Bank uses,
 * and walks in once a public read of the receipt shows the deposit landed.
 *
 * Five rules shape it, each from a verified fact rather than taste:
 *
 * **The check is player-initiated.** `wallet_strk20Balances` raises Ready's
 * "Share private balances" approval on every read, so nothing here reads on
 * mount or on a timer. The player presses "Enter STRKWORLD", or "Check my
 * private balance" on any card after it, so no card is a dead end; the only
 * automatic work is recalling this tab's earlier pass, which touches no
 * wallet.
 *
 * **The shell learns yes or no.** `hasPrivateFunds` answers a boolean from
 * one read of every shielded token. No amount, token list or balance reaches
 * this file, and the once-per-session pass keeps no raw address, balance or
 * amount (`entry-pass.ts`).
 *
 * **A 118 means "nothing here yet", not a failure.** An account the pool has
 * never seen holds nothing, so it gets the deposit card. Only when the shield
 * itself answers 118 does the player need the wallet's registration step,
 * and because registering there often makes a first deposit too, that card
 * leads back to the check rather than to a second deposit.
 *
 * **Confirming the deposit asks the wallet nothing.** After the wallet returns
 * the shield's hash, `depositStatus` reads its receipt publicly, waiting
 * longer between reads each time, and the gate passes when the pool's
 * `Deposit` for this account is there. A read that fails is not "not yet":
 * after a few in a row the gate says it cannot reach the network check.
 *
 * **An answer belongs to the account it was asked about.** Before acting on
 * one, the gate re-reads the session's account, which asks the wallet
 * nothing, and drops the answer if the account moved in place.
 */

/** A token the gate can take a deposit in: admitted for shielding, with display metadata. */
export interface EntryToken {
  readonly token: Address;
  readonly symbol: string;
  readonly decimals: number;
}

/** What the player has typed into the deposit card. */
export interface DepositForm {
  /** The chosen token, or null when this build admits none the gate can describe. */
  readonly token: Address | null;
  readonly amountText: string;
}

/** The prepared shield, as the commit point shows it. */
export interface DepositReview {
  readonly token: EntryToken;
  /** From the prepared batch: the exact amount being signed. */
  readonly amount: bigint;
  readonly warnings: readonly BatchWarning[];
  /** The register's pre-commit line for `entry.shield`, if it has one. */
  readonly disclosures: readonly string[];
  /** The hard guard passed to `confirm`: never sign above the prepared fee. */
  readonly feeCeiling: bigint;
  /**
   * D-094: the prepared pool fee a STRK deposit pays on top, so the amount
   * reaches the pool and the wallet sends `amount + poolFee`. Null for
   * another token: the fee is STRK, the seam adds nothing to that deposit,
   * and the review keeps D-072's plain note.
   */
  readonly poolFee: bigint | null;
  /**
   * Leaderboard phase 1: present, and true, only when the prepared batch
   * carries a private placement receipt or tick. The review says so, subtly.
   */
  readonly countsTowardPlacement?: true;
}

/** Why a deposit did not land: the seam's failure, or a receipt that says it reverted. */
export type DepositFailure = PrivacyErrorKind | 'reverted';

export type EntryGateState =
  /** Looking up this tab's earlier pass for the account. No wallet involved. */
  | { readonly name: 'recalling' }
  /** "One check before you enter." */
  | { readonly name: 'ready' }
  /** The wallet is asking the player to share their private balance. */
  | { readonly name: 'checking' }
  /** The check was declined or failed. The same card, its message, and a retry. */
  | { readonly name: 'check-failed'; readonly failure: PrivacyErrorKind }
  /** Nothing in the pool: the deposit card. */
  | { readonly name: 'deposit'; readonly form: DepositForm; readonly notice: string | null }
  | { readonly name: 'preparing'; readonly form: DepositForm }
  | { readonly name: 'review'; readonly form: DepositForm; readonly review: DepositReview }
  | {
      readonly name: 'depositing';
      readonly form: DepositForm;
      readonly review: DepositReview;
      readonly stage: OperationStage;
    }
  /** The wallet returned a hash; watching the receipt. */
  | { readonly name: 'landing'; readonly form: DepositForm; readonly transactionHash: string }
  /** The receipt did not show up in time. The player can check again; nothing is re-signed. */
  | { readonly name: 'unconfirmed'; readonly form: DepositForm; readonly transactionHash: string }
  /** Receipt reads kept failing: the gate cannot tell whether the deposit arrived. */
  | { readonly name: 'receipt-unreachable'; readonly form: DepositForm; readonly transactionHash: string }
  /** The deposit card again, with what went wrong. */
  | { readonly name: 'deposit-failed'; readonly form: DepositForm; readonly failure: DepositFailure }
  /** The shield answered 118: the wallet's own registration step comes first. */
  | { readonly name: 'not-registered'; readonly form: DepositForm }
  | { readonly name: 'passed' };

/** A state's name: all the debug logger ever records of the gate (D-069). */
export type EntryGateStateName = EntryGateState['name'];

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/** The session's current account, read without asking the wallet anything. */
export type AccountReader = () => Address | null | Promise<Address | null>;

export interface EntryGateOptions {
  readonly operations: Pick<PrivacyOperations, 'hasPrivateFunds' | 'prepare' | 'depositStatus'>;
  /** What the deposit card offers; see `entryTokens`. */
  readonly tokens: readonly EntryToken[];
  /** Route authority for the deposit's door and its approved disclosure. */
  readonly register?: readonly RouteGrade[];
  /** This build's route policy. Omitted, the live one; null means none (demo, tests). */
  readonly policy?: WalletRoutePolicy | null;
  /** This tab's once-per-session pass for the connected account. Null checks every time. */
  readonly memory?: EntryPassMemory | null;
  /**
   * The account this gate was built for, and a silent re-read of the
   * session's current one. Given both, an answer that arrives after the
   * account moved in place is dropped. Omitted (the demo), nothing is re-read.
   */
  readonly account?: Address | null;
  readonly readAccount?: AccountReader;
  /** How the receipt is watched after the wallet returns a hash. */
  readonly watch?: {
    /** The first wait between reads. Each later wait doubles, up to `maxIntervalMs`. */
    readonly intervalMs?: number;
    readonly maxIntervalMs?: number;
    /** Reads in one watch, the first at once. */
    readonly attempts?: number;
    /** Failed reads in a row after which the gate says it cannot reach the network check. */
    readonly failureLimit?: number;
    readonly sleep?: Sleep;
  };
}

export interface EntryGate {
  readonly store: ReadableStore<EntryGateState>;
  /** The deposit card's tokens, in allowlist order. */
  readonly tokens: readonly EntryToken[];
  /** Whether this build lets the gate take a deposit at all (register and policy). */
  readonly door: DoorState;
  /** Begin, or begin again after `stop`: recall this tab's pass, then wait for the player. */
  start(): void;
  /** Abandon anything in flight. Safe to call twice; `start` may follow. */
  stop(): void;
  /**
   * The one check, only ever from a player action: "Enter STRKWORLD" on the
   * check card, or "Check my private balance" on the deposit, locked,
   * registration and unconfirmed cards. Funds pass; none returns to the
   * deposit card with its form as the player left it.
   */
  check(): Promise<void>;
  setToken(token: Address): void;
  setAmount(text: string): void;
  /** Prepare the shield and show it at the commit point. */
  review(): Promise<void>;
  cancelReview(): void;
  /** Hand the prepared shield to the wallet, then watch its receipt. */
  confirm(): Promise<void>;
  /** From `unconfirmed` or `receipt-unreachable`: watch the receipt again. No wallet prompt. */
  checkDeposit(): Promise<void>;
}

/**
 * The receipt watch: a read at once, then after 3, 6 and 12 seconds and every
 * 20 seconds after that, twelve reads in about three minutes, and then the
 * player decides. Three failed reads in a row end it sooner: the network
 * check is down, and "not confirmed yet" would not be true.
 */
export const DEFAULT_WATCH_INTERVAL_MS = 3_000;
export const DEFAULT_WATCH_MAX_INTERVAL_MS = 20_000;
export const DEFAULT_WATCH_ATTEMPTS = 12;
export const DEFAULT_WATCH_FAILURE_LIMIT = 3;

/** The cards a player can start the check from. Every other state is mid-step. */
const CHECKABLE: ReadonlySet<EntryGateStateName> = new Set<EntryGateStateName>([
  'ready',
  'check-failed',
  'deposit',
  'deposit-failed',
  'not-registered',
  'unconfirmed',
  'receipt-unreachable',
]);

export const STRK = EXCHANGE_CATALOG.find((asset) => asset.symbol === 'STRK')!.token;

/**
 * The tokens the gate offers: this build's shield allowlist, in its order,
 * with the Exchange catalog's symbol and decimals (the shell's one token
 * metadata source, D-042). A token the catalog does not describe is left out,
 * because an amount cannot be read without its decimals. With no policy
 * (demo, tests) the gate offers the pool's own money, STRK (D-013).
 */
export function entryTokens(policy: WalletRoutePolicy | null): readonly EntryToken[] {
  let allowlist: readonly unknown[];
  try {
    const listed = policy === null ? [STRK] : policy.allowedTokens.shield;
    allowlist = Array.isArray(listed) ? [...listed] : [];
  } catch {
    return Object.freeze([]);
  }
  const offered: EntryToken[] = [];
  for (const token of allowlist) {
    if (typeof token !== 'string') continue;
    const asset = catalogAsset(token);
    if (!asset || offered.some((entry) => sameAddress(entry.token, asset.token))) continue;
    offered.push(Object.freeze({ token: asset.token, symbol: asset.symbol, decimals: asset.decimals }));
  }
  return Object.freeze(offered);
}

/**
 * A stable identity for what a policy means to the gate, so a policy parsed
 * afresh on every render does not rebuild the gate under the player.
 */
export function entryPolicyKey(policy: WalletRoutePolicy | null): string {
  if (policy === null) return 'none';
  try {
    const shield = policy.enabledRoutes.includes('shield');
    return `${shield ? 'shield' : 'no-shield'}:${entryTokens(policy).map((entry) => entry.token).join(',')}`;
  } catch {
    return 'invalid';
  }
}

export function createEntryGate(options: EntryGateOptions): EntryGate {
  const { operations } = options;
  const register = options.register ?? PRIVACY_REGISTER;
  const policy = options.policy === undefined ? detectRoutePolicy() : options.policy;
  const tokens = Object.freeze([...options.tokens]);
  const door = routeDoor(ENTRY_SHIELD_ROUTE, register, policy);
  const disclosure = routeDisclosure(ENTRY_SHIELD_ROUTE, register);
  const disclosures: readonly string[] = Object.freeze(disclosure ? [disclosure] : []);
  const memory = options.memory ?? null;
  const account = options.account ?? null;
  const readAccount = options.readAccount ?? null;
  const maxIntervalMs = options.watch?.maxIntervalMs ?? DEFAULT_WATCH_MAX_INTERVAL_MS;
  const intervalMs = Math.min(options.watch?.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS, maxIntervalMs);
  const attempts = options.watch?.attempts ?? DEFAULT_WATCH_ATTEMPTS;
  const failureLimit = Math.max(1, options.watch?.failureLimit ?? DEFAULT_WATCH_FAILURE_LIMIT);
  const sleep = options.watch?.sleep ?? abortableSleep;

  const resting = (): EntryGateState => (memory ? { name: 'recalling' } : { name: 'ready' });
  const stateStore = createStore<EntryGateState>(freezeState(resting()));
  const store: ReadableStore<EntryGateState> = Object.freeze({
    getState: stateStore.getState,
    getServerSnapshot: stateStore.getServerSnapshot,
    subscribe: stateStore.subscribe,
  });

  /** Bumped by every new step, so a late answer from an abandoned one writes nothing. */
  let attempt = 0;
  let live = false;
  let controller: AbortController | null = null;
  let prepared: PreparedBatch | null = null;
  /** A batch the wallet is signing is not ours to discard (see the Bank machine). */
  let signing: PreparedBatch | null = null;
  let lastLogged: EntryGateStateName | null = null;
  /** The deposit card's form as the player left it, for a check that finds nothing. */
  let resumeForm: DepositForm | null = null;
  /** A deposit the wallet sent that no receipt has shown landing or failing yet. */
  let unsettled: string | null = null;

  const begin = (): number => (attempt += 1);
  const current = (id: number): boolean => live && attempt === id;
  const signal = (): AbortSignal | undefined => controller?.signal;

  function publish(next: EntryGateState): void {
    const frozen = freezeState(next);
    // D-069: one line per change of state, by name only.
    if (frozen.name !== lastLogged) {
      lastLogged = frozen.name;
      debugGate(frozen.name);
    }
    stateStore.setState(frozen);
  }

  function blankForm(): DepositForm {
    return { token: tokens[0]?.token ?? null, amountText: '' };
  }

  function discardPrepared(): void {
    const batch = prepared;
    prepared = null;
    if (batch && batch !== signing) discardQuietly(batch);
  }

  function pass(remember = true): void {
    resumeForm = null;
    unsettled = null;
    publish({ name: 'passed' });
    // After the pass is on screen: storage is a convenience, never a gate.
    if (remember && memory) void memory.remember().catch(() => undefined);
  }

  /**
   * The deposit card after a check found nothing: the form as the player left
   * it, and a word of caution if a deposit they sent has not shown up yet, so
   * "nothing yet" does not read as an invitation to send a second one.
   */
  function showDeposit(): void {
    publish({
      name: 'deposit',
      form: resumeForm ?? blankForm(),
      notice: unsettled === null ? null : COPY.entry.sentNotYet,
    });
  }

  /**
   * Whether an answer that just arrived still belongs to this gate: its step
   * is current, and the session's account is still the one the gate was
   * built for. The account is re-read silently (no wallet prompt). If it
   * moved in place, the answer is dropped and the gate starts over, as its
   * owner is about to replace it with a gate for the new account.
   */
  async function answerStands(id: number): Promise<boolean> {
    if (!current(id)) return false;
    if (!readAccount || account === null) return true;
    let now: unknown;
    try {
      now = await readAccount();
    } catch {
      now = null;
    }
    if (!current(id)) return false;
    if (typeof now === 'string' && sameAddress(now, account)) return true;
    begin();
    resumeForm = null;
    unsettled = null;
    publish({ name: 'ready' });
    return false;
  }

  function depositFailed(form: DepositForm, error: unknown): void {
    const { kind } = toFailure(error);
    publish(kind === 'not-registered' ? { name: 'not-registered', form } : { name: 'deposit-failed', form, failure: kind });
  }

  function depositStep(): Extract<EntryGateState, { name: 'deposit' | 'deposit-failed' }> | null {
    const state = stateStore.getState();
    return state.name === 'deposit' || state.name === 'deposit-failed' ? state : null;
  }

  /**
   * Read the receipt now, then after `intervalMs`, doubling each wait up to
   * `maxIntervalMs`, for `attempts` reads in all. The first read usually
   * finds nothing yet; it costs one public request and lets a fast network
   * (or the demo) pass at once. A failed read is not "not yet": it counts
   * toward `failureLimit`, and only an answer resets the count.
   */
  async function watch(id: number, form: DepositForm, transactionHash: string): Promise<void> {
    let wait = intervalMs;
    let failures = 0;
    for (let tried = 0; tried < attempts; tried += 1) {
      if (tried > 0) {
        try {
          await sleep(wait, signal());
        } catch {
          return;
        }
        wait = Math.min(wait * 2, maxIntervalMs);
      }
      if (!current(id)) return;
      let status: DepositStatus | null;
      try {
        status = await operations.depositStatus(transactionHash, signal());
      } catch (error) {
        if (!current(id)) return;
        debugFailure('gate.landing', error);
        status = null;
      }
      if (!current(id)) return;
      if (status === null) {
        failures += 1;
        if (failures >= failureLimit) {
          publish({ name: 'receipt-unreachable', form, transactionHash });
          return;
        }
        continue;
      }
      failures = 0;
      if (status !== 'landed' && status !== 'failed') continue;
      if (!(await answerStands(id))) return;
      unsettled = null;
      if (status === 'landed') pass();
      else publish({ name: 'deposit-failed', form, failure: 'reverted' });
      return;
    }
    if (current(id)) publish({ name: 'unconfirmed', form, transactionHash });
  }

  return Object.freeze<EntryGate>({
    store,
    tokens,
    door,

    start(): void {
      if (live) return;
      live = true;
      controller = new AbortController();
      const id = begin();
      if (!memory) {
        publish({ name: 'ready' });
        return;
      }
      publish({ name: 'recalling' });
      void memory.recall().then(
        async (remembered) => {
          if (!current(id)) return;
          if (remembered !== true) {
            publish({ name: 'ready' });
            return;
          }
          // This tab already let this account in: no second balance prompt.
          if (await answerStands(id)) pass(false);
        },
        () => {
          if (current(id)) publish({ name: 'ready' });
        },
      );
    },

    stop(): void {
      if (!live) return;
      live = false;
      begin();
      controller?.abort();
      controller = null;
      discardPrepared();
      lastLogged = null;
      resumeForm = null;
      unsettled = null;
      stateStore.setState(freezeState(resting()));
    },

    async check(): Promise<void> {
      const state = stateStore.getState();
      if (!live || !CHECKABLE.has(state.name)) return;
      // A retry from the check card keeps the form an earlier card left.
      if ('form' in state) resumeForm = state.form;
      else if (state.name === 'ready') resumeForm = null;
      const id = begin();
      discardPrepared();
      publish({ name: 'checking' });
      let funded = false;
      let failed = false;
      let failure: unknown;
      try {
        // Anything but a real `true` keeps the door shut.
        funded = (await operations.hasPrivateFunds(signal())) === true;
      } catch (error) {
        failed = true;
        failure = error;
      }
      if (!current(id)) return;
      if (failed) debugFailure('gate.check', failure);
      if (!(await answerStands(id))) return;
      if (failed) {
        const { kind } = toFailure(failure);
        // An account the pool has never seen holds nothing: offer the deposit.
        if (kind === 'not-registered') showDeposit();
        else publish({ name: 'check-failed', failure: kind });
        return;
      }
      if (funded) pass();
      else showDeposit();
    },

    setToken(token: Address): void {
      const state = depositStep();
      if (!state) return;
      const chosen = tokens.find((candidate) => sameAddress(candidate.token, token));
      if (!chosen) return;
      publish({ name: 'deposit', form: { ...state.form, token: chosen.token }, notice: null });
    },

    setAmount(text: string): void {
      const state = depositStep();
      if (!state || typeof text !== 'string') return;
      publish({ name: 'deposit', form: { ...state.form, amountText: text }, notice: null });
    },

    async review(): Promise<void> {
      const state = depositStep();
      if (!live || !state || !door.open) return;
      const { form } = state;
      const token = form.token === null ? undefined : tokens.find((candidate) => sameAddress(candidate.token, form.token!));
      if (!token) {
        publish({ name: 'deposit', form, notice: COPY.entry.noToken });
        return;
      }
      // Any amount above zero, in the token's own decimals. No other minimum.
      const amount = parseTokenAmount(form.amountText, token.decimals);
      if (amount === null || amount <= 0n) {
        publish({ name: 'deposit', form, notice: COPY.notices.badAmount });
        return;
      }
      const id = begin();
      discardPrepared();
      publish({ name: 'preparing', form });
      let batch: PreparedBatch;
      try {
        batch = await operations.prepare([{ kind: 'shield', token: token.token, amount }], signal());
      } catch (error) {
        if (!current(id)) return;
        debugFailure('gate.deposit', error);
        depositFailed(form, error);
        return;
      }
      if (!current(id)) {
        discardQuietly(batch);
        return;
      }
      const reviewed = reviewedDeposit(batch, token);
      if (!reviewed) {
        discardQuietly(batch);
        publish({ name: 'deposit-failed', form, failure: 'unknown' });
        return;
      }
      prepared = batch;
      publish({
        name: 'review',
        form,
        review: {
          token,
          amount: reviewed.amount,
          warnings: reviewed.warnings,
          disclosures,
          feeCeiling: reviewed.feeCeiling,
          poolFee: reviewed.poolFee,
          ...(batch.countsTowardPlacement === true ? { countsTowardPlacement: true as const } : {}),
        },
      });
    },

    cancelReview(): void {
      const state = stateStore.getState();
      if (state.name !== 'review') return;
      begin();
      discardPrepared();
      publish({ name: 'deposit', form: state.form, notice: null });
    },

    async confirm(): Promise<void> {
      const state = stateStore.getState();
      const batch = prepared;
      if (!live || state.name !== 'review' || !batch) return;
      const { form, review } = state;
      const id = begin();
      publish({ name: 'depositing', form, review, stage: 'composing' });
      signing = batch;
      let transactionHash: string | null = null;
      let failed = false;
      let failure: unknown;
      try {
        const result = await batch.confirm({
          feeCeiling: review.feeCeiling,
          signal: signal(),
          onProgress: ({ stage }) => {
            if (current(id)) publish({ name: 'depositing', form, review, stage });
          },
        });
        transactionHash = ownTransactionHash(result);
      } catch (error) {
        failed = true;
        failure = error;
      }
      // Single attempt either way: a confirmed batch is spent.
      if (signing === batch) signing = null;
      if (prepared === batch) prepared = null;
      if (!current(id)) return;
      if (failed) debugFailure('gate.deposit', failure);
      if (!(await answerStands(id))) return;
      if (failed) {
        depositFailed(form, failure);
        return;
      }
      if (transactionHash === null) {
        publish({ name: 'deposit-failed', form, failure: 'unknown' });
        return;
      }
      unsettled = transactionHash;
      publish({ name: 'landing', form, transactionHash });
      await watch(id, form, transactionHash);
    },

    async checkDeposit(): Promise<void> {
      const state = stateStore.getState();
      if (!live || (state.name !== 'unconfirmed' && state.name !== 'receipt-unreachable')) return;
      const id = begin();
      publish({ name: 'landing', form: state.form, transactionHash: state.transactionHash });
      await watch(id, state.form, state.transactionHash);
    },
  });
}

/**
 * The prepared batch must be exactly the shield the player asked for, in the
 * chosen token, before its amount is shown as the figure being signed.
 */
function reviewedDeposit(
  batch: PreparedBatch,
  token: EntryToken,
): { amount: bigint; warnings: readonly BatchWarning[]; feeCeiling: bigint; poolFee: bigint | null } | null {
  try {
    const intents = batch.intents;
    const intent = intents.length === 1 ? intents[0] : undefined;
    if (intent?.kind !== 'shield' || !sameAddress(intent.token, token.token)) return null;
    if (typeof intent.amount !== 'bigint' || intent.amount <= 0n) return null;
    if (typeof batch.totalCost !== 'bigint' || batch.totalCost < 0n) return null;
    if (typeof batch.poolFee !== 'bigint' || batch.poolFee < 0n) return null;
    const warnings = Object.freeze(batch.warnings.map((warning) => Object.freeze({ ...warning })));
    // D-094: the pool's fee is STRK (D-013), and the seam puts it on top of a
    // STRK deposit. Another token's share of it cannot be stated.
    const poolFee = sameAddress(token.token, STRK) ? batch.poolFee : null;
    return { amount: intent.amount, warnings, feeCeiling: batch.totalCost, poolFee };
  } catch {
    return null;
  }
}

function ownTransactionHash(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const descriptor = Object.getOwnPropertyDescriptor(result, 'transactionHash');
  const value = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  return typeof value === 'string' && value.length > 0 && !/\s/.test(value) ? value : null;
}

function discardQuietly(batch: PreparedBatch): void {
  try {
    batch.discard();
  } catch {
    // Releasing a quote cannot fail the gate.
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      globalThis.clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function freezeState(state: EntryGateState): EntryGateState {
  const copy: Record<string, unknown> = { ...state };
  if ('form' in state) copy.form = Object.freeze({ ...state.form });
  if ('review' in state) {
    copy.review = Object.freeze({
      ...state.review,
      token: Object.freeze({ ...state.review.token }),
      warnings: Object.freeze([...state.review.warnings]),
      disclosures: Object.freeze([...state.review.disclosures]),
    });
  }
  return Object.freeze(copy) as EntryGateState;
}
