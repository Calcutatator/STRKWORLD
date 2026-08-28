import {
  BridgeService,
  LocalBridgeStore,
  OneClickSdkClient,
  loadSourceAssets,
  type OneClickClient,
} from '@strkworld/bridge';
import type { BridgeSourceLoader } from './bridge-machine.js';

export interface ProductionBridgeRuntime {
  readonly service: BridgeService;
  readonly loadSources: BridgeSourceLoader;
}

export interface ProductionBridgeRuntimeOptions {
  /** Browser-local signed-record storage; never sent to STRKWORLD services. */
  readonly storage: Storage;
  /** Narrow injection seam for deterministic tests. */
  readonly client?: OneClickClient;
}

/**
 * Own the public Bridge recovery runtime without claiming shield-planner
 * capability. Construction performs no provider request and does not read the
 * saved record; those remain explicit panel actions.
 */
export function createProductionBridgeRuntime({
  storage,
  client = new OneClickSdkClient(),
}: ProductionBridgeRuntimeOptions): ProductionBridgeRuntime | null {
  if (!usablePersistentStorage(storage)) return null;
  const service = new BridgeService({
    client,
    store: new LocalBridgeStore(storage),
  });
  return Object.freeze({
    service,
    loadSources: () => loadSourceAssets(client),
  });
}

const STORAGE_PROBE_KEY = 'strkworld.bridge.storage-probe.v1';
const STORAGE_PROBE_VALUE = 'available';

/**
 * Recovery must not pretend to persist signed evidence when Web Storage is
 * absent, sandboxed or read-only. The probe runs only after BridgePanel asks
 * for the optional runtime and never contacts the provider.
 */
function usablePersistentStorage(storage: Storage): boolean {
  try {
    if (!storage || storage.getItem(STORAGE_PROBE_KEY) !== null) return false;
    storage.setItem(STORAGE_PROBE_KEY, STORAGE_PROBE_VALUE);
    if (storage.getItem(STORAGE_PROBE_KEY) !== STORAGE_PROBE_VALUE) {
      storage.removeItem(STORAGE_PROBE_KEY);
      return false;
    }
    storage.removeItem(STORAGE_PROBE_KEY);
    return storage.getItem(STORAGE_PROBE_KEY) === null;
  } catch {
    try { storage?.removeItem(STORAGE_PROBE_KEY); } catch { /* already unavailable */ }
    return false;
  }
}
