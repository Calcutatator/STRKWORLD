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
  routeRequiresDisclosure,
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
 * Four rules shape it, each from a verified fact rather than taste:
 *
 * **The check is player-initiated.** `wallet_strk20Balances` raises Ready's
 * "Share private balances" approval on every read, so nothing here reads on
 * mount or on a timer. The player presses the button; the only automatic
 * work is recalling this tab's earlier pass, which touches no wallet.
 *
 * **The shell learns yes or no.** `hasPrivateFunds` answers a boolean from
 * one read of every shielded token. No amount, token list or balance reaches
 * this file, and the once-per-session pass stores a hash of the account.
 *
 * **A 118 means "nothing here yet", not a failure.** An account the pool has
 * never seen holds nothing, so it gets the deposit card. Only when the shield
 * itself answers 118 does the player need the wallet's registration step.
 *
 * **Confirming the deposit asks the wallet nothing.** After the wallet returns
 * the shield's hash, `depositStatus` reads its receipt publicly and the gate
 * passes when the pool's `Deposit` for this account is there.
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
  /** The register's approved copy for `entry.shield`, verbatim (D-024). */
  readonly disclosures: readonly string[];
  readonly requiresDisclosure: boolean;
  /** The hard guard passed to `confirm`: never sign above the prepared fee. */
  readonly feeCeiling: bigint;
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
  /** The deposit card again, with what went wrong. */
  | { readonly name: 'deposit-failed'; readonly form: DepositForm; readonly failure: DepositFailure }
  /** The shield answered 118: the wallet's own registration step comes first. */
  | { readonly name: 'not-registered'; readonly form: DepositForm }
  | { readonly name: 'passed' };

/** A state's name: all the debug logger ever records of the gate (D-069). */
export type EntryGateStateName = EntryGateState['name'];

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

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
  /** How the receipt is watched after the wallet returns a hash. */
  readonly watch?: {
    readonly intervalMs?: number;
    readonly attempts?: number;
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
  /** The one check. Only ever called from a player action. */
  check(): Promise<void>;
  setToken(token: Address): void;
  setAmount(text: string): void;
  /** Prepare the shield and show it at the commit point. */
  review(): Promise<void>;
  cancelReview(): void;
  /** Hand the prepared shield to the wallet, then watch its receipt. */
  confirm(): Promise<void>;
  /** From `unconfirmed`: read the receipt again. No wallet prompt. */
  checkDeposit(): Promise<void>;
  /** From a failure or the registration card: back to the deposit card, form kept. */
  backToDeposit(): void;
}

/** A receipt read now and every few seconds, for about three minutes, then the player decides. */
export const DEFAULT_WATCH_INTERVAL_MS = 3_000;
export const DEFAULT_WATCH_ATTEMPTS = 60;

const STRK = EXCHANGE_CATALOG.find((asset) => asset.symbol === 'STRK')!.token;

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
  const requiresDisclosure = routeRequiresDisclosure(ENTRY_SHIELD_ROUTE, register);
  const memory = options.memory ?? null;
  const intervalMs = options.watch?.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  const attempts = options.watch?.attempts ?? DEFAULT_WATCH_ATTEMPTS;
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
    publish({ name: 'passed' });
    // After the pass is on screen: storage is a convenience, never a gate.
    if (remember && memory) void memory.remember().catch(() => undefined);
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
   * Read the receipt now, then every `intervalMs`, up to `attempts` reads.
   * The first read usually finds nothing yet; it costs one public request
   * and lets a fast network (or the demo) pass at once.
   */
  async function watch(id: number, form: DepositForm, transactionHash: string): Promise<void> {
    for (let tried = 0; tried < attempts; tried += 1) {
      if (tried > 0) {
        try {
          await sleep(intervalMs, signal());
        } catch {
          return;
        }
      }
      if (!current(id)) return;
      let status: DepositStatus;
      try {
        status = await operations.depositStatus(transactionHash, signal());
      } catch (error) {
        if (!current(id)) return;
        debugFailure('gate.landing', error);
        status = 'pending';
      }
      if (!current(id)) return;
      if (status === 'landed') {
        pass();
        return;
      }
      if (status === 'failed') {
        publish({ name: 'deposit-failed', form, failure: 'reverted' });
        return;
      }
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
        (remembered) => {
          if (!current(id)) return;
          // This tab already let this account in: no second balance prompt.
          if (remembered === true) pass(false);
          else publish({ name: 'ready' });
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
      stateStore.setState(freezeState(resting()));
    },

    async check(): Promise<void> {
      const state = stateStore.getState();
      if (!live || (state.name !== 'ready' && state.name !== 'check-failed')) return;
      const id = begin();
      publish({ name: 'checking' });
      let funded: boolean;
      try {
        // Anything but a real `true` keeps the door shut.
        funded = (await operations.hasPrivateFunds(signal())) === true;
      } catch (error) {
        if (!current(id)) return;
        debugFailure('gate.check', error);
        const { kind } = toFailure(error);
        // An account the pool has never seen holds nothing: offer the deposit.
        publish(kind === 'not-registered'
          ? { name: 'deposit', form: blankForm(), notice: null }
          : { name: 'check-failed', failure: kind });
        return;
      }
      if (!current(id)) return;
      if (funded) pass();
      else publish({ name: 'deposit', form: blankForm(), notice: null });
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
        review: { token, amount: reviewed.amount, warnings: reviewed.warnings, disclosures, requiresDisclosure, feeCeiling: reviewed.feeCeiling },
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
      // ConfirmGate refuses this too; the machine does not trust the screen.
      if (state.review.requiresDisclosure && state.review.disclosures.length === 0) return;
      const { form, review } = state;
      const id = begin();
      publish({ name: 'depositing', form, review, stage: 'composing' });
      signing = batch;
      let transactionHash: string | null;
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
        if (signing === batch) signing = null;
        if (prepared === batch) prepared = null;
        if (!current(id)) return;
        debugFailure('gate.deposit', error);
        depositFailed(form, error);
        return;
      }
      // Single attempt either way: a confirmed batch is spent.
      if (signing === batch) signing = null;
      if (prepared === batch) prepared = null;
      if (!current(id)) return;
      if (transactionHash === null) {
        publish({ name: 'deposit-failed', form, failure: 'unknown' });
        return;
      }
      publish({ name: 'landing', form, transactionHash });
      await watch(id, form, transactionHash);
    },

    async checkDeposit(): Promise<void> {
      const state = stateStore.getState();
      if (!live || state.name !== 'unconfirmed') return;
      const id = begin();
      publish({ name: 'landing', form: state.form, transactionHash: state.transactionHash });
      await watch(id, state.form, state.transactionHash);
    },

    backToDeposit(): void {
      const state = stateStore.getState();
      if (state.name !== 'deposit-failed' && state.name !== 'not-registered') return;
      begin();
      publish({ name: 'deposit', form: state.form, notice: null });
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
): { amount: bigint; warnings: readonly BatchWarning[]; feeCeiling: bigint } | null {
  try {
    const intents = batch.intents;
    const intent = intents.length === 1 ? intents[0] : undefined;
    if (intent?.kind !== 'shield' || !sameAddress(intent.token, token.token)) return null;
    if (typeof intent.amount !== 'bigint' || intent.amount <= 0n) return null;
    if (typeof batch.totalCost !== 'bigint' || batch.totalCost < 0n) return null;
    const warnings = Object.freeze(batch.warnings.map((warning) => Object.freeze({ ...warning })));
    return { amount: intent.amount, warnings, feeCeiling: batch.totalCost };
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
