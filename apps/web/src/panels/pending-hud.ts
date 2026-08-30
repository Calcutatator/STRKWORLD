import type { EventBus, ShellEvents } from '@strkworld/shared';

export interface PendingHudOwner {
  setBusy(busy: boolean): void;
  release(): void;
}

const BUS_OWNERS = new WeakMap<object, Set<symbol>>();

/** Keep the global HUD marker owned by every mounted financial handoff. */
export function createPendingHudOwner(bus: EventBus<ShellEvents> | null): PendingHudOwner {
  if (!bus) {
    return Object.freeze({ setBusy: () => {}, release: () => {} });
  }

  let owners = BUS_OWNERS.get(bus);
  if (!owners) {
    owners = new Set<symbol>();
    BUS_OWNERS.set(bus, owners);
  }
  const owner = Symbol('pending-hud');
  let busy = false;

  const publish = (): void => {
    bus.emit('hud:pending', { count: owners!.size });
  };

  return Object.freeze({
    setBusy(next: boolean): void {
      if (busy === next) return;
      busy = next;
      if (busy) owners!.add(owner);
      else owners!.delete(owner);
      publish();
    },
    release(): void {
      if (!busy) return;
      busy = false;
      owners!.delete(owner);
      publish();
    },
  });
}
