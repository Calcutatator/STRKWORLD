/**
 * Container launcher for @strkworld/backend.
 *
 * WHAT THIS DOES. The Backend lane owns the composition root in
 * `apps/backend/src/server.ts`: it strictly parses the runtime environment,
 * constructs the API and its server-side ports, and binds the logging-free
 * `node:http` listener. This file only resolves the compiled entry module and
 * imports it. Keeping deployment concerns here means the image has no second
 * configuration parser or request path to audit.
 *
 * `BACKEND_ENTRY` is deployment configuration, not request data. The default
 * is the compiled composition root used by the Dockerfile; an override exists
 * for an image layout change without changing this launcher.
 *
 * Logging: successful startup is silent. A missing or non-file entry emits one
 * configuration error to stderr and exits with EX_CONFIG; it must never gain
 * a per-request log line (D-014).
 */

import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = process.env.BACKEND_ENTRY ?? 'apps/backend/src/server.js';
const absolute = resolve(process.cwd(), entry);

function isRegularFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

if (!isRegularFile(absolute)) {
  process.stderr.write(
    [
      'strkworld-backend: cannot start — compiled entry is missing or invalid.',
      '',
      '  Build the backend image from the repository root so the compiled',
      '  composition root is copied into the expected path.',
      '',
    ].join('\n'),
  );
  // EX_CONFIG: a configuration problem, not a crash. Orchestrators treat a
  // non-zero exit as failed rather than retrying a doomed image forever.
  process.exit(78);
}

await import(pathToFileURL(absolute).href);
