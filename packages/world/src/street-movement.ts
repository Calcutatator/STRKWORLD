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
    typeof options.toTile !== 'function' ||
    typeof options.isSolidAt !== 'function'
  ) {
    return current;
  }

  const duration = Math.max(options.delta, 1);
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

  for (let step = 0; step < steps; step++) {
    const currentTile = options.toTile(current.x, current.y);
    const nextX = current.x + stepX;
    const horizontalTile = options.toTile(nextX, current.y);
    if (!options.isSolidAt(horizontalTile.x, currentTile.y)) current.x = nextX;

    const nextY = current.y + stepY;
    const verticalTile = options.toTile(current.x, nextY);
    if (!options.isSolidAt(verticalTile.x, verticalTile.y)) current.y = nextY;
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
    out.emit('player:moved', { position, facing });
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
