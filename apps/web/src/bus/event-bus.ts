import type { EventBus } from '@strkworld/shared';

/**
 * The event bus implementation.
 *
 * Lives in the shell because the shell owns the channel and hands it to the
 * world at init — the world receives a bus, it never constructs one. That is
 * what keeps the dependency pointing one way.
 *
 * Deliberately tiny and dependency-free. It is a seam between two subsystems
 * that must not know about each other, and a seam is a bad place for a library.
 */
export function createEventBus<Events extends Record<string, unknown>>(): EventBus<Events> {
  type Handler = (payload: never) => void;
  const listeners = new Map<keyof Events, Set<Handler>>();

  function on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(handler as Handler);
    return () => off(event, handler);
  }

  function off<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): void {
    listeners.get(event)?.delete(handler as Handler);
  }

  function once<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void {
    const wrapped = (payload: Events[K]) => {
      off(event, wrapped);
      handler(payload);
    };
    return on(event, wrapped);
  }

  function emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = listeners.get(event);
    if (!set) return;
    // Copy before iterating: a handler that unsubscribes itself — `once` does
    // exactly this — would otherwise mutate the set mid-iteration.
    for (const handler of [...set]) {
      try {
        (handler as (p: Events[K]) => void)(payload);
      } catch (error) {
        // One bad listener must not stop the others. A thrown error in a HUD
        // handler should never stop the game loop receiving its events.
        console.error(`event bus: handler for "${String(event)}" threw`, error);
      }
    }
  }

  function clear(): void {
    listeners.clear();
  }

  return { emit, on, once, off, clear };
}
