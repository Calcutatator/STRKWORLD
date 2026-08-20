import { useSyncExternalStore } from 'react';
import type { ReadableStore } from './store.js';

/**
 * Subscribe a component to a panel store.
 *
 * `useSyncExternalStore` rather than an effect + `useState`: it is tear-free
 * under concurrent rendering, and a panel that renders a stale balance next to
 * a fresh confirm button is exactly the class of bug that matters here.
 */
export function useStore<S>(store: ReadableStore<S>): S {
  return useSyncExternalStore(store.subscribe, store.getState, store.getServerSnapshot);
}
