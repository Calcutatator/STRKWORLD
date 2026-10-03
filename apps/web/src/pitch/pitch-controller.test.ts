import { describe, expect, it } from 'vitest';
import { FOOTBALL_WIN_SCORE, PITCH_SLOTS, type GameId, type PitchMatchSnapshot, type PitchSlot } from '@strkworld/shared';
import { createPitchController, type PitchLobbyClient } from './pitch-controller.js';

/**
 * D-135: the Shell's adapter between the lobby client's match and the HUD and
 * the World. It holds no rules of its own — every figure is the room's.
 */

const SELF = 'abcdef0123456789' as GameId;

const slot = (kind: PitchSlot['kind'], gameId: GameId | null = null): PitchSlot =>
  Object.freeze({ kind, gameId: kind === 'player' ? gameId : null, x: 0, y: 0 });

function match(over: Partial<PitchMatchSnapshot> = {}): PitchMatchSnapshot {
  return Object.freeze({
    phase: 'open' as const,
    round: 1,
    slots: Object.freeze(Array.from({ length: PITCH_SLOTS }, () => slot('empty'))),
    starks: 0,
    snarks: 0,
    secondsLeft: 0,
    winner: null,
    ...over,
  });
}

/** A lobby client the test drives: it publishes matches and counts gate presses. */
function fakeClient(gameId: GameId | null = SELF) {
  let listener: ((value: PitchMatchSnapshot | null) => void) | undefined;
  let current: PitchMatchSnapshot | null = null;
  const client: PitchLobbyClient & { presses: number; accept: boolean; listening: boolean } = {
    presses: 0,
    accept: true,
    listening: false,
    gameId,
    pitchMatch: () => current,
    onPitchMatch(next) {
      listener = next;
      client.listening = true;
      next(current);
      return () => {
        listener = undefined;
        client.listening = false;
      };
    },
    pitchGate() {
      client.presses += 1;
      return client.accept;
    },
  };
  return {
    client,
    publish(value: PitchMatchSnapshot | null) {
      current = value;
      listener?.(value);
    },
  };
}

describe('the pitch controller (D-135)', () => {
  it('holds no match until a client is adopted, and sends no press', () => {
    const controller = createPitchController();
    expect(controller.channel.match()).toBeNull();
    expect(controller.channel.gate()).toBe(false);
    expect(controller.channel.selfSlot()).toBe(-1);
    controller.destroy();
  });

  it('republishes the client\'s match to every subscriber, replaying the current one first', () => {
    const controller = createPitchController();
    const lobby = fakeClient();
    lobby.publish(match({ phase: 'playing', starks: 1 }));
    controller.adopt(lobby.client);
    const seen: Array<PitchMatchSnapshot | null> = [];
    const stop = controller.channel.subscribe((value) => seen.push(value));
    // The first call replays what the channel already holds.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ phase: 'playing', starks: 1 });
    lobby.publish(match({ phase: 'playing', starks: 2 }));
    expect(seen.at(-1)).toMatchObject({ starks: 2 });
    expect(controller.channel.match()).toMatchObject({ starks: 2 });
    // Walking away from the pitch is a null match, which reaches the HUD too.
    lobby.publish(null);
    expect(seen.at(-1)).toBeNull();
    expect(controller.channel.match()).toBeNull();
    stop();
    lobby.publish(match());
    expect(seen.at(-1)).toBeNull();
    controller.destroy();
  });

  it('refuses a match that fails the shared normalizer, so a bad frame reaches no HUD', () => {
    const controller = createPitchController();
    const lobby = fakeClient();
    controller.adopt(lobby.client);
    lobby.publish({ ...match(), starks: FOOTBALL_WIN_SCORE + 1 } as PitchMatchSnapshot);
    expect(controller.channel.match()).toBeNull();
    controller.destroy();
  });

  it('sends a gate press through to the client, and reports what the client said', () => {
    const controller = createPitchController();
    const lobby = fakeClient();
    controller.adopt(lobby.client);
    expect(controller.channel.gate()).toBe(true);
    expect(lobby.client.presses).toBe(1);
    lobby.client.accept = false;
    expect(controller.channel.gate()).toBe(false);
    expect(lobby.client.presses).toBe(2);
    controller.destroy();
  });

  it('finds this client\'s own place, and -1 when it holds none', () => {
    const controller = createPitchController();
    const lobby = fakeClient();
    controller.adopt(lobby.client);
    lobby.publish(match({ phase: 'playing', slots: Object.freeze([slot('dummy'), slot('player', SELF), slot('dummy'), slot('dummy')]) }));
    expect(controller.channel.selfSlot()).toBe(1);
    // Someone else's match: the places are all other people's.
    lobby.publish(match({ phase: 'playing', slots: Object.freeze([slot('player', 'b00000000000000a' as GameId), slot('dummy'), slot('dummy'), slot('dummy')]) }));
    expect(controller.channel.selfSlot()).toBe(-1);
    controller.destroy();
  });

  it('never reports a place for a client with no presence id of its own', () => {
    const controller = createPitchController();
    const lobby = fakeClient(null);
    controller.adopt(lobby.client);
    lobby.publish(match({ phase: 'playing', slots: Object.freeze([slot('player', SELF), slot('dummy'), slot('dummy'), slot('dummy')]) }));
    expect(controller.channel.selfSlot()).toBe(-1);
    controller.destroy();
  });

  it('replaces the old client\'s feed when a new connection is adopted', () => {
    const controller = createPitchController();
    const first = fakeClient();
    const second = fakeClient();
    controller.adopt(first.client);
    controller.adopt(second.client);
    expect(first.client.listening).toBe(false);
    expect(second.client.listening).toBe(true);
    second.publish(match({ phase: 'countdown', secondsLeft: 3 }));
    expect(controller.channel.match()).toMatchObject({ phase: 'countdown' });
    // The old client's late publish reaches nothing.
    first.publish(match({ phase: 'ended', winner: 'starks', starks: FOOTBALL_WIN_SCORE }));
    expect(controller.channel.match()).toMatchObject({ phase: 'countdown' });
    controller.destroy();
  });

  it('ignores anything that is not a pitch client, and returns it untouched', () => {
    const controller = createPitchController();
    const stranger = { hello: 'world' };
    expect(controller.adopt(stranger)).toBe(stranger);
    expect(controller.channel.match()).toBeNull();
    controller.destroy();
  });

  it('lets one throwing subscriber never stop the others', () => {
    const controller = createPitchController();
    const lobby = fakeClient();
    controller.adopt(lobby.client);
    const seen: Array<PitchMatchSnapshot | null> = [];
    controller.channel.subscribe(() => {
      throw new Error('no');
    });
    controller.channel.subscribe((value) => seen.push(value));
    lobby.publish(match({ phase: 'playing' }));
    expect(seen.at(-1)).toMatchObject({ phase: 'playing' });
    controller.destroy();
  });

  it('stops listening and holds nothing once destroyed', () => {
    const controller = createPitchController();
    const lobby = fakeClient();
    controller.adopt(lobby.client);
    lobby.publish(match({ phase: 'playing' }));
    controller.destroy();
    expect(lobby.client.listening).toBe(false);
    expect(controller.channel.match()).toBeNull();
    expect(controller.channel.gate()).toBe(false);
    expect(lobby.client.presses).toBe(0);
    // And a late publish changes nothing.
    lobby.publish(match({ phase: 'ended', winner: 'snarks', snarks: FOOTBALL_WIN_SCORE }));
    expect(controller.channel.match()).toBeNull();
  });
});
