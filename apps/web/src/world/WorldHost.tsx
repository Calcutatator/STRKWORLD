import { useEffect, useMemo, useRef } from 'react';
import type { ShellEvents, WorldEvents, EventBus } from '@strkworld/shared';
import type { RemotePeerSource, SandboxChannel } from '@strkworld/world';
import { worldLeaseManager } from './world-acquisition.js';

/**
 * Mounts the world into the React tree.
 *
 * Deliberately thin: React acquires and releases, and `@strkworld/world`
 * decides what that means. React must not own the game lifecycle — under
 * StrictMode it double-invokes effects, and a create-on-mount/destroy-on-unmount
 * component produces two engines and two WebGL contexts.
 *
 * Plain `useEffect`, not `useLayoutEffect`: nothing here needs to run before
 * paint, and the deferred teardown is what makes the double-invoke harmless.
 */
export function WorldHost({
  out,
  in: shellIn,
  remotePeers,
  sandbox,
  vaultOpen = false,
}: {
  out: EventBus<WorldEvents>;
  in: EventBus<ShellEvents>;
  remotePeers: RemotePeerSource;
  /** The shared block sandbox (D-060); optional in test compositions. */
  sandbox?: SandboxChannel;
  /**
   * Whether the Vault's street door opens (D-077): the Shell's answer from
   * the register and this build's policy, never the World's to decide.
   * Absent or false keeps D-007's locked facade.
   */
  vaultOpen?: boolean;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const leaseKey = useMemo(
    () => ({ out, shellIn, remotePeers, sandbox, vaultOpen }),
    [out, shellIn, remotePeers, sandbox, vaultOpen],
  );

  useEffect(() => {
    const node = parent.current;
    if (!node) return;

    // Dynamic import keeps the Three.js engine (D-059) out of the entry chunk.
    return worldLeaseManager.acquire(async () => {
      const runtime = await import('@strkworld/world/runtime');
      await runtime.acquireWorld(node, {
        out,
        in: shellIn,
        remotePeers,
        ...(sandbox ? { sandbox } : {}),
        ...(vaultOpen ? { vaultOpen } : {}),
      });
      return runtime.releaseWorld;
    }, leaseKey);
  }, [out, shellIn, remotePeers, sandbox, vaultOpen, leaseKey]);

  return <div ref={parent} className="world-host" data-testid="world-host" />;
}
