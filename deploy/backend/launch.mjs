/**
 * Container launcher for @strkworld/backend.
 *
 * WHAT THIS DOES. The Backend lane owns the composition root in
 * `apps/backend/src/server.ts`: it strictly parses the runtime environment,
 * constructs the API and its server-side ports, and binds the logging-free
 * `node:http` listener. This file and its package-local loader witness only
 * resolve the compiled entry module and import it. Keeping deployment concerns
 * here means the image has no second configuration parser or request path to
 * audit.
 *
 * `BACKEND_ENTRY` is deployment configuration, not request data. The default
 * is the compiled composition root used by the Dockerfile; an override exists
 * for an image layout change without changing this launcher.
 *
 * Logging: successful startup is silent. A missing, non-file or concurrently
 * invalidated entry emits one configuration error to stderr and exits with
 * EX_CONFIG; it must never gain a per-request log line (D-014).
 */

import { realpathSync, statSync } from 'node:fs';
import { register } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = process.env.BACKEND_ENTRY ?? 'apps/backend/src/server.js';
const absolute = resolve(process.cwd(), entry);
const entryUrl = pathToFileURL(absolute).href;

function isRegularFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function canonicalPath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

function failEntryConfiguration() {
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

if (!isRegularFile(absolute)) {
  failEntryConfiguration();
}
const canonicalEntryPath = canonicalPath(absolute);
if (canonicalEntryPath === null) {
  failEntryConfiguration();
}
const loaderFailureState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
register(new URL('./launch-loader.mjs', import.meta.url), {
  parentURL: import.meta.url,
  data: {
    entryUrl,
    canonicalEntryUrl: pathToFileURL(canonicalEntryPath).href,
    absoluteEntryPath: absolute,
    canonicalEntryPath,
    failureBuffer: loaderFailureState.buffer,
  },
});

try {
  await import(entryUrl);
} catch (error) {
  // Only the loader can set this bit. An identically shaped Error thrown after
  // the Backend starts evaluating is therefore still a genuine startup crash.
  if (Atomics.load(loaderFailureState, 0) === 1) {
    failEntryConfiguration();
  }
  throw error;
}
