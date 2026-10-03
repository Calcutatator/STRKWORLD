import type { WorldEvents, ShellEvents, EventBus } from '@strkworld/shared';
import { createHost, type Host } from './host.js';
import type { RemotePeerSource } from './remote-peer.js';
import type { SandboxChannel } from './sandbox-channel.js';
import type { FootballChannel } from './football-channel.js';
import type { ArenaChannel } from './arena-channel.js';
import type { PitchChannel } from './pitch-channel.js';

/**
 * World wiring. The Shell loads this module dynamically, and it in turn loads
 * the Three.js engine dynamically (D-059), so the renderer stays in its own
 * chunk. A single *value* import of `three` in the eager graph would collapse
 * that split, which is why the engine import below is `import type` plus a
 * lazy `import()`.
 */
import type { WorldEngine } from './three/world-engine.js';

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
  /** Optional shared block sandbox (D-060), supplied by the Shell. */
  sandbox?: SandboxChannel;
  /** Optional shared football (D-078), supplied by the Shell. */
  football?: FootballChannel;
  /** Optional gladiator pit ring (D-114), supplied by the Shell. */
  arena?: ArenaChannel;
  /** Optional gated pitch match (D-135), supplied by the Shell. */
  pitch?: PitchChannel;
  /**
   * The Vault opens on shadow accounts, behind the Shell's switch (D-077): its
   * door opens onto its room. Absent or false, it is D-007's locked facade.
   * The World learns only that the door is open; the engine reads it once,
   * when it starts.
   */
  vaultOpen?: boolean;
  /**
   * Leaderboard phase 1: the placement stand east of the plaza, behind the
   * Shell's switch. Read once, when the engine starts, like `vaultOpen`.
   */
  placementStand?: boolean;
}

interface WorldBinding {
  readonly parent: HTMLElement;
  readonly config: WorldConfig;
}

interface WorldRuntime {
  readonly engine: WorldEngine;
  /** Stable renderer parent; React owners may change while the engine survives. */
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
 * Build the host lazily so `three` is only fetched when a world is actually
 * requested. Created once and reused, because the ref counting is only correct
 * if every caller shares one host.
 */
async function ensureHost(): Promise<Host<WorldRuntime, WorldBinding>> {
  if (host) return host;
  // Multiple React owners can request the world before the lazy engine module
  // resolves. Share that in-flight construction or each caller would create a
  // separate ref-count host and lose the first engine's owner.
  if (hostLoading) return hostLoading;
  hostLoading = import('./three/world-engine.js').then(({ createWorldEngine }) => {
    const created = createHost<WorldRuntime, WorldBinding>({
      start: (binding) => {
        const mount = createWorldMount(binding.parent);
        binding.parent.appendChild(mount);
        try {
          // Nothing in engine start does network I/O: under a mounting
          // regression it can run twice, and a lobby join here would produce
          // two presence entries for one player. Joins are Shell-driven.
          const engine = createWorldEngine({ mount, config: binding.config });
          activeBinding = binding;
          return { engine, mount };
        } catch (error) {
          mount.parentNode?.removeChild(mount);
          throw error;
        }
      },
      retarget: (runtime, binding) => {
        const { engine, mount } = runtime;
        binding.parent.appendChild(mount);
        // The engine keeps its WebGL context; only the session is rebuilt, so
        // it never holds a detached React node, the first Shell bus or a stale
        // remote-peer source.
        engine.resize();
        engine.rebind(binding.config);
        activeBinding = binding;
      },
      stop: ({ engine, mount }) => {
        activeBinding = null;
        try {
          engine.destroy();
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

/** Acquire the world. Safe to call twice in one tick; both share one engine. */
export async function acquireWorld(
  parent: HTMLElement,
  config: WorldConfig,
): Promise<void> {
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
  h.acquire(binding);
  // A React owner may unmount while the lazy engine import is in flight. The
  // matching release is recorded above and must retire this lease immediately
  // after it is acquired, otherwise the late bootstrap leaks a live engine.
  if (pendingAcquire.cancelled) h.release();
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
    current.config.remotePeers === config.remotePeers &&
    current.config.sandbox === config.sandbox &&
    current.config.football === config.football &&
    current.config.arena === config.arena &&
    current.config.pitch === config.pitch &&
    // Absent and false are the same locked Vault (D-077).
    (current.config.vaultOpen === true) === (config.vaultOpen === true) &&
    (current.config.placementStand === true) === (config.placementStand === true);
}
