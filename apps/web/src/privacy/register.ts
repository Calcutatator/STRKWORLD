/**
 * The one place the shell reaches into the privacy register.
 *
 * `packages/shared` declares no `exports` map and `src/index.ts` does not
 * re-export `privacy-grades.ts`, so the canonical approved copy (D-024) is
 * only reachable by deep path today. That is fragile — adding an `exports`
 * field to that package breaks every such import at once — so the whole shell
 * imports the register from here and this file carries the only deep path.
 *
 * When the `./privacy-grades` subpath lands, exactly one line below changes.
 */

export { PRIVACY_REGISTER, isRoutePlayable } from '@strkworld/shared/src/privacy-grades.js';
export type { PrivacyGrade, RouteGrade } from '@strkworld/shared/src/privacy-grades.js';
