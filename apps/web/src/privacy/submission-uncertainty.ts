import { createStore, type ReadableStore } from '../store/store.js';

export interface SubmissionUncertaintyState {
  readonly active: boolean;
  readonly acknowledged: boolean;
}

/**
 * Browser-session memory for D-034's ambiguous private-submit outcome.
 *
 * This deliberately retains one bit and nothing else: no transaction hash is
 * known, and storing an intent, recipient, timestamp or request handle would
 * create financial history the decision did not authorize. There is no clear
 * method and no localStorage path. A reload starts a new browser session.
 */
export interface SubmissionUncertainty {
  readonly store: ReadableStore<SubmissionUncertaintyState>;
  retain(): void;
  acknowledge(): void;
}

function uncertaintyState(
  active: boolean,
  acknowledged: boolean,
): SubmissionUncertaintyState {
  return Object.freeze({ active, acknowledged });
}

export function createSubmissionUncertainty(): SubmissionUncertainty {
  const ownerStore = createStore<SubmissionUncertaintyState>(uncertaintyState(false, false));
  const store: ReadableStore<SubmissionUncertaintyState> = Object.freeze({
    getState: ownerStore.getState,
    getServerSnapshot: ownerStore.getServerSnapshot,
    subscribe: ownerStore.subscribe,
  });

  return Object.freeze({
    store,
    retain(): void {
      const state = ownerStore.getState();
      if (state.active && !state.acknowledged) return;
      ownerStore.setState(uncertaintyState(true, false));
    },
    acknowledge(): void {
      const state = ownerStore.getState();
      if (!state.active || state.acknowledged) return;
      ownerStore.setState(uncertaintyState(true, true));
    },
  });
}
