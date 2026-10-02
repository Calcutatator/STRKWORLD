/**
 * The avatar's gameplay collision body.
 *
 * This module held the approved 2D sheets' catalog (D-049/D-052). In-World
 * avatars have been procedural 3D figures since D-059, and the Shell's
 * wallet-attention cue (D-058), the catalog's last reader, shows the 3D
 * figure's pre-rendered walk (`avatar-walker.ts`) since 2026-09-30. The sheets
 * stay in `assets/player-sprites/v1/` as the approved art the 3D looks are
 * coloured from (`three/avatar-looks.ts`); nothing bundles them.
 */

import { PLAYER_BODY_SIZE } from '@strkworld/shared';

/**
 * The gameplay collision body, in pixels: the prior 24 px footprint. The
 * lobby measures climbs with the same shared body (D-106).
 */
export const AVATAR_BODY_SIZE = PLAYER_BODY_SIZE;
