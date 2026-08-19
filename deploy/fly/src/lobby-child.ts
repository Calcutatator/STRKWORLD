import { startProductionLobby } from '../../../packages/lobby/src/production.js';

const READY_MESSAGE = { type: 'ready' } as const;
const server = await startProductionLobby(process.env);
process.send?.(READY_MESSAGE);

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  void server.shutdown().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
