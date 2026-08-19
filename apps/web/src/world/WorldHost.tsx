import { useEffect, useMemo, useRef } from 'react';
import type { ShellEvents, WorldEvents, EventBus } from '@strkworld/shared';
import type { RemotePeerSource } from '@strkworld/world';
import { worldLeaseManager } from './world-acquisition.js';

/**
 * Mounts the world into the React tree.
 *
 * Deliberately thin: React acquires and releases, and `@strkworld/world`
 * decides what that means. React must not own the game lifecycle — under
 * StrictMode it double-invokes effects, and a create-on-mount/destroy-on-unmount
 * component produces two Phaser games and two WebGL contexts.
 *
 * Plain `useEffect`, not `useLayoutEffect`: nothing here needs to run before
 * paint, and the deferred teardown is what makes the double-invoke harmless.
 */
export function WorldHost({
  out,
  in: shellIn,
  remotePeers,
}: {
  out: EventBus<WorldEvents>;
  in: EventBus<ShellEvents>;
  remotePeers: RemotePeerSource;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const leaseKey = useMemo(() => ({ out, shellIn, remotePeers }), [out, shellIn, remotePeers]);

  useEffect(() => {
    const node = parent.current;
    if (!node) return;

    // Dynamic import keeps Phaser (~353 kB gzip, does not tree-shake) out of
    // the entry chunk.
    return worldLeaseManager.acquire(async () => {
      const runtime = await import('@strkworld/world/runtime');
      await runtime.acquireWorld(node, { out, in: shellIn, remotePeers });
      return runtime.releaseWorld;
    }, leaseKey);
  }, [out, shellIn, remotePeers, leaseKey]);

  return <div ref={parent} className="world-host" data-testid="world-host" />;
}
