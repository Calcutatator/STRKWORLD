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
}: ProductionBridgeRuntimeOptions): ProductionBridgeRuntime {
  const service = new BridgeService({
    client,
    store: new LocalBridgeStore(storage),
  });
  return Object.freeze({
    service,
    loadSources: () => loadSourceAssets(client),
  });
}
