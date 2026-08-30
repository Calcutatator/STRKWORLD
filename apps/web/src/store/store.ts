/**
 * A minimal observable store.
 *
 * Panel logic is written as a plain state machine over one of these rather
 * than as React state, for two reasons. It can be tested in Node with no DOM
 * and no renderer — which is what `vitest.config.mts` actually runs — and the
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
  const listeners = new Map<Listener<S>, symbol>();
  const pending: Array<{
    readonly state: S;
    readonly listeners: ReadonlyArray<readonly [Listener<S>, symbol]>;
  }> = [];
  let delivering = false;

  const getState = (): S => state;
  const getServerSnapshot = (): S => state;

  const subscribe = (listener: Listener<S>): (() => void) => {
    const token = Symbol();
    listeners.set(listener, token);
    return () => {
      if (listeners.get(listener) === token) listeners.delete(listener);
    };
  };

  const setState = (update: S | ((previous: S) => S)): void => {
    const next =
      typeof update === 'function' ? (update as (previous: S) => S)(state) : update;
    if (Object.is(next, state)) return;
    state = next;
    pending.push({ state: next, listeners: [...listeners] });
    if (delivering) return;
    delivering = true;
    try {
      while (pending.length > 0) {
        const transition = pending.shift()!;
        for (const [listener, token] of transition.listeners) {
          if (listeners.get(listener) !== token) continue;
          try {
            listener(transition.state);
          } catch (error) {
            // One bad subscriber must not stop the others, and must never abort a
            // financial state transition that has already happened.
            console.error('store: subscriber threw', error);
          }
        }
      }
    } finally {
      delivering = false;
    }
  };

  return Object.freeze({ getState, getServerSnapshot, setState, subscribe });
}
