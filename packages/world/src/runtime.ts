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

interface WorldBinding {
  readonly parent: HTMLElement;
  readonly config: WorldConfig;
}

interface WorldRuntime {
  readonly game: Game;
  /** Stable Phaser parent; React owners may change while the Game survives. */
  readonly mount: HTMLElement;
}

let host: Host<WorldRuntime, WorldBinding> | null = null;
let hostLoading: Promise<Host<WorldRuntime, WorldBinding>> | null = null;
let activeBinding: WorldBinding | null = null;
interface PendingAcquire {
  cancelled: boolean;
}

const pendingAcquires: PendingAcquire[] = [];

/**
 * Build the host lazily so `phaser` is only fetched when a world is actually
 * requested. Created once and reused, because the ref counting is only correct
 * if every caller shares one host.
 */
async function ensureHost(): Promise<Host<WorldRuntime, WorldBinding>> {
  if (host) return host;
  // Multiple React owners can request the world before the lazy Phaser
  // module resolves. Share that in-flight construction or each caller would
  // create a separate ref-count host and lose the first game's owner.
  if (hostLoading) return hostLoading;
  hostLoading = import('phaser').then((Phaser) => {
    const created = createHost<WorldRuntime, WorldBinding>({
      start: (binding) => {
        const mount = createWorldMount(binding.parent);
        binding.parent.appendChild(mount);
        try {
          const game = new Phaser.Game({
            type: Phaser.WEBGL,
            parent: mount,
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
            scene: [createStreetScene({ Phaser, remotePeers: binding.config.remotePeers })],
            callbacks: {
              // Phaser creates and boots scenes after `preBoot` but before
              // `postBoot`. The street scene captures the shell bus while it
              // creates its room controller, so it must be present at preBoot.
              preBoot: (game) => {
                game.registry.set('bus', binding.config);
              },
            },
          });
          activeBinding = binding;
          return { game, mount };
        } catch (error) {
          mount.parentNode?.removeChild(mount);
          throw error;
        }
      },
      retarget: (runtime, binding) => {
        const { game, mount } = runtime;
        game.registry.set('bus', binding.config);
        binding.parent.appendChild(mount);
        // `parent` remains the stable World-owned mount. Sample its new layout
        // before refresh so RESIZE consumes the replacement host dimensions.
        game.scale.getParentBounds();
        game.scale.refresh();
        game.scene.getScene('street').scene.restart();
        activeBinding = binding;
      },
      // Never destroy(true, true) — `noReturn` tears down the global plugin cache
      // and no further Game can be created on the page.
      stop: ({ game, mount }) => {
        activeBinding = null;
        try {
          game.destroy(true);
        } finally {
          mount.parentNode?.removeChild(mount);
        }
      },
    });
    host = created;
    return created;
  }).finally(() => {
    hostLoading = null;
  });
  return hostLoading;
}

/** Acquire the world. Safe to call twice in one tick; you get the same game. */
export async function acquireWorld(
  parent: HTMLElement,
  config: WorldConfig,
): Promise<Game> {
  const pendingAcquire: PendingAcquire = { cancelled: false };
  pendingAcquires.push(pendingAcquire);
  let h: Host<WorldRuntime, WorldBinding>;
  try {
    h = await ensureHost();
  } catch (error) {
    const failedIndex = pendingAcquires.indexOf(pendingAcquire);
    if (failedIndex !== -1) pendingAcquires.splice(failedIndex, 1);
    throw error;
  }
  const index = pendingAcquires.indexOf(pendingAcquire);
  if (index !== -1) pendingAcquires.splice(index, 1);
  const binding = activeBinding && sameBinding(activeBinding, parent, config)
    ? activeBinding
    : { parent, config };
  const game = h.acquire(binding).game;
  // A React owner may unmount while the lazy Phaser import is in flight. The
  // matching release is recorded above and must retire this lease immediately
  // after it is acquired, otherwise the late bootstrap leaks a live Game.
  if (pendingAcquire.cancelled) h.release();
  return game;
}

function createWorldMount(parent: HTMLElement): HTMLElement {
  const mount = parent.ownerDocument.createElement('div');
  mount.style.position = 'absolute';
  mount.style.inset = '0';
  mount.style.overflow = 'hidden';
  return mount;
}

/** Release it. Teardown is deferred, so a synchronous remount cancels it. */
export function releaseWorld(): void {
  const pendingAcquire = pendingAcquires.shift();
  if (pendingAcquire) {
    pendingAcquire.cancelled = true;
    return;
  }
  host?.release();
}

/** For assertions and debugging only. */
export function worldDebugState(): { refCount: number; alive: boolean } {
  return { refCount: host?.refCount ?? 0, alive: host?.current != null };
}

function sameBinding(
  current: WorldBinding,
  parent: HTMLElement,
  config: WorldConfig,
): boolean {
  return current.parent === parent &&
    current.config.out === config.out &&
    current.config.in === config.in &&
    current.config.remotePeers === config.remotePeers;
}
