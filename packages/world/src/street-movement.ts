import type { EventBus, Facing, Position, WorldEvents } from '@strkworld/shared';

export interface MovementInput {
  readonly left: boolean;
  readonly right: boolean;
  readonly up: boolean;
  readonly down: boolean;
}

export interface MovementPosition {
  readonly x: number;
  readonly y: number;
}

export interface MovementVelocity {
  readonly x: number;
  readonly y: number;
}

export function resolveMovementFacing(input: MovementInput, current: Facing): Facing {
  if (input.up) return 'up';
  if (input.down) return 'down';
  if (input.left) return 'left';
  if (input.right) return 'right';
  return current;
}

export interface CollisionSubstepOptions {
  readonly position: MovementPosition;
  readonly velocity: MovementVelocity;
  readonly delta: number;
  readonly tileSize: number;
  /** Half of the axis-aligned gameplay body; zero preserves anchor-only checks. */
  readonly collisionHalfSize?: number;
  readonly toTile: (x: number, y: number) => { x: number; y: number };
  readonly isSolidAt: (x: number, y: number) => boolean;
}

const MAX_COLLISION_SUBSTEPS = 256;
const MAX_COLLISION_STEP_PIXELS = 16;

/**
 * Move an interior player in bounded pixel increments. Interior collision is
 * tile-authored, so checking only the final endpoint can skip over a wall
 * when a frame is delayed. Half a tile is small enough to cross at most one
 * tile boundary per axis check while retaining the existing axis-separated
 * diagonal behaviour.
 */
export function moveWithCollisionSubsteps(options: CollisionSubstepOptions): MovementPosition {
  if (!options || typeof options !== 'object') return { x: 0, y: 0 };
  const position = options.position;
  const velocity = options.velocity;
  const current = {
    x: Number.isFinite(position?.x) ? position.x : 0,
    y: Number.isFinite(position?.y) ? position.y : 0,
  };
  if (
    !position ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    !velocity ||
    !Number.isFinite(velocity.x) ||
    !Number.isFinite(velocity.y) ||
    !Number.isFinite(options.delta) ||
    options.delta < 0 ||
    !Number.isFinite(options.tileSize) ||
    options.tileSize <= 0 ||
    (options.collisionHalfSize !== undefined &&
      (!Number.isFinite(options.collisionHalfSize) ||
        options.collisionHalfSize < 0 ||
        options.collisionHalfSize > options.tileSize)) ||
    typeof options.toTile !== 'function' ||
    typeof options.isSolidAt !== 'function'
  ) {
    return current;
  }

  if (options.delta === 0) return current;
  const duration = options.delta;
  const speed = Math.hypot(velocity.x, velocity.y);
  if (speed === 0) return current;

  // Clamp the per-step distance as well as the total work. This keeps an
  // authored tile boundary observable even for unusual tile sizes, while a
  // stalled tab or hostile delta cannot turn one frame into an unbounded loop.
  const maxStep = Math.min(options.tileSize / 2, MAX_COLLISION_STEP_PIXELS);
  if (!Number.isFinite(maxStep) || maxStep <= 0) return current;
  const maxTravel = maxStep * MAX_COLLISION_SUBSTEPS;
  const requestedTravel = speed * (duration / 1000);
  const travel = Number.isFinite(requestedTravel) ? Math.min(requestedTravel, maxTravel) : maxTravel;
  if (travel <= 0) return current;
  const effectiveDuration =
    Number.isFinite(requestedTravel) && requestedTravel <= maxTravel
      ? duration
      : (travel / speed) * 1000;
  const steps = Math.max(1, Math.ceil(travel / maxStep));
  const stepX = (velocity.x * effectiveDuration) / (1000 * steps);
  const stepY = (velocity.y * effectiveDuration) / (1000 * steps);
  const collisionHalfSize = options.collisionHalfSize ?? 0;

  const canOccupy = (x: number, y: number): boolean => {
    if (collisionHalfSize === 0) {
      const tile = options.toTile(x, y);
      return !options.isSolidAt(tile.x, tile.y);
    }
    // Derive every occupied tile through the caller's transform. Interior
    // coordinates are world-space (the fixed rooms are offset from the street
    // origin), so dividing by tileSize directly would shift their collision
    // grid. Inset the far edge so merely touching a tile boundary is allowed.
    const edgeInset = Math.min(
      collisionHalfSize / 2,
      Number.EPSILON * Math.max(1, Math.abs(x), Math.abs(y), options.tileSize) * 4,
    );
    const corners = [
      options.toTile(x - collisionHalfSize + edgeInset, y - collisionHalfSize + edgeInset),
      options.toTile(x + collisionHalfSize - edgeInset, y - collisionHalfSize + edgeInset),
      options.toTile(x - collisionHalfSize + edgeInset, y + collisionHalfSize - edgeInset),
      options.toTile(x + collisionHalfSize - edgeInset, y + collisionHalfSize - edgeInset),
    ];
    const minX = Math.min(...corners.map((tile) => tile.x));
    const maxX = Math.max(...corners.map((tile) => tile.x));
    const minY = Math.min(...corners.map((tile) => tile.y));
    const maxY = Math.max(...corners.map((tile) => tile.y));
    for (let tileY = minY; tileY <= maxY; tileY++) {
      for (let tileX = minX; tileX <= maxX; tileX++) {
        if (options.isSolidAt(tileX, tileY)) return false;
      }
    }
    return true;
  };

  for (let step = 0; step < steps; step++) {
    const nextX = current.x + stepX;
    if (canOccupy(nextX, current.y)) current.x = nextX;

    const nextY = current.y + stepY;
    if (canOccupy(current.x, nextY)) current.y = nextY;
  }

  return current;
}

/**
 * Publishes the street-only movement seam. The lobby owns throttling; this
 * reporter deliberately emits every street tick so the consumer can forward
 * the latest position without making Phaser know about the lobby.
 */
export interface StreetMovementReporter {
  readonly facing: Facing;
  update(position: Position, input: MovementInput): void;
  initial(position: Position): void;
}

export interface StreetMovementAdapter {
  readonly facing: Facing;
  initial(position: Position): void;
  streetUpdate(position: Position, input: MovementInput, afterMovement: () => void): void;
  interiorUpdate(afterMovement: () => void): void;
  exit(position: Position, afterPlacement: () => void): void;
}

export function createStreetMovementReporter(
  out: Pick<EventBus<WorldEvents>, 'emit'>,
): StreetMovementReporter {
  let facing: Facing = 'down';

  const publish = (position: Position): void => {
    // The shell may have several synchronous listeners. Do not let one of
    // them rewrite the caller's position or the payload observed by another.
    out.emit('player:moved', Object.freeze({
      position: Object.freeze({ ...position }),
      facing,
    }));
  };

  return {
    get facing() {
      return facing;
    },

    initial(position) {
      publish(position);
    },

    update(position, input) {
      // Vertical input wins when both axes are held. The important contract is
      // that a stopped player retains the last non-zero facing.
      facing = resolveMovementFacing(input, facing);
      publish(position);
    },
  };
}

/**
 * The small lifecycle seam used by StreetScene. Keeping the ordering here
 * makes the privacy-presence contract testable without constructing Phaser.
 */
export function createStreetMovementAdapter(
  out: Pick<EventBus<WorldEvents>, 'emit'>,
): StreetMovementAdapter {
  const reporter = createStreetMovementReporter(out);
  return {
    get facing() {
      return reporter.facing;
    },
    initial(position) {
      reporter.initial(position);
    },
    streetUpdate(position, input, afterMovement) {
      reporter.update(position, input);
      afterMovement();
    },
    interiorUpdate(afterMovement) {
      afterMovement();
    },
    exit(position, afterPlacement) {
      reporter.update(position, { left: false, right: false, up: false, down: false });
      afterPlacement();
    },
  };
}
