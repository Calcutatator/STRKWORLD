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
process.send?.(READY_MESSAGE);

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
