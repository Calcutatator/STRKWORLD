import type { EventBus, ShellEvents, WorldEvents } from '@strkworld/shared';
import type { WalletSession } from '@strkworld/privacy';
import { App } from '../App.js';
import type { PresenceController } from '../presence/presence-controller.js';
import {
  WalletSessionProvider,
  useWalletSessionOptional,
} from '../wallet/WalletSessionProvider.js';

export function ProductionRoot({
  session,
  worldOut,
  shellIn,
  presence,
}: {
  session: WalletSession;
  worldOut: EventBus<WorldEvents>;
  shellIn: EventBus<ShellEvents>;
  presence: PresenceController;
}) {
  return (
    <WalletSessionProvider session={session}>
      <ProductionApp
        session={session}
        worldOut={worldOut}
        shellIn={shellIn}
        presence={presence}
      />
    </WalletSessionProvider>
  );
}

function ProductionApp({
  session,
  worldOut,
  shellIn,
  presence,
}: {
  session: WalletSession;
  worldOut: EventBus<WorldEvents>;
  shellIn: EventBus<ShellEvents>;
  presence: PresenceController;
}) {
  const wallet = useWalletSessionOptional();
  if (!wallet) throw new Error('ProductionApp needs a WalletSessionProvider.');
  return (
    <App
      worldOut={worldOut}
      shellIn={shellIn}
      presence={presence}
      operations={session.operations}
      walletSession={session}
      bridge={{
        account: wallet.snapshot.account,
        readAccount: session.readAccount,
        planner: null,
      }}
    />
  );
}
