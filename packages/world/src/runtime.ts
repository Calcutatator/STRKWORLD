import type { WorldEvents, ShellEvents, EventBus } from '@strkworld/shared';
import { createHost, type Host } from './host.js';
import { createStreetScene } from './scenes/street-scene.js';
import type { RemotePeerSource } from './remote-peer.js';

/**
 * Phaser wiring. This is the only module in the package that imports Phaser,
 * and it is loaded dynamically by the shell.
 *
 * Phaser 4 does not tree-shake — `dist/phaser.esm.js` is one pre-bundled
 * artifact with no `sideEffects` field, so importing anything from it ships
 * ~353 kB gzip. Keeping it behind a dynamic import is what puts it in its own
 * chunk instead of the entry bundle. A single *value* import of `phaser`
 * anywhere in the eager graph collapses that split, which is why the type
 * import below is `import type`.
 */
import type * as PhaserTypes from 'phaser';

export interface WorldHandle {
  /** The world emits semantic events; the shell listens. */
  readonly out: EventBus<WorldEvents>;
  /** The shell pushes presentation data in; the world listens. */
  readonly in: EventBus<ShellEvents>;
}

export interface WorldConfig {
  out: EventBus<WorldEvents>;
  in: EventBus<ShellEvents>;
  /** Optional retained full snapshots for presentation-only remote avatars. */
  remotePeers?: RemotePeerSource;
}

type Game = PhaserTypes.Game;

let host: Host<Game, HTMLElement> | null = null;
let startConfig: WorldConfig | null = null;

/**
 * Build the host lazily so `phaser` is only fetched when a world is actually
 * requested. Created once and reused, because the ref counting is only correct
 * if every caller shares one host.
 */
async function ensureHost(): Promise<Host<Game, HTMLElement>> {
  if (host) return host;
  const Phaser = await import('phaser');

  host = createHost<Game, HTMLElement>({
    start: (parent) => {
      const config = startConfig;
      if (!config) throw new Error('World start requires the current acquisition config');
      return new Phaser.Game({
        type: Phaser.WEBGL,
        parent,
        // Phaser 4 flipped roundPixels to false. On a tilemap with a following
        // camera that reads as shimmering seams and gets misdiagnosed as
        // tileset spacing. pixelArt sets it back.
        pixelArt: true,
        scale: {
          mode: Phaser.Scale.RESIZE,
          autoCenter: Phaser.Scale.CENTER_BOTH,
        },
        physics: { default: 'arcade', arcade: { debug: false } },
        // Nothing in scene lifecycle does network I/O: under a mounting
        // regression create() runs twice, and a lobby join here would produce
        // two presence entries for one player. Joins are shell-driven.
        scene: [createStreetScene({ Phaser, remotePeers: config.remotePeers })],
        callbacks: {
          // Phaser creates and boots scenes after `preBoot` but before
          // `postBoot`. The street scene captures the shell bus while it
          // creates its room controller, so it must be present at preBoot.
          preBoot: (game) => {
            game.registry.set('bus', config);
          },
        },
      });
    },
    // Never destroy(true, true) — `noReturn` tears down the global plugin cache
    // and no further Game can be created on the page.
    stop: (game) => game.destroy(true),
  });

  return host;
}

/** Acquire the world. Safe to call twice in one tick; you get the same game. */
export async function acquireWorld(
  parent: HTMLElement,
  config: WorldConfig,
): Promise<Game> {
  const h = await ensureHost();
  startConfig = config;
  try {
    return h.acquire(parent);
  } finally {
    startConfig = null;
  }
}

/** Release it. Teardown is deferred, so a synchronous remount cancels it. */
export function releaseWorld(): void {
  host?.release();
}

/** For assertions and debugging only. */
export function worldDebugState(): { refCount: number; alive: boolean } {
  return { refCount: host?.refCount ?? 0, alive: host?.current != null };
}
