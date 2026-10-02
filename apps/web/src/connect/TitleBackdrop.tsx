import { useEffect, useRef, useState } from 'react';
import type { TitleBackdropStatus } from '@strkworld/world/title';

/**
 * The live overworld behind the title screen (`@strkworld/world/title`).
 *
 * React only acquires and releases, as `WorldHost` does: the World package
 * owns one backdrop for every title screen, so a new step of the way in takes
 * the same canvas over and its drift carries on. The scene module is loaded
 * on demand, so `three` stays out of the entry chunk.
 *
 * The palette gradient under the canvas is the first frame, and it is all a
 * browser without WebGL ever sees: there, nothing is loaded at all.
 */
export function TitleBackdrop() {
  const node = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<TitleBackdropStatus>(() =>
    webglLikely(typeof window === 'undefined' ? null : window) ? 'loading' : 'unavailable',
  );

  useEffect(() => {
    const parent = node.current;
    if (!parent) return;
    if (!webglLikely(parent.ownerDocument.defaultView)) {
      setStatus('unavailable');
      return;
    }
    let live = true;
    let lease: 'none' | 'held' = 'none';
    let release: (() => void) | null = null;
    void import('@strkworld/world/title')
      .then((title) => {
        if (!live) return;
        // From here a release is owed, even while the acquire is in flight:
        // the World package retires an acquire released before it lands.
        lease = 'held';
        release = title.releaseTitleBackdrop;
        return title.acquireTitleBackdrop(parent, {
          onStatus: (next) => {
            if (live) setStatus(next);
          },
        });
      })
      .catch(() => {
        lease = 'none';
        if (live) setStatus('unavailable');
      });
    return () => {
      live = false;
      if (lease === 'held') release?.();
      lease = 'none';
    };
  }, []);

  return <div ref={node} className="title-backdrop" data-status={status} aria-hidden="true" />;
}

/**
 * Whether this window could draw WebGL at all. A cheap, side-effect-free
 * check (no context is created): the backdrop finds out for certain when it
 * builds, and falls back to the gradient if it cannot.
 */
export function webglLikely(win: Window | null): boolean {
  if (!win) return false;
  const scope = win as Window & { WebGLRenderingContext?: unknown; WebGL2RenderingContext?: unknown };
  return typeof scope.WebGL2RenderingContext === 'function' || typeof scope.WebGLRenderingContext === 'function';
}
