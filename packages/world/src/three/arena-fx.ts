import { Group } from 'three';
import type { GameId } from '@strkworld/shared';
import type { ArenaViewFrame } from '../arena-channel.js';

/**
 * D-114: the arena's combat feedback (stream C fills this in): the dummy's
 * flash, wobble and topple, the damage numbers and the HP bar.
 *
 * PR 0 ships a no-op so the presenter (stream A) can mount `group` and call
 * `sync`/`update` now. C replaces the body; the factory's shape is the
 * contract and does not change.
 */

/** How the fx asks the remote avatar layer (C's `remote-avatars.ts`) to play a peer's swing. */
export interface RemoteSwingPort {
  playSwing(gameId: GameId): void;
}

export interface ArenaFxDeps {
  /** Reduced motion: no wobble, rise, topple or burst (§5.5 of the design). */
  reducedMotion(): boolean;
}

export interface ArenaFx {
  /** Apply the latest ring frame; `remote` plays peers' swings, null while there is no remote layer. */
  sync(frame: ArenaViewFrame | null, remote: RemoteSwingPort | null): void;
  update(dt: number): void;
  /** Mounted by the presenter in the arena room. */
  readonly group: Group;
  dispose(): void;
}

export function createArenaFx(deps: ArenaFxDeps): ArenaFx {
  void deps;
  const group = new Group();
  group.name = 'arena-fx';
  return Object.freeze({
    sync(_frame: ArenaViewFrame | null, _remote: RemoteSwingPort | null): void {},
    update(_dt: number): void {},
    group,
    dispose(): void {
      group.clear();
    },
  });
}
