import type { ReactElement, ReactNode } from 'react';
import { COPY } from '../copy.js';
import type { RouteGrade } from '../privacy/register.js';
import type { StationDefinition } from '../visits/station-registry.js';
import { BankPanel } from './bank/BankPanel.js';
import { UnstakePanel } from './bank/UnstakePanel.js';
import { BorrowPanel } from './borrow/BorrowPanel.js';
import { VaultPanel } from './vault/VaultPanel.js';

/**
 * The window behind one of the Bank's, the Vault's or the Post Office's
 * counters (D-103), drawn from the station registry's meaning for it: the
 * same window whether the player walked up to the counter (Game Mode) or
 * chose its tab (Menu Mode, D-088). Admission is not decided here; the
 * caller has already resolved the station. Keyed by station, so moving to
 * another counter always mounts a fresh machine.
 */
export function CounterWindow({
  definition,
  experience,
  register,
  onClose,
  counters = null,
}: {
  definition: StationDefinition;
  experience: 'menu' | 'station';
  register: readonly RouteGrade[];
  onClose: () => void;
  /** Menu Mode's counter tabs; presentation only. */
  counters?: ReactNode;
}): ReactElement | null {
  switch (definition.view) {
    case 'bank':
      return (
        <BankPanel
          key={definition.station}
          experience={experience}
          building={definition.building}
          mode={definition.initialMode}
          register={register}
          title={COPY.buildings[definition.building]}
          onClose={onClose}
          counters={counters}
        />
      );
    case 'unstake':
      return <UnstakePanel key={definition.station} experience={experience} register={register} onClose={onClose} counters={counters} />;
    case 'vault':
      return <VaultPanel key={definition.station} experience={experience} mode={definition.mode} register={register} onClose={onClose} counters={counters} />;
    case 'borrow':
      return <BorrowPanel key={definition.station} experience={experience} modes={definition.modes} register={register} onClose={onClose} counters={counters} />;
    default:
      return null;
  }
}
