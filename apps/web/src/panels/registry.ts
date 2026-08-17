import type { ComponentType } from 'react';
import type { BuildingId } from '@strkworld/shared';
import { COPY } from '../copy.js';
import { BankPanel } from './bank/BankPanel.js';
import type { PanelRegistry } from './panel-framework.js';

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
}

export interface BuildingPanelDescriptor {
  building: BuildingId;
  title: string;
  Component: ComponentType<BuildingPanelProps>;
}

export const BUILDING_PANELS: PanelRegistry<BuildingPanelDescriptor> = {
  bank: { building: 'bank', title: COPY.buildings.bank, Component: BankPanel },
};
