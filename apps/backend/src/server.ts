import {
  createBackendRuntime,
  listenBackendServer,
  registerBackendShutdown,
} from './runtime.js';

const runtime = createBackendRuntime(process.env);
const starting = listenBackendServer(runtime.server, { port: runtime.port });
registerBackendShutdown(async () => (await starting).close());
await starting;
// D-070: one line at startup when relayed routes will be refused, never per request (D-014).
if (runtime.startupNotice) process.stdout.write(`${runtime.startupNotice}\n`);
// D-076: start the plaza's pool stats scan now, not when its first visitor asks.
runtime.api.warmPoolStats();
