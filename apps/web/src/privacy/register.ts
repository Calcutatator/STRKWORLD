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

import {
  PRIVACY_REGISTER as SHARED_PRIVACY_REGISTER,
  isRoutePlayable,
} from '@strkworld/shared/src/privacy-grades.js';
import type { RouteGrade } from '@strkworld/shared/src/privacy-grades.js';

// The shared package owns the authored values, but its readonly TypeScript
// annotation is not a runtime boundary. The Web shell keeps its own frozen
// projection so a same-bundle consumer cannot rewrite a route grade or replace
// an entry after route admission has started.
export const PRIVACY_REGISTER: readonly RouteGrade[] = Object.freeze(
  SHARED_PRIVACY_REGISTER.map((entry) => Object.freeze({ ...entry })),
);

export { isRoutePlayable };
export type { PrivacyGrade, RouteGrade } from '@strkworld/shared/src/privacy-grades.js';
