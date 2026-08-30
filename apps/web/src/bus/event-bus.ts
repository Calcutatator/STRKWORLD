import type { EventBus } from '@strkworld/shared';

/**
 * Copy event data before freezing it so a producer can safely reuse its own
 * object after emit. Event payloads are plain records/arrays at this seam;
 * primitive leaves remain unchanged and cycles retain their shape.
 */
function immutableSnapshot(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(immutableSnapshot(item, seen));
    return Object.freeze(copy);
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const key of Object.keys(value)) {
    copy[key] = immutableSnapshot((value as Record<string, unknown>)[key], seen);
  }
  return Object.freeze(copy);
}

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
  type Token = symbol;
  const listeners = new Map<keyof Events, Map<Handler, Token>>();

  function on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void {
    let eventListeners = listeners.get(event);
    if (!eventListeners) {
      eventListeners = new Map();
      listeners.set(event, eventListeners);
    }
    const typedHandler = handler as Handler;
    const token = Symbol();
    eventListeners.set(typedHandler, token);
    return () => {
      if (eventListeners?.get(typedHandler) !== token) return;
      eventListeners.delete(typedHandler);
      if (eventListeners.size === 0) listeners.delete(event);
    };
  }

  function off<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): void {
    const eventListeners = listeners.get(event);
    if (!eventListeners) return;
    eventListeners.delete(handler as Handler);
    if (eventListeners.size === 0) listeners.delete(event);
  }

  function once<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): () => void {
    const wrapped = (payload: Events[K]) => {
      off(event, wrapped);
      handler(payload);
    };
    return on(event, wrapped);
  }

  function emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const eventListeners = listeners.get(event);
    if (!eventListeners) return;
    const snapshot = immutableSnapshot(payload) as Events[K];
    // Snapshot ownership as well as handlers. A handler can unsubscribe or
    // replace another handler while this synchronous emission is in flight;
    // only the snapshot generation that is still current may be delivered.
    for (const [handler, token] of [...eventListeners]) {
      if (eventListeners.get(handler) !== token) continue;
      try {
        (handler as (p: Events[K]) => void)(snapshot);
      } catch (error) {
        // One bad listener must not stop the others. A thrown error in a HUD
        // handler should never stop the game loop receiving its events.
        console.error(`event bus: handler for "${String(event)}" threw`, error);
      }
    }
  }

  function clear(): void {
    for (const eventListeners of listeners.values()) eventListeners.clear();
    listeners.clear();
  }

  return { emit, on, once, off, clear };
}
