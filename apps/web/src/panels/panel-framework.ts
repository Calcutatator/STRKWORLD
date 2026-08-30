import type { BuildingId } from '@strkworld/shared';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { COPY } from '../copy.js';
import { buildingDoor, type LockReason } from './routes.js';

/**
 * The building-panel framework.
 *
 * A building is one of exactly three things when the player walks in, and the
 * three are deliberately distinct states rather than one "unavailable":
 *
 * - **panel** — a graded, approved route and a room built to drive it.
 * - **unbuilt** — the route is approved, the room is not written yet. This is a
 *   schedule fact and says nothing about privacy.
 * - **locked** — the privacy gate refused. Either the building has no graded
 *   route at all, or every route it has is a deviation nobody approved and
 *   disclosed (D-020). A locked door is the designed outcome, not a failure
 *   toast, and there is never a public fallback behind it (D-018).
 *
 * The resolver is generic over the panel descriptor so it can be tested without
 * a renderer: the room-resolution table is logic, the component is not.
 */

export type RoomResolution<TPanel> =
  | { kind: 'panel'; building: BuildingId; panel: TPanel }
  | { kind: 'unbuilt'; building: BuildingId; message: string }
  | { kind: 'locked'; building: BuildingId; reason: LockReason; message: string };

export type PanelRegistry<TPanel> = Partial<Record<BuildingId, TPanel>>;

export function resolveRoom<TPanel>(
  building: BuildingId,
  panels: PanelRegistry<TPanel>,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
): RoomResolution<TPanel> {
  // The privacy gate runs first, always. A room that exists behind an
  // unapproved route must not render just because somebody wrote it.
  const door = buildingDoor(building, register);
  if (!door.open) {
    return {
      kind: 'locked',
      building,
      reason: door.reason ?? 'unknown-route',
      message: door.message,
    };
  }

  if (panels === null || typeof panels !== 'object') {
    return { kind: 'unbuilt', building, message: COPY.unbuilt };
  }

  const panel = Object.prototype.hasOwnProperty.call(panels, building)
    ? panels[building]
    : undefined;
  if (!panel) {
    return { kind: 'unbuilt', building, message: COPY.unbuilt };
  }

  return { kind: 'panel', building, panel };
}
