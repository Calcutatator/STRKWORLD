import { useEffect, useRef } from 'react';
import type { ShellEvents, WorldEvents, EventBus } from '@strkworld/shared';

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
}: {
  out: EventBus<WorldEvents>;
  in: EventBus<ShellEvents>;
}) {
  const parent = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = parent.current;
    if (!node) return;

    let cancelled = false;
    // Dynamic import keeps Phaser (~353 kB gzip, does not tree-shake) out of
    // the entry chunk.
    void import('@strkworld/world/runtime').then(({ acquireWorld }) => {
      if (cancelled) return;
      return acquireWorld(node, { out, in: shellIn });
    });

    return () => {
      cancelled = true;
      void import('@strkworld/world/runtime').then(({ releaseWorld }) =>
        releaseWorld(),
      );
    };
  }, [out, shellIn]);

  return <div ref={parent} className="world-host" data-testid="world-host" />;
}
