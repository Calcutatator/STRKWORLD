import type { ComponentType } from 'react';
import type { BuildingId } from '@strkworld/shared';
import { COPY } from '../copy.js';
import { BankPanel } from './bank/BankPanel.js';
import { PostOfficePanel } from './post-office/PostOfficePanel.js';
import { ExchangeMenuPanel } from './exchange/ExchangeMenuPanel.js';
import { BridgePanel } from './bridge/BridgePanel.js';
import { VaultMenuPanel } from './vault/VaultMenuPanel.js';
import type { PanelRegistry } from './panel-framework.js';
import type { RouteGrade } from '../privacy/register.js';

/**
 * Which buildings have a room written.
 *
 * A building missing from this map is not locked — it is unbuilt, which is a
 * schedule fact. Locking is decided by the privacy register alone, ahead of
 * this map (see `panel-framework.ts`), so adding a panel here can never open a
 * door the privacy gate closed.
 */

export interface BuildingPanelProps {
  onClose: () => void;
  register?: readonly RouteGrade[];
}

export interface BuildingPanelDescriptor {
  building: BuildingId;
  title: string;
  Component: ComponentType<BuildingPanelProps>;
}

export const BUILDING_PANELS: PanelRegistry<BuildingPanelDescriptor> = Object.freeze({
  bank: Object.freeze({ building: 'bank', title: COPY.buildings.bank, Component: BankPanel }),
  // D-088: the ground floor's swap, and the degen floor's whenever its
  // counter would open.
  exchange: Object.freeze({ building: 'exchange', title: COPY.buildings.exchange, Component: ExchangeMenuPanel }),
  'post-office': Object.freeze({
    building: 'post-office',
    title: COPY.buildings['post-office'],
    Component: PostOfficePanel,
  }),
  bridge: Object.freeze({ building: 'bridge', title: COPY.buildings.bridge, Component: BridgePanel }),
  // D-077: Menu Mode's Vault, the same window as its counter. Its routes'
  // doors still gate every control inside it. D-088: and the BORROW window
  // beside it whenever that counter would open.
  vault: Object.freeze({ building: 'vault', title: COPY.buildings.vault, Component: VaultMenuPanel }),
});
