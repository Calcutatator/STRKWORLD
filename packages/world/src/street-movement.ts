import type { EventBus, Facing, Position, WorldEvents } from '@strkworld/shared';

export interface MovementInput {
  readonly left: boolean;
  readonly right: boolean;
  readonly up: boolean;
  readonly down: boolean;
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
      if (input.up) facing = 'up';
      else if (input.down) facing = 'down';
      else if (input.left) facing = 'left';
      else if (input.right) facing = 'right';
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
