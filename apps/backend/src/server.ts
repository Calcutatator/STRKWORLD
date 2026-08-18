import { createBackendRuntime, listenBackendServer } from './runtime.js';

const runtime = createBackendRuntime(process.env);
await listenBackendServer(runtime.server, { port: runtime.port });
