/**
 * Hard-disable Colyseus's per-connection debug channels.
 *
 * Colyseus logs through the `debug` package. Its `colyseus:connection`,
 * `colyseus:message` and `colyseus:patch` namespaces print, respectively, join
 * and leave events, the type and body of every client message, and the encoded
 * state patches — i.e. a player's live coordinates and any client-supplied
 * string. All of that is exactly what this package must never record, and it
 * is one `DEBUG=colyseus:*` environment variable away from being printed by a
 * stock build.
 *
 * The `debug` package decides whether an instance prints from its `.enabled`
 * flag, set from `DEBUG` at construction. Colyseus constructs these instances
 * once and exports them, so forcing `.enabled = false` here turns them off for
 * good, regardless of the environment. We reach the exported instances rather
 * than calling `debug.disable()` so we suppress only Colyseus's channels and
 * leave any unrelated `debug` usage in the process alone.
 *
 * `debugError` is intentionally left alone: it carries server-level error
 * diagnostics, not per-connection payloads, and errors also flow through the
 * logger.
 */

import {
  debugConnection,
  debugDriver,
  debugMatchMaking,
  debugMessage,
  debugPatch,
  debugPresence,
} from '@colyseus/core';

type DebugInstance = { enabled: boolean };

let done = false;

/** Idempotent. Safe to call on every server start. */
export function silenceColyseusDebug(): void {
  if (done) return;
  const channels: unknown[] = [
    debugConnection,
    debugMessage,
    debugPatch,
    debugPresence,
    debugDriver,
    debugMatchMaking,
  ];
  for (const channel of channels) {
    (channel as DebugInstance).enabled = false;
  }
  done = true;
}
