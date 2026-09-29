import { createBackendRuntime } from '../../../apps/backend/src/runtime.js';

const READY_MESSAGE = { type: 'ready' } as const;
const runtime = createBackendRuntime(process.env);
await new Promise<void>((resolve, reject) => {
  runtime.server.once('error', reject);
  runtime.server.listen(runtime.port, '127.0.0.1', () => {
    runtime.server.off('error', reject);
    resolve();
  });
});
// D-070: the composition discards this process's output, so the relay's one
// startup line rides on the readiness message and the edge prints it.
process.send?.(runtime.startupNotice ? { ...READY_MESSAGE, notice: runtime.startupNotice } : READY_MESSAGE);
// D-076: start the Privacy Plaza's pool stats scan now, not when its first visitor asks.
runtime.api.warmPoolStats();

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  void new Promise<void>((resolve, reject) => {
    runtime.server.close((error) => error ? reject(error) : resolve());
  }).then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
