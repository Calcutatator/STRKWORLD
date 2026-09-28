import type { BackendConfig, PrivateRoute } from './types.js';

/**
 * The private relay without an avnu Portal key (D-070).
 *
 * avnu's paymaster refuses the `sponsored_private` fee mode without an
 * `x-paymaster-api-key`: JSON-RPC 163, "x-paymaster-api-key is invalid". So a
 * relay with no key, or with a key avnu rejects, can never build a fee or
 * submit. The backend answers every relayed route with this one fixed 503
 * instead of a generic upstream failure, and while no key is set it never
 * calls avnu at all. The key is an access credential, not a budget: the relay
 * fee withdrawn inside each private transaction still repays avnu, so the
 * player pays and STRKWORLD sponsors nothing.
 */

export const RELAY_NOT_CONFIGURED_CODE = 'RELAY_NOT_CONFIGURED';
export const RELAY_NOT_CONFIGURED_MESSAGE = 'The private relay is not configured on this deployment.';

/** Thrown before avnu is called without a key, and in place of avnu's own key rejection. */
export class RelayNotConfiguredError extends Error {
  constructor() {
    super(RELAY_NOT_CONFIGURED_MESSAGE);
    this.name = 'RelayNotConfiguredError';
  }
}

/** Every private route goes through avnu's paymaster, for its fee and its submission. */
export const RELAYED_ROUTES = Object.freeze(['transfer', 'unshield', 'swap', 'stake'] as const satisfies readonly PrivateRoute[]);

/**
 * The enabled routes this deployment refuses for want of a key. None while a
 * key is set, and none while the kill switch is off, since every route then
 * answers SERVICE_DISABLED instead. A disabled route stays disabled.
 */
export function refusedRelayRoutes(
  config: Pick<BackendConfig, 'globalEnabled' | 'routes'>,
  keyConfigured: boolean,
): readonly PrivateRoute[] {
  if (keyConfigured || !config.globalEnabled) return Object.freeze([]);
  return Object.freeze(RELAYED_ROUTES.filter((route) => config.routes[route]?.enabled === true));
}

/**
 * The one line the relay writes at startup when it will refuse routes, or null.
 * Once per process, never per request (D-014), and it names routes only.
 */
export function relayStartupNotice(refused: readonly PrivateRoute[]): string | null {
  if (refused.length === 0) return null;
  return `[relay] AVNU_PAYMASTER_API_KEY is not set: ${refused.join(', ')} will answer 503 ${RELAY_NOT_CONFIGURED_CODE} until it is (D-070).`;
}

const ROUTE = '(?:transfer|unshield|swap|stake)';
const NOTICE_LINE = new RegExp(
  `^\\[relay\\] AVNU_PAYMASTER_API_KEY is not set: ${ROUTE}(?:, ${ROUTE}){0,3} will answer 503 ${RELAY_NOT_CONFIGURED_CODE} until it is \\(D-070\\)\\.$`,
);

/**
 * Whether a value is exactly such a line. The composition discards the
 * relay's own output, so the relay hands this line to the edge with its
 * readiness message, and the edge prints nothing else a child sends it.
 */
export function isRelayStartupNotice(value: unknown): value is string {
  return typeof value === 'string' && NOTICE_LINE.test(value);
}
