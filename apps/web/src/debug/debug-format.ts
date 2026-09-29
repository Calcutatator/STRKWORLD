import type { Intent, OperationStage, PrivacyErrorKind } from '@strkworld/privacy';
import { SANDBOX_AREA } from '@strkworld/shared';
import type { BankAddRefusal, BankConfirmStage, BankMode } from '../panels/bank/bank-machine.js';
import type { EntryGateStateName } from '../connect/entry-gate.js';

/**
 * What the opt-in debug logger (D-069) writes, and what it removes first.
 *
 * Pure text formatting: a failure, a value or a transition as one line.
 * Only the owner's own test session ever reaches the server, so the connected
 * account address, and the amounts and addresses a wallet error mentions, may
 * pass. Wallet signatures, calldata and proof data never may. They are
 * dropped by key where the shape is known and redacted by pattern where it is
 * not. The app holds no viewing key or proof of its own to leak.
 *
 * Every read is of data properties only, inside a try: wallet errors are
 * foreign objects, and a getter or proxy trap must not run or escape here.
 */

export type DebugLevel = 'info' | 'warn' | 'error';

/** The server's own limits (`apps/backend/src/debug-logs.ts`), in UTF-16 units. */
export const MAX_DETAIL_CHARS = 2_000;
const MAX_EVENT_CHARS = 64;
const MAX_LEAF_CHARS = 300;
const MAX_ITEMS = 20;
const MAX_DEPTH = 3;
const MAX_CHAIN = 6;
const MAX_FRAMES = 6;

/**
 * The shipped Wallet API error codes (`@starknet-io/types-js`
 * `wallet-api/errors.d.ts`), inlined because the shell may not import the
 * chain packages.
 */
export const WALLET_ERROR_NAMES: Readonly<Record<number, string>> = Object.freeze({
  111: 'NOT_ERC20',
  112: 'UNLISTED_NETWORK',
  113: 'USER_REFUSED_OP',
  114: 'INVALID_REQUEST_PAYLOAD',
  115: 'ACCOUNT_ALREADY_DEPLOYED',
  116: 'DEPLOYMENT_DATA_NOT_AVAILABLE',
  117: 'CHAIN_ID_NOT_SUPPORTED',
  118: 'NOT_REGISTERED',
  119: 'INSUFFICIENT_PRIVATE_BALANCE',
  120: 'PRIVACY_LEAK',
  162: 'API_VERSION_NOT_SUPPORTED',
  163: 'UNKNOWN_ERROR',
});

/** Every PrivacyError kind; a record, so a kind the seam adds cannot be missed here. */
const KINDS = setOf({
  'not-registered': true,
  'recipient-not-registered': true,
  'insufficient-balance': true,
  'privacy-leak': true,
  'unsupported-wallet': true,
  'user-rejected': true,
  unreachable: true,
  'submission-uncertain': true,
  'relay-not-configured': true,
  'shadow-accounts-unsupported': true,
  unknown: true,
} satisfies Record<PrivacyErrorKind, true>);

const LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]+/g;
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}]/gu;
const FELT = '0x[0-9a-fA-F]{1,64}';
const FELTS = new RegExp(FELT, 'g');
/**
 * Two or more felts with only separators between them, and the brackets or
 * quotes around them: calldata, a signature, proof facts.
 */
const FELT_RUN = new RegExp(`[\\["']*${FELT}(?:[\\s,;"'\\[\\]]+${FELT})+["'\\]]*`, 'g');
/** Hex longer than any one felt. */
const LONG_HEX = /(?:0x)?[0-9a-fA-F]{65,}/g;
/** A base64-shaped run longer than any address: proof bytes, a fee authorization, an icon. */
const LONG_BLOB = /[A-Za-z0-9+/_-]{80,}={0,2}/g;
/** Keys whose values never leave the browser, whatever they hold. */
const SECRET_KEYS = /^(?:signatures?|call_?data|proofs?|proof_?facts|artifacts?|(?:fee_?)?authorization|witness|viewing_?key|private_?key|secret|mnemonic|seed)$/i;
const ERROR_CODE = /^[A-Z0-9_]{1,64}$/;

/** Printable, redacted and at most `max` characters: ready to send. */
export function cleanText(value: string, max = MAX_DETAIL_CHARS): string {
  return clip(redact(value.replace(LINE_BREAKS, ' ').replace(UNPRINTABLE, '')), max);
}

/** Replace anything shaped like calldata, a signature or proof data. */
export function redact(text: string): string {
  return text
    .replace(FELT_RUN, (run) => `[${run.match(FELTS)?.length ?? 0} felts redacted]`)
    .replace(LONG_HEX, '[hex redacted]')
    .replace(LONG_BLOB, '[data redacted]');
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max - 1);
  // Never leave half a surrogate pair behind.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}\u2026`;
}

/** An event name the server admits: `[a-z0-9.:-]{1,64}`. */
export function eventName(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9.:-]/g, '-').slice(0, MAX_EVENT_CHARS);
  return cleaned || 'event';
}

/** A declined wallet request is the player's choice, not a fault. */
export function failureLevel(error: unknown): DebugLevel {
  return failureFacts(error).kind === 'user-rejected' ? 'warn' : 'error';
}

/**
 * A privacy or wallet failure: its PrivacyError kind, the wallet's error code
 * where one is available, and the messages along its cause chain, e.g.
 * `kind=not-registered code=118 NOT_REGISTERED message="…" cause="…"`.
 */
export function describeFailure(error: unknown): string {
  const facts = failureFacts(error);
  const parts: string[] = [];
  if (facts.kind) parts.push(`kind=${facts.kind}`);
  if (facts.code !== null) parts.push(`code=${formatCode(facts.code)}`);
  if (!facts.kind && facts.name) parts.push(`name=${facts.name}`);
  const [message, ...causes] = facts.messages;
  if (message !== undefined) parts.push(`message=${quote(message)}`);
  if (causes.length > 0) parts.push(`cause=${quote(causes.join(' <- '))}`);
  return parts.length > 0 ? parts.join(' ') : describeValue(error);
}

/** Anything handed to `console.*` or rejected unhandled. */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return serialize(value, 0, new Set());
}

interface FailureFacts {
  kind: string | null;
  code: number | string | null;
  name: string | null;
  messages: string[];
}

function failureFacts(error: unknown): FailureFacts {
  const facts: FailureFacts = { kind: null, code: null, name: null, messages: [] };
  const seen = new Set<object>();
  // Breadth first, so the outermost kind and message come first: the Shell's
  // failure, then the PrivacyError, then the wallet's own error.
  let level: unknown[] = [error];
  for (let depth = 0; depth < MAX_CHAIN && level.length > 0; depth += 1) {
    const next: unknown[] = [];
    for (const node of level) {
      if (!isObject(node) || seen.has(node)) continue;
      seen.add(node);
      const kind = readData(node, 'kind');
      if (facts.kind === null && KINDS.has(kind)) facts.kind = kind as string;
      const code = readData(node, 'code');
      if (facts.code === null && isCode(code)) facts.code = code;
      const { name, message } = errorText(node);
      if (facts.name === null && name && name !== 'Error') facts.name = name;
      if (message && !facts.messages.includes(message)) facts.messages.push(message);
      next.push(readData(node, 'cause'), readData(node, 'error'));
    }
    level = next;
  }
  return facts;
}

function isCode(value: unknown): value is number | string {
  return (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && ERROR_CODE.test(value));
}

function formatCode(code: number | string): string {
  if (typeof code === 'string') return code;
  const name = WALLET_ERROR_NAMES[code];
  return name ? `${code} ${name}` : String(code);
}

/** An error's name and message, read without running a getter a foreign object defines. */
function errorText(node: object): { name: string | null; message: string | null } {
  let name = readData(node, 'name');
  let message = readData(node, 'message');
  try {
    // A genuine DOMException keeps both behind its own brand-checked getters.
    if (node instanceof DOMException) {
      name = node.name;
      message = node.message;
    }
  } catch {
    // A proxy's prototype trap: keep what the data properties said.
  }
  return {
    name: typeof name === 'string' ? name : null,
    message: typeof message === 'string' && message !== '' ? message : null,
  };
}

function serialize(value: unknown, depth: number, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string': return quote(value.length > MAX_LEAF_CHARS ? `${value.slice(0, MAX_LEAF_CHARS)}\u2026` : value);
    case 'number':
    case 'boolean':
    case 'undefined': return String(value);
    case 'bigint': return `${value}n`;
    case 'symbol': return '[symbol]';
    case 'function': return '[function]';
    default: break;
  }
  const object = value as object;
  if (seen.has(object)) return '[cycle]';
  seen.add(object);
  try {
    if (isErrorLike(object)) return describeError(object);
    if (object instanceof Date) return Number.isNaN(object.getTime()) ? '[date]' : object.toISOString();
    if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer) return '[bytes]';
    if (object instanceof Map) return `[map of ${object.size}]`;
    if (object instanceof Set) return `[set of ${object.size}]`;
    if (typeof Node !== 'undefined' && object instanceof Node) return `[${object.nodeName.toLowerCase()}]`;
  } catch {
    return '[object]';
  }
  if (depth >= MAX_DEPTH) return Array.isArray(object) ? '[array]' : '[object]';
  if (Array.isArray(object)) {
    const length = readData(object, 'length');
    const count = typeof length === 'number' && Number.isSafeInteger(length) ? length : 0;
    const items: string[] = [];
    for (let index = 0; index < Math.min(count, MAX_ITEMS); index += 1) {
      items.push(serialize(readData(object, String(index)), depth + 1, seen));
    }
    if (count > MAX_ITEMS) items.push(`\u2026${count - MAX_ITEMS} more`);
    return `[${items.join(',')}]`;
  }
  let keys: string[];
  try {
    keys = Object.keys(object);
  } catch {
    return '[object]';
  }
  const fields = keys.slice(0, MAX_ITEMS).map((key) => {
    if (SECRET_KEYS.test(key)) return `${quote(key)}:[redacted]`;
    const descriptor = ownDescriptor(object, key);
    const shown = descriptor && 'value' in descriptor ? serialize(descriptor.value, depth + 1, seen) : '[getter]';
    return `${quote(key)}:${shown}`;
  });
  if (keys.length > MAX_ITEMS) fields.push(`\u2026${keys.length - MAX_ITEMS} more`);
  return `{${fields.join(',')}}`;
}

function isErrorLike(object: object): boolean {
  try {
    if (object instanceof Error) return true;
  } catch {
    return false;
  }
  return typeof readData(object, 'message') === 'string' &&
    (typeof readData(object, 'name') === 'string' || KINDS.has(readData(object, 'kind')));
}

/** An error with its kind and code when it has them, and the top of its stack. */
function describeError(error: object): string {
  const facts = failureFacts(error);
  const head = facts.kind || facts.code !== null
    ? describeFailure(error)
    : `${facts.name ?? 'Error'}: ${facts.messages[0] ?? ''}`;
  const stack = readData(error, 'stack');
  const frames = typeof stack === 'string' ? stackFrames(stack) : '';
  return frames ? `${head} ${frames}` : head;
}

function stackFrames(stack: string): string {
  return stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at ') || /@\S+:\d+/.test(line))
    .slice(0, MAX_FRAMES)
    .join(' | ');
}

/** A connect-flow state, e.g. `connected strk20=true walletApi=0.10 registration=unknown confirmed=false`. */
export function describeConnectState(state: unknown): string {
  const name = readData(state, 'name');
  if (typeof name !== 'string') return 'unknown';
  const parts = [name];
  const capability = readData(state, 'capability');
  if (isObject(capability)) {
    parts.push(
      `strk20=${plain(readData(capability, 'supportsStrk20'))}`,
      `walletApi=${plain(readData(capability, 'walletApiVersion'))}`,
      `registration=${plain(readData(capability, 'registration'))}`,
    );
  }
  const confirmed = readData(state, 'registrationConfirmed');
  if (typeof confirmed === 'boolean') parts.push(`confirmed=${confirmed}`);
  if (name === 'unsupported-wallet') parts.push(`walletApi=${plain(readData(state, 'walletApiVersion'))}`);
  return parts.join(' ');
}

/**
 * A wallet-session snapshot. The account may be named: this is the owner's own
 * test session. Wallet names and icons are left out, since icons are data URLs.
 */
export function describeWalletSession(snapshot: unknown): string {
  const wallets = readData(snapshot, 'wallets');
  const count = Array.isArray(wallets) ? readData(wallets, 'length') : undefined;
  return [
    `phase=${plain(readData(snapshot, 'phase'))}`,
    `generation=${plain(readData(snapshot, 'generation'))}`,
    `wallets=${plain(count)}`,
    `selected=${plain(readData(snapshot, 'selectedKey'))}`,
    `account=${plain(readData(snapshot, 'account'))}`,
  ].join(' ');
}

/** The panel a visit state shows, or null for none: `station bank:shielding`, `menu bank`, `locked vault`. */
export function visitPanel(state: unknown): string | null {
  const name = readData(state, 'name');
  const building = readData(state, 'building');
  if (typeof building !== 'string') return null;
  if (name === 'locked') return `locked ${building}`;
  if (name !== 'visiting') return null;
  const surface = readData(state, 'surface');
  const surfaceName = readData(surface, 'name');
  if (surfaceName === 'menu') return `menu ${building}`;
  if (surfaceName !== 'station') return null;
  const station = readData(surface, 'station');
  return typeof station === 'string' ? `station ${station}` : null;
}

/** The Privacy Plaza's stations (D-076), the only ids a plaza line may name. */
const PLAZA_STATIONS = setOf({ 'plaza:monument': true, 'plaza:shells': true });

/**
 * The Privacy Plaza window a visit state shows (D-076), or null: its
 * station id, from a fixed list, and nothing else.
 */
export function plazaPanel(state: unknown): string | null {
  if (readData(state, 'name') !== 'plaza') return null;
  const station = readData(state, 'station');
  return PLAZA_STATIONS.has(station) ? String(station) : null;
}

/** A shell-game result as one entry, or null: `plaza.shells result=win`. */
export function describePlazaShells(result: unknown): { level: DebugLevel; event: string; detail: string } | null {
  if (result !== 'win' && result !== 'lose') return null;
  return { level: 'info', event: 'plaza.shells', detail: `result=${result}` };
}

/*
 * The Bank's steps (D-070). Each field is admitted only from its own fixed
 * list, typed against the union it comes from, so whatever a caller passes, no
 * amount, balance, recipient or token address can be written.
 */
const BANK_MODES = setOf({ shield: true, unshield: true, transfer: true, stake: true } satisfies Record<BankMode, true>);
const INTENT_KINDS = setOf({
  shield: true, unshield: true, transfer: true, swap: true, stake: true,
} satisfies Record<Intent['kind'], true>);
const ADD_REFUSALS = setOf({
  'not-an-intent': true,
  'mixed-shield-and-spend': true,
  'mixed-route-kinds': true,
  'swap-must-be-alone': true,
  'stake-must-be-alone': true,
  'one-recipient-per-send': true,
  'one-unshield-per-send': true,
  'non-positive-amount': true,
  'batch-full': true,
  'empty-batch': true,
  'gate-closed': true,
  'door-locked': true,
  'pool-not-loaded': true,
  'bad-amount': true,
  'bad-recipient': true,
  'recipient-unregistered': true,
  'recipient-check-failed': true,
} satisfies Record<BankAddRefusal, true>);
const CONFIRM_STAGES = setOf({
  composing: true,
  'awaiting-approval': true,
  proving: true,
  submitting: true,
  confirming: true,
  done: true,
  failed: true,
  submitted: true,
  'fee-moved': true,
  'plan-moved': true,
  'gate-closed': true,
} satisfies Record<OperationStage | BankConfirmStage, true>);

/**
 * A Bank step as one entry, or null for anything unexpected:
 * `bank.mode mode=unshield from=shield`, `bank.add-refused reason=…`,
 * `bank.prepare intents=1 kinds=unshield`, `bank.confirm stage=proving`.
 */
export function describeBankStep(step: unknown): { level: DebugLevel; event: string; detail: string } | null {
  switch (readData(step, 'step')) {
    case 'mode': {
      const mode = readData(step, 'mode');
      const from = readData(step, 'from');
      if (!BANK_MODES.has(mode) || !BANK_MODES.has(from)) return null;
      return { level: 'info', event: 'bank.mode', detail: `mode=${String(mode)} from=${String(from)}` };
    }
    case 'add-refused': {
      const reason = readData(step, 'reason');
      if (!ADD_REFUSALS.has(reason)) return null;
      return { level: 'warn', event: 'bank.add-refused', detail: `reason=${String(reason)}` };
    }
    case 'prepare': {
      const kinds = readData(step, 'kinds');
      const count = Array.isArray(kinds) ? readData(kinds, 'length') : undefined;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > MAX_ITEMS) return null;
      const listed: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const kind = readData(kinds, String(index));
        if (!INTENT_KINDS.has(kind)) return null;
        listed.push(String(kind));
      }
      return { level: 'info', event: 'bank.prepare', detail: `intents=${count} kinds=${listed.join(',')}` };
    }
    case 'confirm': {
      const stage = readData(step, 'stage');
      if (!CONFIRM_STAGES.has(stage)) return null;
      return { level: 'info', event: 'bank.confirm', detail: `stage=${String(stage)}` };
    }
    default:
      return null;
  }
}

/**
 * The tile a sandbox burst came from (D-071), as `x=60 y=10`: two integers
 * inside the square, or null for anything else.
 */
export function describeSandboxTile(tile: unknown): string | null {
  const x = readData(tile, 'x');
  const y = readData(tile, 'y');
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isInteger(x) || !Number.isInteger(y)) return null;
  const inside = x >= SANDBOX_AREA.x && x < SANDBOX_AREA.x + SANDBOX_AREA.width &&
    y >= SANDBOX_AREA.y && y < SANDBOX_AREA.y + SANDBOX_AREA.height;
  return inside ? `x=${x} y=${y}` : null;
}

/*
 * The entry gate's states (D-072), admitted from a fixed list typed against
 * the gate's own union, so a state added there is a compile error here until
 * it is listed. A name is all that is ever written.
 */
const GATE_STATES = setOf({
  recalling: true,
  ready: true,
  checking: true,
  'check-failed': true,
  deposit: true,
  preparing: true,
  review: true,
  depositing: true,
  landing: true,
  unconfirmed: true,
  'receipt-unreachable': true,
  'deposit-failed': true,
  'not-registered': true,
  passed: true,
} satisfies Record<EntryGateStateName, true>);

/** An entry-gate transition as one entry, or null for anything unexpected: `gate.state state=checking`. */
export function describeGateState(state: unknown): { level: DebugLevel; event: string; detail: string } | null {
  if (!GATE_STATES.has(state)) return null;
  return { level: 'info', event: 'gate.state', detail: `state=${String(state)}` };
}

/** A failed `/api` response: path, status and the body's code, and nothing else. */
export function describeApiFailure(path: string, status: number, body: unknown): string {
  const code = readData(body, 'code');
  return typeof code === 'string' && ERROR_CODE.test(code) ? `${path} ${status} ${code}` : `${path} ${status}`;
}

function setOf(record: Record<string, true>): ReadonlySet<unknown> {
  return new Set(Object.keys(record));
}

function plain(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '[unexpected]';
}

function quote(text: string): string {
  return JSON.stringify(text);
}

function isObject(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

function ownDescriptor(value: object, key: string): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return undefined;
  }
}

/** An own or inherited data property; an accessor or a throwing trap reads as absent. */
export function readData(value: unknown, key: string): unknown {
  if (!isObject(value)) return undefined;
  try {
    let current: object | null = value;
    for (let hops = 0; current !== null && hops < 8; hops += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return 'value' in descriptor ? descriptor.value : undefined;
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    // Hostile objects describe as absent.
  }
  return undefined;
}
