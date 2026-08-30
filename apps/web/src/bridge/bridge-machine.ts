import type {
  BridgeRecord,
  BridgeService,
  BridgeStatus,
  SourceAsset,
} from '@strkworld/bridge';
import type {
  Address,
  Intent,
  PublicShieldPlan,
  PublicShieldPlanner,
} from '@strkworld/privacy';
import { createStore, type Store } from '../store/store.js';
import { COPY } from '../copy.js';
import { formatTokenAmountExact } from '../format.js';
import { sameAddress } from '../format.js';

export const STRK_TOKEN: Address =
  '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

export type BridgeAccountReader = () => Address | null | Promise<Address | null>;
export type BridgeSourceLoader = () => Promise<readonly SourceAsset[]>;

export interface BridgeServicePort {
  resume(): BridgeRecord | null;
  createManualDeposit(input: {
    source: SourceAsset;
    amountIn: bigint;
    starknetRecipient: string;
    refundAddress: string;
  }): Promise<BridgeRecord>;
  refresh(): Promise<BridgeStatus>;
  watch(options?: {
    signal?: AbortSignal;
    onUpdate?: (status: BridgeStatus) => void;
  }): Promise<BridgeStatus>;
  exportResumeRecord(): string;
  importResumeRecord(serialized: string): BridgeRecord;
  discard(): void;
}

export type BridgeFlow =
  | { name: 'idle' }
  | { name: 'loading' }
  | { name: 'quoting' }
  | { name: 'preflighting' }
  | { name: 'watching' }
  | { name: 'planning-shield' }
  | { name: 'ready-to-shield' }
  | { name: 'failed'; message: string; retry: 'quote' | 'shield' | 'none' };

export interface BridgeQuoteReview {
  amountIn: bigint;
  sourceSymbol: string;
  sourceDecimals: number;
  expectedAmountOut: bigint;
  minimumAmountOut: bigint;
  deadline: string;
  recipient: Address;
}

export interface BridgeState {
  sources: { status: 'unrequested' | 'loading' | 'loaded' | 'failed'; assets: readonly SourceAsset[] };
  record: BridgeRecord | null;
  account: Address | null;
  accountMatchesRecord: boolean;
  quote: BridgeQuoteReview | null;
  preflightAvailable: boolean;
  instructionsVisible: boolean;
  plan: PublicShieldPlan | null;
  flow: BridgeFlow;
  notice: { tone: 'info' | 'error'; text: string } | null;
}

export interface BridgePanel {
  readonly store: Store<BridgeState>;
  open(): Promise<void>;
  close(): void;
  createQuote(input: {
    source: SourceAsset;
    amountIn: bigint;
    refundAddress: string;
  }): Promise<void>;
  preflightSavedQuote(): Promise<void>;
  /** Refresh persisted evidence once, then expose only its next safe action. */
  resumeSavedQuote(): Promise<void>;
  refresh(): Promise<void>;
  watch(): Promise<void>;
  exportRecord(): string | null;
  importRecord(serialized: string): void;
  discardRecord(): void;
  planShield(): Promise<void>;
  /** A typed, shield-only prefill; this never prepares or submits it. */
  shieldIntent(): Intent | null;
  /** Fresh commit-point guard for the ordinary Bank shield review. */
  revalidateShieldPlan(): Promise<PublicShieldPlan | null>;
}

export interface BridgePanelOptions {
  service: BridgeServicePort | BridgeService;
  loadSources: BridgeSourceLoader;
  readAccount: BridgeAccountReader;
  planner?: PublicShieldPlanner | null;
  now?: () => number;
}

interface BridgeQuoteFlight {
  cancelled: boolean;
  restoreSerialized: string | null;
  promise: Promise<void>;
}

interface BridgeServiceCoordinator {
  quoteFlight: BridgeQuoteFlight | null;
}

// A panel can unmount while the provider request is still in flight. Keep the
// coordination on the service object so a remounted panel cannot start a
// second quote or overwrite the evidence the first request may persist.
const SERVICE_COORDINATORS = new WeakMap<object, BridgeServiceCoordinator>();

function coordinatorFor(service: BridgeServicePort | BridgeService): BridgeServiceCoordinator {
  const key = service as object;
  const existing = SERVICE_COORDINATORS.get(key);
  if (existing) return existing;
  const created: BridgeServiceCoordinator = { quoteFlight: null };
  SERVICE_COORDINATORS.set(key, created);
  return created;
}

const initialState: BridgeState = {
  sources: { status: 'unrequested', assets: [] },
  record: null,
  account: null,
  accountMatchesRecord: false,
  quote: null,
  preflightAvailable: false,
  instructionsVisible: false,
  plan: null,
  flow: { name: 'idle' },
  notice: null,
};

/**
 * Manual Bridge state machine. It deliberately has no timer and no implicit
 * provider call: entering opens local evidence and source metadata only.
 */
export function createBridgePanel(options: BridgePanelOptions): BridgePanel {
  const store = createStore<BridgeState>(initialState);
  const coordinator = coordinatorFor(options.service);
  const now = options.now ?? Date.now;
  let session = 0;
  let attempt = 0;
  let watchController: AbortController | null = null;
  let quoteBusy = false;
  let preflightOwner = 0;
  let preflightSequence = 0;
  let refreshOwner = 0;
  let refreshSequence = 0;
  let shieldBusy = false;
  let revalidateBusy = false;

  const nextSession = (): number => (session += 1);
  const begin = (): number => (attempt += 1);
  const live = (id: number, currentSession: number): boolean => id === attempt && currentSession === session;
  const patch = (value: Partial<BridgeState>): void => {
    store.setState((previous) => ({ ...previous, ...value }));
  };
  const fail = (message: string, retry: 'quote' | 'shield' | 'none'): void => {
    patch({ flow: { name: 'failed', message, retry }, notice: { tone: 'error', text: message } });
  };

  function validAccount(value: string | null): Address | null {
    if (!value || !/^0x[0-9a-fA-F]{1,64}$/.test(value.trim())) return null;
    try {
      const numeric = BigInt(value);
      const prime = (1n << 251n) + 17n * (1n << 192n) + 1n;
      if (numeric <= 0n || numeric >= prime) return null;
      return `0x${numeric.toString(16)}`;
    } catch {
      return null;
    }
  }

  function quoteReview(record: BridgeRecord): BridgeQuoteReview | null {
    const quote = record.signedQuote.quote;
    const recipient = validAccount(record.starknetRecipient);
    const quotedRecipient = validAccount(record.signedQuote.quoteRequest.recipient ?? '');
    if (!recipient || !quotedRecipient || !sameAddress(recipient, quotedRecipient)) return null;
    if (!quote.deadline || !Number.isFinite(Date.parse(quote.deadline))) return null;
    if (!/^\d+$/.test(quote.amountOut) || !/^\d+$/.test(quote.minAmountOut)) return null;
    try {
      const expectedAmountOut = BigInt(quote.amountOut);
      const minimumAmountOut = BigInt(quote.minAmountOut);
      if (expectedAmountOut <= 0n || minimumAmountOut <= 0n || minimumAmountOut > expectedAmountOut) return null;
      return {
        amountIn: record.amountIn,
        sourceSymbol: record.source.symbol,
        sourceDecimals: record.source.decimals,
        expectedAmountOut,
        minimumAmountOut,
        deadline: quote.deadline ?? '',
        recipient,
      };
    } catch {
      return null;
    }
  }

  function quoteIsFresh(review: BridgeQuoteReview): boolean {
    const deadline = Date.parse(review.deadline);
    return Number.isFinite(deadline) && now() < deadline;
  }

  function canShowInstructions(record: BridgeRecord | null, review: BridgeQuoteReview | null): boolean {
    return record !== null && record.status.leg === 'awaiting-deposit' && review !== null && quoteIsFresh(review);
  }

  function recordAndReview(): { record: BridgeRecord | null; review: BridgeQuoteReview | null } {
    const record = options.service.resume();
    return { record, review: record ? quoteReview(record) : null };
  }

  function sameSignedQuote(left: BridgeRecord, right: BridgeRecord, review: BridgeQuoteReview): boolean {
    const other = quoteReview(right);
    return other !== null &&
      left.signedQuote.correlationId === right.signedQuote.correlationId &&
      left.signedQuote.signature === right.signedQuote.signature &&
      sameAddress(left.starknetRecipient, right.starknetRecipient) &&
      other.minimumAmountOut === review.minimumAmountOut &&
      sameAddress(other.recipient, review.recipient);
  }

  function sameSignedEvidence(left: BridgeRecord, right: BridgeRecord): boolean {
    return left.signedQuote.correlationId === right.signedQuote.correlationId &&
      left.signedQuote.signature === right.signedQuote.signature &&
      left.signedQuote.timestamp === right.signedQuote.timestamp &&
      sameAddress(left.starknetRecipient, right.starknetRecipient) &&
      left.signedQuote.quote.amountOut === right.signedQuote.quote.amountOut &&
      left.signedQuote.quote.minAmountOut === right.signedQuote.quote.minAmountOut &&
      left.signedQuote.quote.deadline === right.signedQuote.quote.deadline &&
      left.signedQuote.quote.depositAddress === right.signedQuote.quote.depositAddress;
  }

  function cleanupCancelledQuote(returned: BridgeRecord, flight: BridgeQuoteFlight): void {
    const current = options.service.resume();
    if (current && sameSignedEvidence(current, returned)) options.service.discard();
    if (flight.restoreSerialized) {
      try { options.service.importResumeRecord(flight.restoreSerialized); } catch { /* retain the imported evidence already held by the service */ }
    }
  }

  function planValid(plan: PublicShieldPlan, available: bigint, expectedRecipient: Address): boolean {
    return (
      sameAddress(plan.token, STRK_TOKEN) &&
      sameAddress(plan.recipient, expectedRecipient) &&
      plan.available === available &&
      plan.amountToShield > 0n &&
      plan.poolFee >= 0n &&
      plan.gasEstimate > 0n &&
      plan.plannedReserve === plan.poolFee + plan.gasEstimate &&
      plan.amountToShield + plan.plannedReserve <= available
    );
  }

  function samePlan(left: PublicShieldPlan, right: PublicShieldPlan): boolean {
    return sameAddress(left.token, right.token) &&
      sameAddress(left.recipient, right.recipient) &&
      left.available === right.available &&
      left.amountToShield === right.amountToShield &&
      left.poolFee === right.poolFee &&
      left.gasEstimate === right.gasEstimate &&
      left.plannedReserve === right.plannedReserve;
  }

  async function account(): Promise<Address | null> {
    try {
      return validAccount(await options.readAccount());
    } catch {
      return null;
    }
  }

  async function refreshCurrent(): Promise<BridgeStatus | null> {
    if (refreshOwner !== 0 || watchController) return null;
    const owner = ++refreshSequence;
    refreshOwner = owner;
    const id = begin();
    const currentSession = session;
    patch({ flow: { name: 'loading' }, notice: null });
    try {
      await options.service.refresh();
      if (!live(id, currentSession)) return null;
      const { record, review } = recordAndReview();
      const instructions = canShowInstructions(record, review);
      patch({ record, quote: review, preflightAvailable: instructions, flow: { name: 'idle' }, instructionsVisible: instructions && store.getState().instructionsVisible });
      return record?.status ?? null;
    } catch {
      if (live(id, currentSession)) fail(COPY.bridge.statusFailed, 'none');
      return null;
    } finally {
      if (refreshOwner === owner) refreshOwner = 0;
    }
  }

  return {
    store,

    async open(): Promise<void> {
      const id = begin();
      const currentSession = session;
      patch({ flow: { name: 'loading' }, notice: null });
      // Resume is local evidence. It intentionally does not refresh status.
      let record: BridgeRecord | null;
      try {
        record = options.service.resume();
      } catch {
        if (live(id, currentSession)) fail(COPY.bridge.recoveryUnavailable, 'none');
        return;
      }
      patch({
        record,
        quote: record ? quoteReview(record) : null,
        preflightAvailable: canShowInstructions(record, record ? quoteReview(record) : null),
        instructionsVisible: false,
        plan: null,
      });
      // Source assets exist only to create a new quote. Recovery-only
      // production has no planner, so opening its panel must remain a local
      // record read rather than contacting 1Click for unusable picker data.
      if (!options.planner) {
        patch({ flow: { name: 'idle' } });
        return;
      }
      try {
        const assets = await options.loadSources();
        if (!live(id, currentSession)) return;
        patch({ sources: { status: 'loaded', assets }, flow: { name: 'idle' } });
      } catch {
        if (!live(id, currentSession)) return;
        patch({ sources: { status: 'failed', assets: [] }, flow: { name: 'idle' } });
      }
    },

    async preflightSavedQuote(): Promise<void> {
      if (preflightOwner !== 0) return;
      const owner = ++preflightSequence;
      preflightOwner = owner;
      try {
      const planner = options.planner;
      const { record, review } = recordAndReview();
      if (!planner) {
        fail(COPY.bridge.plannerUnavailable, 'quote');
        return;
      }
      if (!record || !review || record.status.leg !== 'awaiting-deposit' || !quoteIsFresh(review)) {
        fail(COPY.bridge.preflightExpired, 'quote');
        return;
      }
      const id = begin();
      const currentSession = session;
      const recipient = await account();
      if (!live(id, currentSession)) return;
      if (!recipient || !sameAddress(recipient, record.starknetRecipient)) {
        fail(COPY.bridge.accountChanged, 'quote');
        return;
      }
      patch({ record, quote: review, preflightAvailable: false, flow: { name: 'preflighting' }, instructionsVisible: false });
      try {
        const plan = await planner.planMax({ token: STRK_TOKEN, available: review.minimumAmountOut, expectedRecipient: recipient });
        if (!live(id, currentSession) || !planValid(plan, review.minimumAmountOut, recipient)) throw new Error('invalid plan');
        const afterPlan = await account();
        if (!live(id, currentSession)) return;
        const latest = recordAndReview();
        if (!afterPlan || !sameAddress(afterPlan, record.starknetRecipient)) {
          patch({ record: latest.record ?? record, quote: latest.review ?? review, preflightAvailable: false, instructionsVisible: false });
          fail(COPY.bridge.accountChanged, 'quote');
          return;
        }
        if (!latest.record || !latest.review || !sameSignedQuote(record, latest.record, review) || !canShowInstructions(latest.record, latest.review)) {
          patch({ record: latest.record ?? record, quote: latest.review ?? review, preflightAvailable: false, instructionsVisible: false });
          fail(COPY.bridge.preflightFailed, 'quote');
          return;
        }
        patch({ account: afterPlan, accountMatchesRecord: true, record: latest.record, quote: latest.review, preflightAvailable: false, plan, instructionsVisible: true, flow: { name: 'idle' }, notice: { tone: 'info', text: COPY.bridge.providerFee } });
      } catch {
        if (live(id, currentSession)) {
          const current = recordAndReview();
          patch({ preflightAvailable: canShowInstructions(current.record, current.review) });
          fail(COPY.bridge.preflightFailed, 'quote');
        }
      }
      } finally {
        if (preflightOwner === owner) preflightOwner = 0;
      }
    },

    async resumeSavedQuote(): Promise<void> {
      // A resumed quote is not executable merely because it exists in local
      // storage. Refresh the provider first, then run the same account-bound
      // planner gate used for a newly created quote. Other legs remain visible
      // as evidence and expose their ordinary refresh/watch/settlement action.
      if (!options.service.resume()) return;
      const status = await refreshCurrent();
      if (status?.leg === 'awaiting-deposit') await this.preflightSavedQuote();
    },

    close(): void {
      if (coordinator.quoteFlight) coordinator.quoteFlight.cancelled = true;
      nextSession();
      begin();
      preflightOwner = 0;
      refreshOwner = 0;
      watchController?.abort();
      watchController = null;
      patch({ flow: { name: 'idle' } });
    },

    async createQuote(input): Promise<void> {
      if (quoteBusy || coordinator.quoteFlight) {
        fail(COPY.bridge.busy, 'none');
        return;
      }
      quoteBusy = true;
      const flight: BridgeQuoteFlight = { cancelled: false, restoreSerialized: null, promise: Promise.resolve() };
      coordinator.quoteFlight = flight;
      const run = async (): Promise<void> => {
      let returnedRecord: BridgeRecord | null = null;
      try {
      const planner = options.planner;
      if (!planner) {
        fail(COPY.bridge.plannerUnavailable, 'none');
        return;
      }
      const id = begin();
      const currentSession = session;
      const recipient = await account();
      if (flight.cancelled || !live(id, currentSession)) return;
      if (!recipient) {
        fail(COPY.bridge.accountRequired, 'none');
        return;
      }
      patch({ flow: { name: 'quoting' }, notice: null, account: recipient, accountMatchesRecord: true });
      try {
        const record = await options.service.createManualDeposit({
          source: input.source,
          amountIn: input.amountIn,
          starknetRecipient: recipient,
          refundAddress: input.refundAddress,
        });
        returnedRecord = record;
        if (flight.cancelled || !live(id, currentSession)) {
          cleanupCancelledQuote(record, flight);
          return;
        }
        const review = quoteReview(record);
        if (!review) throw new Error('invalid quote');
        patch({ record, quote: review, preflightAvailable: false, flow: { name: 'preflighting' }, instructionsVisible: false });
        const afterQuote = await account();
        if (flight.cancelled || !live(id, currentSession)) {
          cleanupCancelledQuote(record, flight);
          return;
        }
        if (!afterQuote || !sameAddress(afterQuote, record.starknetRecipient)) {
          patch({ account: afterQuote, accountMatchesRecord: false });
          fail(COPY.bridge.accountChanged, 'quote');
          return;
        }
        const plan = await planner.planMax({ token: STRK_TOKEN, available: review.minimumAmountOut, expectedRecipient: recipient });
        if (flight.cancelled || !live(id, currentSession)) {
          cleanupCancelledQuote(record, flight);
          return;
        }
        if (!planValid(plan, review.minimumAmountOut, recipient)) throw new Error('invalid plan');
        const afterPlan = await account();
        if (flight.cancelled) {
          cleanupCancelledQuote(record, flight);
          return;
        }
        if (!live(id, currentSession)) return;
        const latest = recordAndReview();
        if (!afterPlan || !sameAddress(afterPlan, record.starknetRecipient)) {
          patch({ record: latest.record ?? record, quote: latest.review ?? review, preflightAvailable: false, account: afterPlan, accountMatchesRecord: false, instructionsVisible: false });
          fail(COPY.bridge.accountChanged, 'quote');
          return;
        }
        if (!latest.record || !latest.review || !sameSignedQuote(record, latest.record, review) || !canShowInstructions(latest.record, latest.review)) {
          patch({ record: latest.record ?? record, quote: latest.review ?? review, preflightAvailable: false, account: afterPlan, instructionsVisible: false });
          fail(COPY.bridge.preflightFailed, 'quote');
          return;
        }
        patch({ account: afterPlan, accountMatchesRecord: true, record: latest.record, quote: latest.review, preflightAvailable: false, plan, instructionsVisible: true, flow: { name: 'idle' }, notice: { tone: 'info', text: COPY.bridge.providerFee } });
      } catch {
        if (!live(id, currentSession)) {
          if (flight.cancelled && returnedRecord) cleanupCancelledQuote(returnedRecord, flight);
          return;
        }
        // The signed record remains in the service store as sensitive evidence.
        const current = recordAndReview();
        patch({ preflightAvailable: canShowInstructions(current.record, current.review) });
        fail(COPY.bridge.preflightFailed, 'quote');
      }
      } finally {
        quoteBusy = false;
        if (coordinator.quoteFlight === flight) coordinator.quoteFlight = null;
      }
      };
      flight.promise = run();
      await flight.promise;
    },

    refresh: async (): Promise<void> => { await refreshCurrent(); },

    async watch(): Promise<void> {
      if (watchController || refreshOwner !== 0) return;
      const controller = new AbortController();
      watchController = controller;
      const id = begin();
      const currentSession = session;
      patch({ flow: { name: 'watching' }, notice: null });
      try {
        await options.service.watch({ signal: controller.signal, onUpdate: (status) => {
          if (!live(id, currentSession)) return;
          const { record, review } = recordAndReview();
          patch({ record, quote: review, preflightAvailable: canShowInstructions(record, review), instructionsVisible: canShowInstructions(record, review) && store.getState().instructionsVisible });
        } });
        if (live(id, currentSession)) {
          const { record, review } = recordAndReview();
          patch({ record, quote: review, preflightAvailable: canShowInstructions(record, review), instructionsVisible: canShowInstructions(record, review) && store.getState().instructionsVisible, flow: { name: 'idle' } });
        }
      } catch {
        if (live(id, currentSession) && !controller.signal.aborted) fail(COPY.bridge.watchFailed, 'none');
      } finally {
        if (watchController === controller) watchController = null;
      }
    },

    exportRecord(): string | null {
      try { return options.service.exportResumeRecord(); } catch { return null; }
    },

    importRecord(serialized: string): void {
      if (coordinator.quoteFlight) {
        try {
          const record = options.service.importResumeRecord(serialized);
          coordinator.quoteFlight.cancelled = true;
          coordinator.quoteFlight.restoreSerialized = serialized;
          nextSession();
          begin();
          watchController?.abort();
          watchController = null;
          const review = quoteReview(record);
          patch({ record, quote: review, preflightAvailable: canShowInstructions(record, review), plan: null, instructionsVisible: false, notice: { tone: 'info', text: COPY.bridge.sensitive }, flow: { name: 'idle' } });
        } catch {
          // A malformed import never cancels the provider flight or replaces
          // the evidence already held by the service.
          fail(COPY.bridge.importFailed, 'none');
        }
        return;
      }
      nextSession();
      begin();
      watchController?.abort();
      watchController = null;
      try {
        const record = options.service.importResumeRecord(serialized);
        const review = quoteReview(record);
        patch({ record, quote: review, preflightAvailable: canShowInstructions(record, review), plan: null, instructionsVisible: false, notice: { tone: 'info', text: COPY.bridge.sensitive }, flow: { name: 'idle' } });
      } catch {
        fail(COPY.bridge.importFailed, 'none');
      }
    },

    discardRecord(): void {
      if (coordinator.quoteFlight) {
        coordinator.quoteFlight.cancelled = true;
        coordinator.quoteFlight.restoreSerialized = null;
      }
      nextSession();
      begin();
      watchController?.abort();
      watchController = null;
      options.service.discard();
      patch({ record: null, quote: null, preflightAvailable: false, plan: null, instructionsVisible: false, notice: null, flow: { name: 'idle' } });
    },

    async planShield(): Promise<void> {
      if (shieldBusy) return;
      shieldBusy = true;
      try {
      const planner = options.planner;
      const record = options.service.resume();
      if (!planner || !record || record.status.leg !== 'settled' || record.status.strkReceived === undefined) {
        fail(COPY.bridge.shieldUnavailable, 'none');
        return;
      }
      const id = begin();
      const currentSession = session;
      const recipient = await account();
      if (!live(id, currentSession)) return;
      patch({ record, quote: quoteReview(record) });
      if (!recipient || !sameAddress(recipient, record.starknetRecipient)) {
        patch({ account: recipient, accountMatchesRecord: false });
        fail(COPY.bridge.accountChanged, 'none');
        return;
      }
      patch({ flow: { name: 'planning-shield' }, notice: null, account: recipient, accountMatchesRecord: true });
      try {
        const plan = await planner.planMax({ token: STRK_TOKEN, available: record.status.strkReceived, expectedRecipient: recipient });
        if (!live(id, currentSession) || !planValid(plan, record.status.strkReceived, recipient)) throw new Error('invalid plan');
        const afterPlan = await account();
        if (!live(id, currentSession)) return;
        if (!afterPlan || !sameAddress(afterPlan, record.starknetRecipient)) {
          patch({ account: afterPlan, accountMatchesRecord: false });
          fail(COPY.bridge.accountChanged, 'none');
          return;
        }
        patch({ plan, flow: { name: 'ready-to-shield' }, notice: { tone: 'info', text: COPY.bridge.settled } });
      } catch {
        if (live(id, currentSession)) fail(COPY.bridge.shieldUnavailable, 'shield');
      }
      } finally {
        shieldBusy = false;
      }
    },

    shieldIntent(): Intent | null {
      const current = store.getState();
      if (current.flow.name !== 'ready-to-shield' || !current.plan) return null;
      return { kind: 'shield', token: STRK_TOKEN, amount: current.plan.amountToShield };
    },

    async revalidateShieldPlan(): Promise<PublicShieldPlan | null> {
      if (revalidateBusy) return null;
      revalidateBusy = true;
      try {
      const planner = options.planner;
      const record = options.service.resume();
      if (!planner || !record || record.status.leg !== 'settled' || record.status.strkReceived === undefined) return null;
      const previous = store.getState().plan;
      if (!previous) {
        fail(COPY.bridge.planChanged, 'shield');
        return null;
      }
      const id = begin();
      const currentSession = session;
      const recipient = await account();
      if (!live(id, currentSession) || !recipient || !sameAddress(recipient, record.starknetRecipient)) return null;
      try {
        const plan = await planner.planMax({ token: STRK_TOKEN, available: record.status.strkReceived, expectedRecipient: recipient });
        if (!live(id, currentSession) || !planValid(plan, record.status.strkReceived, recipient)) return null;
        const afterPlanAccount = await account();
        const latest = options.service.resume();
        const currentPlan = store.getState().plan;
        if (!live(id, currentSession) || !afterPlanAccount || !sameAddress(afterPlanAccount, recipient) ||
          !latest || latest.status.leg !== 'settled' || latest.status.strkReceived !== record.status.strkReceived ||
          !sameSignedEvidence(record, latest) || !sameAddress(latest.starknetRecipient, record.starknetRecipient) ||
          !currentPlan || !samePlan(currentPlan, previous)) return null;
        if (!samePlan(plan, previous)) {
          fail(COPY.bridge.planChanged, 'shield');
          return null;
        }
        return plan;
      } catch {
        if (live(id, currentSession)) fail(COPY.bridge.shieldUnavailable, 'shield');
        return null;
      }
      } finally {
        revalidateBusy = false;
      }
    },
  };
}

/** Small helper for the view; exact values only, never quote-derived shielding. */
export function planDisplay(plan: PublicShieldPlan): Record<string, string> {
  return {
    amountToShield: formatTokenAmountExact(plan.amountToShield),
    poolFee: formatTokenAmountExact(plan.poolFee),
    gasEstimate: formatTokenAmountExact(plan.gasEstimate),
    plannedReserve: formatTokenAmountExact(plan.plannedReserve),
  };
}
