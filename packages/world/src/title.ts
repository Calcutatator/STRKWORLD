/**
 * The title screen's live backdrop: the overworld behind the connect menu and
 * the entry gate (`three/title-backdrop.ts`).
 *
 * Shaped like `runtime.ts`: the Shell loads this module dynamically and it
 * loads the Three.js scene dynamically, so `three` stays out of the entry
 * chunk. One ref-counted instance is shared by every title screen: the Shell
 * shows a new one for each step of the way in (choose a wallet, the
 * capability check, the entry gate), and each takes the same canvas over,
 * so the camera's drift carries on across them instead of starting again.
 * The last release tears it down after a short grace, long enough for the
 * next step's screen to take it over and short enough that it is gone by the
 * time the city's own engine is running.
 */
import { createHost, type Host } from './host.js';
import type { TitleBackdrop } from './three/title-backdrop.js';

/** What the backdrop is showing: still building, drawing, or not available (no WebGL). */
export type TitleBackdropStatus = 'loading' | 'ready' | 'unavailable';

export interface TitleBackdropRequest {
  /** Draw the Vault's door as the game will (D-077). Read when the backdrop starts. */
  readonly vaultOpen?: boolean;
  /** Told the current status at once, and again whenever it changes. */
  readonly onStatus?: (status: TitleBackdropStatus) => void;
}

/** How long the last release waits before tearing the backdrop down. */
export const TITLE_RELEASE_GRACE_MS = 250;

interface Binding {
  readonly parent: HTMLElement;
  readonly request: TitleBackdropRequest;
}

interface Runtime {
  readonly mount: HTMLElement;
  backdrop: TitleBackdrop | null;
  status: TitleBackdropStatus;
  listener: TitleBackdropRequest['onStatus'];
  /** The deferred build, cancelled if the backdrop is released first. */
  buildTimer: ReturnType<typeof setTimeout> | null;
}

let host: Host<Runtime, Binding> | null = null;
let hostLoading: Promise<Host<Runtime, Binding>> | null = null;
interface PendingAcquire {
  cancelled: boolean;
}
const pendingAcquires: PendingAcquire[] = [];

function tell(runtime: Runtime): void {
  try {
    runtime.listener?.(runtime.status);
  } catch {
    // A listener's failure is its own.
  }
}

function setStatus(runtime: Runtime, status: TitleBackdropStatus): void {
  if (runtime.status === status) return;
  runtime.status = status;
  tell(runtime);
}

async function ensureHost(): Promise<Host<Runtime, Binding>> {
  if (host) return host;
  if (hostLoading) return hostLoading;
  hostLoading = import('./three/title-backdrop.js').then(({ createTitleBackdrop, prefersReducedMotion }) => {
    const created = createHost<Runtime, Binding>({
      start: ({ parent, request }) => {
        const mount = createMount(parent);
        parent.appendChild(mount);
        const runtime: Runtime = { mount, backdrop: null, status: 'loading', listener: request.onStatus, buildTimer: null };
        tell(runtime);
        const win = parent.ownerDocument.defaultView;
        const reduced = win ? prefersReducedMotion(win) : true;
        // Build after the menu has painted: the street takes a moment, and
        // the palette gradient behind it is a fine first frame.
        runtime.buildTimer = setTimeout(() => {
          runtime.buildTimer = null;
          try {
            runtime.backdrop = createTitleBackdrop({
              mount,
              vaultOpen: request.vaultOpen === true,
              onReady: () => {
                mount.style.opacity = '1';
                setStatus(runtime, 'ready');
              },
            });
          } catch {
            runtime.backdrop = null;
            setStatus(runtime, 'unavailable');
          }
        }, 0);
        if (!reduced) mount.style.transition = 'opacity 900ms ease-out';
        return runtime;
      },
      retarget: (runtime, { parent, request }) => {
        parent.appendChild(runtime.mount);
        runtime.listener = request.onStatus;
        runtime.backdrop?.resize();
        tell(runtime);
      },
      stop: (runtime) => {
        if (runtime.buildTimer !== null) clearTimeout(runtime.buildTimer);
        runtime.buildTimer = null;
        runtime.listener = undefined;
        try {
          runtime.backdrop?.destroy();
        } finally {
          runtime.backdrop = null;
          runtime.mount.parentNode?.removeChild(runtime.mount);
        }
      },
      defer: (fn) =>
        setTimeout(() => {
          const result = fn();
          if (result !== undefined) {
            void result.catch((error: unknown) => {
              queueMicrotask(() => {
                throw error;
              });
            });
          }
        }, TITLE_RELEASE_GRACE_MS),
      cancel: (handle) => clearTimeout(handle as never),
    });
    host = created;
    return created;
  }).finally(() => {
    hostLoading = null;
  });
  return hostLoading;
}

function createMount(parent: HTMLElement): HTMLElement {
  const mount = parent.ownerDocument.createElement('div');
  mount.style.position = 'absolute';
  mount.style.inset = '0';
  mount.style.overflow = 'hidden';
  mount.style.opacity = '0';
  mount.dataset.titleBackdrop = '';
  return mount;
}

/**
 * Show the backdrop in `parent`. A second caller shares the one backdrop and
 * takes its canvas over. Pair every call with `releaseTitleBackdrop`.
 */
export async function acquireTitleBackdrop(parent: HTMLElement, request: TitleBackdropRequest = {}): Promise<void> {
  const pending: PendingAcquire = { cancelled: false };
  pendingAcquires.push(pending);
  let h: Host<Runtime, Binding>;
  try {
    h = await ensureHost();
  } catch (error) {
    const failed = pendingAcquires.indexOf(pending);
    if (failed !== -1) pendingAcquires.splice(failed, 1);
    throw error;
  }
  const index = pendingAcquires.indexOf(pending);
  if (index !== -1) pendingAcquires.splice(index, 1);
  h.acquire({ parent, request });
  // Released while the scene module was loading: retire the lease at once.
  if (pending.cancelled) h.release();
}

/** Let go of the backdrop. The last release tears it down after a short grace. */
export function releaseTitleBackdrop(): void {
  const pending = pendingAcquires.shift();
  if (pending) {
    pending.cancelled = true;
    return;
  }
  host?.release();
}

/** For assertions and debugging only. */
export function titleBackdropDebugState(): { refCount: number; alive: boolean; status: TitleBackdropStatus | null } {
  return { refCount: host?.refCount ?? 0, alive: host?.current != null, status: host?.current?.status ?? null };
}
