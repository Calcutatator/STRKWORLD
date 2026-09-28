import type { Readable } from 'node:stream';

/**
 * The backend child's `[debug]` lines, and nothing else it prints (D-069).
 *
 * The composition discards every child's output. With
 * `BACKEND_DEBUG_LOGS_ENABLED=true` it pipes the backend's stdout here
 * instead, and only whole lines that start with the debug prefix reach the
 * container's stdout, so a dependency that prints something of its own is
 * still discarded. The lobby's output is never read.
 */

export const DEBUG_LINE_PREFIX = '[debug] ';
/** Far above the backend's longest line (about 2,200 characters); anything longer is dropped whole. */
export const MAX_DEBUG_LINE_CHARS = 8_192;

/** Whether the backend's debug lines are forwarded: exactly `true`, as the backend itself parses it. */
export function forwardsDebugLines(environment: NodeJS.ProcessEnv): boolean {
  return environment['BACKEND_DEBUG_LOGS_ENABLED'] === 'true';
}

/** Forward complete `[debug] ` lines from `stream` to `write`, one call a line, newline excluded. */
export function forwardDebugLines(stream: Readable, write: (line: string) => void): void {
  let pending = '';
  let overlong = false;
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    let start = 0;
    for (let newline = chunk.indexOf('\n'); newline >= 0; newline = chunk.indexOf('\n', start)) {
      const line = pending + chunk.slice(start, newline);
      start = newline + 1;
      pending = '';
      const wasOverlong = overlong;
      overlong = false;
      if (wasOverlong || line.length > MAX_DEBUG_LINE_CHARS || !line.startsWith(DEBUG_LINE_PREFIX)) continue;
      try {
        write(line);
      } catch {
        // A broken log stream must never take the edge down.
      }
    }
    if (overlong) return;
    pending += chunk.slice(start);
    if (pending.length > MAX_DEBUG_LINE_CHARS) {
      pending = '';
      overlong = true;
    }
  });
  // Nothing here may fail the composition: a read error just ends forwarding.
  stream.on('error', () => undefined);
}

/** The edge's own stdout. */
export function writeEdgeStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}
