import type { ApiRequest, ApiResponse } from './types.js';
import { ApiFailure, requireRecord, requireVersion } from './validation.js';

/**
 * Opt-in debug logs for a test deployment (D-069).
 *
 * The one deliberate exception to D-014's "logs nothing per-request". When,
 * and only when, `BACKEND_DEBUG_LOGS_ENABLED=true`, a tester's browser posts
 * its own client-side events here, and each becomes one stdout line:
 *
 *     [debug] <session> <ISO time> <level> <event> <detail>
 *
 * The sink reads the validated body and nothing else: no IP, no header and no
 * request timing, and the HTTP edge hands the core none of those anyway
 * (`http.ts`). Off, the path is not a route at all and answers exactly as an
 * unknown path does (`api.ts`). A launch deployment never sets the flag.
 */

export const DEBUG_LOGS_PATH = '/v1/debug/logs';
/** The whole body, measured as compact JSON in UTF-8 bytes. */
export const DEBUG_LOGS_MAX_BODY_BYTES = 32 * 1024;
export const DEBUG_LOGS_MAX_ENTRIES = 50;
/** In UTF-16 code units, as `String.length` counts them. */
export const DEBUG_LOGS_MAX_DETAIL_CHARS = 2_000;
/** Entries per window, across every session together. */
export const DEBUG_LOGS_RATE_LIMIT = 600;
export const DEBUG_LOGS_RATE_WINDOW_MS = 60_000;

export type DebugLogLevel = 'info' | 'warn' | 'error';

export interface DebugLogEntry {
  /** When the browser recorded it, in epoch milliseconds. */
  readonly t: number;
  readonly level: DebugLogLevel;
  readonly event: string;
  /** Printable text only: every control, format and lone-surrogate character is gone. */
  readonly detail: string;
}

export interface DebugLogBatch {
  readonly session: string;
  readonly entries: readonly DebugLogEntry[];
}

/** Receives one finished line, without its newline. */
export type DebugLogWriter = (line: string) => void;

const SESSION = /^[A-Za-z0-9-]{8,64}$/;
const EVENT = /^[a-z0-9.:-]{1,64}$/;
const LEVELS: ReadonlySet<unknown> = new Set(['info', 'warn', 'error']);
/** The latest instant `Date` can print. */
const MAX_TIME_MS = 8_640_000_000_000_000;
/** Whitespace controls and line separators: each would split one entry into several lines. */
const LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]+/g;
/**
 * Everything else that is not printable text: control characters, format
 * characters (the bidirectional overrides that can reorder a line among them)
 * and lone surrogates.
 */
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}]/gu;
/**
 * The session slot on the sink's own lines. Shorter than the shortest session
 * a client may send, so a client can never write a line that looks like one.
 */
const SINK_SESSION = 'server';

/**
 * Validate one posted batch, strictly: an unknown field, a bad entry or an
 * oversized body refuses the whole batch, and nothing from it is written.
 */
export function parseDebugLogBatch(body: unknown): DebugLogBatch {
  if (compactJsonBytes(body) > DEBUG_LOGS_MAX_BODY_BYTES) {
    throw new ApiFailure(413, 'The debug log batch is too large.');
  }
  const value = requireRecord(body, ['v', 'session', 'entries']);
  requireVersion(value);
  if (typeof value.session !== 'string' || !SESSION.test(value.session)) {
    throw new ApiFailure(400, 'Invalid debug log session.');
  }
  const entries = value.entries;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > DEBUG_LOGS_MAX_ENTRIES) {
    throw new ApiFailure(400, 'Invalid debug log entries.');
  }
  const parsed: DebugLogEntry[] = [];
  for (let index = 0; index < entries.length; index += 1) parsed.push(parseEntry(entries[index]));
  return { session: value.session, entries: parsed };
}

function parseEntry(value: unknown): DebugLogEntry {
  const entry = requireRecord(value, ['t', 'level', 'event', 'detail']);
  const { t, level, event, detail } = entry;
  if (typeof t !== 'number' || !Number.isSafeInteger(t) || t < 0 || t > MAX_TIME_MS) {
    throw new ApiFailure(400, 'Invalid debug log time.');
  }
  if (!LEVELS.has(level)) throw new ApiFailure(400, 'Invalid debug log level.');
  if (typeof event !== 'string' || !EVENT.test(event)) {
    throw new ApiFailure(400, 'Invalid debug log event.');
  }
  if (typeof detail !== 'string' || detail.length > DEBUG_LOGS_MAX_DETAIL_CHARS) {
    throw new ApiFailure(400, 'Invalid debug log detail.');
  }
  return { t, level: level as DebugLogLevel, event, detail: printable(detail) };
}

/** Collapse line breaks to one space and drop every other unprintable character. */
export function printable(text: string): string {
  return text.replace(LINE_BREAKS, ' ').replace(UNPRINTABLE, '');
}

/**
 * The body's size as the compact JSON a conforming client sends. The edge has
 * already bounded the raw read by `BACKEND_MAX_REQUEST_BYTES`.
 */
function compactJsonBytes(body: unknown): number {
  let text: string | undefined;
  try {
    text = JSON.stringify(body);
  } catch {
    throw new ApiFailure(400, 'Invalid debug log batch.');
  }
  if (text === undefined) return 0;
  // Every UTF-16 unit takes at least one UTF-8 byte: a longer string is over.
  if (text.length > DEBUG_LOGS_MAX_BODY_BYTES) return text.length;
  return new TextEncoder().encode(text).byteLength;
}

/** One entry as its stdout line. */
export function formatDebugLine(session: string, entry: DebugLogEntry): string {
  const head = `[debug] ${session} ${new Date(entry.t).toISOString()} ${entry.level} ${entry.event}`;
  return entry.detail ? `${head} ${entry.detail}` : head;
}

export interface DebugLogSinkOptions {
  /** Where lines go. Defaults to this process's stdout. */
  readonly write?: DebugLogWriter;
  readonly now?: () => number;
  /** Runs a limited window's drop summary when it ends. Defaults to an unref'd timer. */
  readonly schedule?: (run: () => void, delayMs: number) => void;
  readonly limit?: number;
  readonly windowMs?: number;
}

/**
 * The route and its global rate limit.
 *
 * Windows are fixed and start with the first entry after a quiet spell. Past
 * the limit an entry is dropped and counted, not written, and a window that
 * dropped anything ends with exactly one summary line — written when the
 * window's timer fires or the next batch arrives, whichever is first.
 */
export class DebugLogSink {
  private readonly write: DebugLogWriter;
  private readonly now: () => number;
  private readonly schedule: (run: () => void, delayMs: number) => void;
  private readonly limit: number;
  private readonly windowMs: number;
  private windowStartedAt: number | null = null;
  private written = 0;
  private dropped = 0;
  private summaryScheduled = false;

  constructor(options: DebugLogSinkOptions = {}) {
    this.write = options.write ?? writeDebugLogLine;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? scheduleUnref;
    this.limit = options.limit ?? DEBUG_LOGS_RATE_LIMIT;
    this.windowMs = options.windowMs ?? DEBUG_LOGS_RATE_WINDOW_MS;
    if (
      !Number.isSafeInteger(this.limit) || this.limit <= 0 ||
      !Number.isSafeInteger(this.windowMs) || this.windowMs <= 0
    ) {
      throw new Error('Debug log rate limits must be positive integers.');
    }
  }

  /** The `POST /v1/debug/logs` route. Never throws. */
  handle(request: ApiRequest): ApiResponse {
    if (request.method !== 'POST') return refusal(new ApiFailure(405, 'Method not allowed.'));
    let batch: DebugLogBatch;
    try {
      batch = parseDebugLogBatch(request.body);
    } catch (error) {
      return refusal(error instanceof ApiFailure ? error : new ApiFailure(400, 'Invalid debug log batch.'));
    }
    return { status: 202, body: this.accept(batch) };
  }

  /** Write a validated batch, one line an entry, within the global limit. */
  accept(batch: DebugLogBatch): { accepted: number; dropped: number } {
    const now = this.now();
    this.closeWindow(now, false);
    const startedAt = this.windowStartedAt ?? now;
    this.windowStartedAt = startedAt;
    let accepted = 0;
    for (const entry of batch.entries) {
      if (this.written >= this.limit) {
        this.dropped += 1;
        continue;
      }
      this.written += 1;
      accepted += 1;
      this.emit(formatDebugLine(batch.session, entry));
    }
    const dropped = batch.entries.length - accepted;
    if (dropped > 0 && !this.summaryScheduled) {
      this.summaryScheduled = true;
      this.schedule(() => {
        // A batch may already have closed this window and opened another.
        if (this.windowStartedAt === startedAt) this.closeWindow(this.now(), true);
      }, Math.max(0, startedAt + this.windowMs - now));
    }
    return { accepted, dropped };
  }

  private closeWindow(now: number, force: boolean): void {
    const startedAt = this.windowStartedAt;
    if (startedAt === null || (!force && now - startedAt < this.windowMs)) return;
    if (this.dropped > 0) {
      const entries = this.dropped === 1 ? 'entry' : 'entries';
      this.emit(
        `[debug] ${SINK_SESSION} ${new Date(now).toISOString()} warn debug.dropped ` +
          `${this.dropped} ${entries} dropped over the limit of ${this.limit} per ${this.windowMs / 1000} s`,
      );
    }
    this.windowStartedAt = null;
    this.written = 0;
    this.dropped = 0;
    this.summaryScheduled = false;
  }

  private emit(line: string): void {
    try {
      this.write(line);
    } catch {
      // A broken log stream must not fail the tester's request.
    }
  }
}

function refusal(failure: ApiFailure): ApiResponse {
  return { status: failure.status, body: { code: `HTTP_${failure.status}`, message: failure.message } };
}

function scheduleUnref(run: () => void, delayMs: number): void {
  const timer: unknown = setTimeout(run, delayMs);
  // A pending summary must never hold the process open through shutdown.
  (timer as { unref?: () => void }).unref?.();
}

let stdoutGuarded = false;

/** The production writer: one line to this process's stdout. */
export function writeDebugLogLine(line: string): void {
  if (!stdoutGuarded) {
    stdoutGuarded = true;
    // A closed stdout (the parent gone first) must never take the relay down.
    process.stdout.on('error', () => undefined);
  }
  process.stdout.write(`${line}\n`);
}
