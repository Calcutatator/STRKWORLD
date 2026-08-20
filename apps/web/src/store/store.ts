/**
 * A minimal observable store.
 *
 * Panel logic is written as a plain state machine over one of these rather
 * than as React state, for two reasons. It can be tested in Node with no DOM
 * and no renderer — which is what `vitest.config.ts` actually runs — and the
 * financial state machine stays legible when the panel around it is rewritten.
 *
 * React reads it through `useStore`, which is a `useSyncExternalStore` wrapper
 * and nothing more.
 */

export type Listener<S> = (state: S) => void;

export interface ReadableStore<S> {
  readonly getState: () => S;
  readonly getServerSnapshot: () => S;
  readonly subscribe: (listener: Listener<S>) => () => void;
}

export interface Store<S> extends ReadableStore<S> {
  setState(update: S | ((previous: S) => S)): void;
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<Listener<S>>();

  const getState = (): S => state;
  const getServerSnapshot = (): S => state;

  const subscribe = (listener: Listener<S>): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const setState = (update: S | ((previous: S) => S)): void => {
    const next =
      typeof update === 'function' ? (update as (previous: S) => S)(state) : update;
    if (Object.is(next, state)) return;
    state = next;
    // Copy before iterating: a listener that unsubscribes itself would
    // otherwise mutate the set mid-iteration.
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch (error) {
        // One bad subscriber must not stop the others, and must never abort a
        // financial state transition that has already happened.
        console.error('store: subscriber threw', error);
      }
    }
  };

  return { getState, getServerSnapshot, setState, subscribe };
}
