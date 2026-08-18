import { createStore, type Store } from '../store/store.js';

export interface SubmissionUncertaintyState {
  active: boolean;
  acknowledged: boolean;
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
  readonly store: Store<SubmissionUncertaintyState>;
  retain(): void;
  acknowledge(): void;
}

export function createSubmissionUncertainty(): SubmissionUncertainty {
  const store = createStore<SubmissionUncertaintyState>({ active: false, acknowledged: false });

  return {
    store,
    retain(): void {
      const state = store.getState();
      if (state.active && !state.acknowledged) return;
      store.setState({ active: true, acknowledged: false });
    },
    acknowledge(): void {
      const state = store.getState();
      if (!state.active || state.acknowledged) return;
      store.setState({ active: true, acknowledged: true });
    },
  };
}
