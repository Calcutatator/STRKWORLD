import {
  createBackendRuntime,
  listenBackendServer,
  registerBackendShutdown,
} from './runtime.js';

const runtime = createBackendRuntime(process.env);
const starting = listenBackendServer(runtime.server, { port: runtime.port });
registerBackendShutdown(async () => (await starting).close());
await starting;
