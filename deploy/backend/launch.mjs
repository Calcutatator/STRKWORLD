/**
 * Container launcher for @strkworld/backend.
 *
 * WHAT THIS IS NOT. It holds no configuration, reads no environment variable
 * other than the one naming the entry module, opens no socket, and constructs
 * no port. All of that is the Backend lane's composition root, which does not
 * exist yet (see below). This file exists only so a container that cannot
 * start says why, once, instead of crash-looping on MODULE_NOT_FOUND.
 *
 * WHAT IS MISSING, precisely. `apps/backend` exports a framework-neutral core
 * and a Fetch API edge, and nothing that binds them to a port:
 *
 *   - No HTTP listener. `createBackendFetchHandler()`
 *     (apps/backend/src/http.ts:15) returns `(Request) => Promise<Response>`;
 *     nothing calls `node:http`.
 *   - No configuration loader. `process.env` appears nowhere under
 *     `apps/backend/src` — `BackendConfig` (apps/backend/src/types.ts:26) is
 *     constructed in code.
 *   - No composition root. Nothing instantiates `BackendApi`
 *     (apps/backend/src/api.ts:53) with `AvnuPaymasterPort`,
 *     `StarknetRpcPoolPort` and `HmacAuthorizationCodec`.
 *
 * Those are the Backend lane's, not the deployment lane's: choosing the
 * paymaster port, the fee ceilings and the HMAC secret handling is business
 * logic with privacy consequences (D-014, D-026). When that lane adds a
 * composition root that starts a listener, this launcher runs it unchanged —
 * default `apps/backend/src/server.js`, overridable with BACKEND_ENTRY.
 *
 * Logging: this file writes to stdout at startup and on fatal error only.
 * It must never gain a per-request log line (D-014).
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = process.env.BACKEND_ENTRY ?? 'apps/backend/src/server.js';
const absolute = resolve(process.cwd(), entry);

if (!existsSync(absolute)) {
  process.stderr.write(
    [
      'strkworld-backend: cannot start — no composition root.',
      '',
      `  expected: ${entry}`,
      '',
      '  apps/backend ships a request core (BackendApi) and a Fetch API edge',
      '  (createBackendFetchHandler) but nothing that binds them to a port,',
      '  loads configuration from the environment, or constructs the paymaster,',
      '  RPC and authorization ports. That work belongs to the Backend lane.',
      '',
      '  See docs/OPS.md, "Open items for the Backend lane".',
      '',
    ].join('\n'),
  );
  // EX_CONFIG: a configuration problem, not a crash. Orchestrators treat a
  // non-zero exit as failed rather than retrying a doomed image forever.
  process.exit(78);
}

await import(pathToFileURL(absolute).href);
