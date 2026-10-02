import { describe, expect, it, vi } from 'vitest';
import {
  ARENA_MAX_HP,
  ARENA_RING_RETURN,
  ARENA_RING_SPAWN,
  arenaTileCentre,
  type ArenaPhase,
  type ArenaRingSnapshot,
  type Facing,
  type GameId,
} from '@strkworld/shared';
import type { ArenaChannel, ArenaSessionHost } from './arena-channel.js';
import {
  ARENA_BUSY_PROMPT,
  ARENA_CLAIM_PROMPT,
  ARENA_STRIKE_PROMPT,
  createArenaSession,
  dummyWithinReach,
  onArenaGateApproach,
} from './arena-session.js';
import { JUMP_TOTAL_MS } from './jump.js';

const SELF = 'g-self' as GameId;
const OTHER = 'g-other' as GameId;
const APPROACH = arenaTileCentre({ x: 20, y: 21 });
const SAND = arenaTileCentre({ x: 10, y: 16 });
const SPAWN = arenaTileCentre(ARENA_RING_SPAWN);
/** One tile south of the dummy, facing it. */
const NEXT_TO_DUMMY = arenaTileCentre({ x: 20, y: 15 });

interface RingInit {
  phase?: ArenaPhase;
  round?: number;
  challenger?: GameId | null;
  hp?: number;
  swings?: number;
  hits?: number;
}

function ring({ phase = 'idle', round = 0, challenger = null, hp = ARENA_MAX_HP, swings = 0, hits = 0 }: RingInit = {}): ArenaRingSnapshot {
  const busy = phase !== 'idle';
  return {
    phase,
    round,
    challenger: busy && challenger
      ? { kind: 'player', gameId: challenger, hp: ARENA_MAX_HP, swings, hits: 0 }
      : { kind: 'empty', gameId: null, hp: 0, swings: 0, hits: 0 },
    opponent: busy ? { kind: 'dummy', gameId: null, hp, swings: 0, hits } : { kind: 'empty', gameId: null, hp: 0, swings: 0, hits: 0 },
    secondsLeft: phase === 'countdown' ? 3 : phase === 'fighting' ? 90 : 0,
    outcome: phase === 'ended' ? { reason: hp === 0 ? 'knockout' : 'left', winner: hp === 0 ? 'challenger' : null } : null,
  };
}

function fakeChannel(initial: ArenaRingSnapshot | null = ring(), self: GameId | null = SELF) {
  let current: unknown = initial;
  const listeners = new Set<(ring: ArenaRingSnapshot | null) => void>();
  const strikes = new Set<() => void>();
  const channel = {
    ring: () => current as ArenaRingSnapshot | null,
    subscribe(listener: (ring: ArenaRingSnapshot | null) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    selfId: () => self,
    claim: vi.fn(),
    attack: vi.fn(),
    leave: vi.fn(),
    subscribeStrikes(listener: () => void) {
      strikes.add(listener);
      return () => strikes.delete(listener);
    },
  } satisfies ArenaChannel;
  return {
    channel,
    push(next: unknown) {
      current = next;
      for (const listener of [...listeners]) listener(next as ArenaRingSnapshot | null);
    },
    strike() {
      for (const listener of [...strikes]) listener();
    },
    listenerCount: () => listeners.size + strikes.size,
  };
}

function fakeHost(at: { x: number; y: number; facing?: Facing } = APPROACH) {
  const state = { x: at.x, y: at.y, facing: at.facing ?? ('up' as Facing), reduced: false, suspended: false };
  const host = {
    position: () => ({ x: state.x, y: state.y, facing: state.facing }),
    leapTo: vi.fn((tile: { x: number; y: number }, facing: Facing) => {
      const centre = arenaTileCentre(tile);
      state.x = centre.x;
      state.y = centre.y;
      state.facing = facing;
    }),
    setPrompt: vi.fn(),
    playLocalSwing: vi.fn(),
    setOutfitLocked: vi.fn(),
    selectLook: vi.fn(),
    reducedMotion: () => state.reduced,
    inputSuspended: () => state.suspended,
  } satisfies ArenaSessionHost;
  return { host, state };
}

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function lastPrompt(host: { setPrompt: ReturnType<typeof vi.fn> }): unknown {
  return host.setPrompt.mock.calls.at(-1)?.[0] ?? null;
}

describe('arena session: the gate', () => {
  it('shows E · ENTER THE RING only on the approach while the ring is idle', () => {
    const { channel } = fakeChannel(ring());
    const { host, state } = fakeHost(APPROACH);
    const session = createArenaSession(channel, host);
    session.update(16);
    expect(lastPrompt(host)).toBe(ARENA_CLAIM_PROMPT);
    state.x = SAND.x;
    state.y = SAND.y;
    session.update(16);
    expect(lastPrompt(host)).toBeNull();
  });

  it('shows IN USE while someone else holds the ring, and E sends nothing', () => {
    const { channel } = fakeChannel(ring({ phase: 'fighting', round: 3, challenger: OTHER }));
    const { host } = fakeHost(APPROACH);
    const session = createArenaSession(channel, host);
    session.update(16);
    expect(lastPrompt(host)).toBe(ARENA_BUSY_PROMPT);
    expect(session.onInteract()).toBe(false);
    expect(session.onPrimary()).toBe(false);
    expect(channel.claim).not.toHaveBeenCalled();
    expect(channel.attack).not.toHaveBeenCalled();
    expect(session.frame()?.gate).toBe('busy');
  });

  it('shows nothing and claims nothing without a ring (not live in the arena)', () => {
    const { channel } = fakeChannel(null);
    const { host } = fakeHost(APPROACH);
    const session = createArenaSession(channel, host);
    session.update(16);
    expect(host.setPrompt).not.toHaveBeenCalled();
    expect(session.onInteract()).toBe(false);
    expect(channel.claim).not.toHaveBeenCalled();
    expect(session.frame()).toBeNull();
  });

  it('claims with E from the approach, held to the 1000 ms client floor', () => {
    const time = clock();
    const { channel } = fakeChannel(ring());
    const { host } = fakeHost(APPROACH);
    const session = createArenaSession(channel, host, { now: time.now });
    expect(session.onInteract()).toBe(true);
    time.advance(999);
    session.onInteract();
    expect(channel.claim).toHaveBeenCalledTimes(1);
    time.advance(1);
    session.onInteract();
    expect(channel.claim).toHaveBeenCalledTimes(2);
  });

  it('claims nothing off the approach, and never by click', () => {
    const { channel } = fakeChannel(ring());
    const { host } = fakeHost(SAND);
    const session = createArenaSession(channel, host);
    expect(session.onInteract()).toBe(false);
    expect(session.onPrimary()).toBe(false);
    expect(channel.claim).not.toHaveBeenCalled();
  });

  it('uses the lobby’s 8 px slack round the approach', () => {
    const left = 64 + 19 * 32;
    const top = 64 + 21 * 32;
    expect(onArenaGateApproach(left - 8, top)).toBe(true);
    expect(onArenaGateApproach(left - 9, top)).toBe(false);
    expect(onArenaGateApproach(left, top - 8)).toBe(true);
    expect(onArenaGateApproach(left, top - 9)).toBe(false);
    expect(onArenaGateApproach(Number.NaN, top)).toBe(false);
  });
});

describe('arena session: into the ring and out', () => {
  it('leaps to the ring spawn on a new round as challenger, then puts on the fighting look after landing', () => {
    const time = clock();
    const fake = fakeChannel(ring());
    const { host } = fakeHost(APPROACH);
    const session = createArenaSession(fake.channel, host, { now: time.now });
    fake.push(ring({ phase: 'countdown', round: 1, challenger: SELF }));
    expect(host.leapTo).toHaveBeenCalledWith(ARENA_RING_SPAWN, 'up');
    expect(host.setOutfitLocked).toHaveBeenLastCalledWith(true);
    session.update(16);
    expect(host.selectLook).not.toHaveBeenCalled();
    time.advance(JUMP_TOTAL_MS);
    session.update(16);
    expect(host.selectLook).toHaveBeenCalledWith('fighting');
    expect(session.frame()?.selfIsChallenger).toBe(true);
    // The same round again is not a second leap.
    fake.push(ring({ phase: 'fighting', round: 1, challenger: SELF }));
    expect(host.leapTo).toHaveBeenCalledTimes(1);
  });

  it('leaps out to the return tile when its round goes back to idle, and restores the look', () => {
    const time = clock();
    const fake = fakeChannel(ring());
    const { host } = fakeHost(APPROACH);
    const session = createArenaSession(fake.channel, host, { now: time.now });
    fake.push(ring({ phase: 'countdown', round: 1, challenger: SELF }));
    time.advance(JUMP_TOTAL_MS);
    session.update(16);
    fake.push(ring({ phase: 'ended', round: 1, challenger: SELF, hp: 0, hits: 10 }));
    expect(host.leapTo).toHaveBeenCalledTimes(1);
    fake.push(ring({ phase: 'idle', round: 1 }));
    expect(host.leapTo).toHaveBeenLastCalledWith(ARENA_RING_RETURN, 'down');
    expect(host.setOutfitLocked).toHaveBeenLastCalledWith(false);
    session.update(16);
    expect(host.selectLook).not.toHaveBeenCalledWith('restore');
    time.advance(JUMP_TOTAL_MS);
    session.update(16);
    expect(host.selectLook).toHaveBeenLastCalledWith('restore');
  });

  it('locks F only while in the ring', () => {
    const fake = fakeChannel(ring());
    const { host } = fakeHost(APPROACH);
    createArenaSession(fake.channel, host);
    fake.push(ring({ phase: 'countdown', round: 4, challenger: SELF }));
    fake.push(ring({ phase: 'fighting', round: 4, challenger: SELF }));
    expect(host.setOutfitLocked.mock.calls).toEqual([[true]]);
    fake.push(ring({ phase: 'idle', round: 4 }));
    expect(host.setOutfitLocked.mock.calls).toEqual([[true], [false]]);
  });

  it('under reduced motion switches the look at once: the leap is a cut', () => {
    const time = clock();
    const fake = fakeChannel(ring());
    const { host, state } = fakeHost(APPROACH);
    state.reduced = true;
    const session = createArenaSession(fake.channel, host, { now: time.now });
    fake.push(ring({ phase: 'countdown', round: 2, challenger: SELF }));
    session.update(0);
    expect(host.selectLook).toHaveBeenCalledWith('fighting');
    fake.push(ring({ phase: 'idle', round: 2 }));
    session.update(0);
    expect(host.selectLook).toHaveBeenLastCalledWith('restore');
  });

  it('gets out of the ring when the ring vanishes (left the arena, or the connection dropped)', () => {
    const fake = fakeChannel(ring());
    const { host } = fakeHost(APPROACH);
    const session = createArenaSession(fake.channel, host);
    fake.push(ring({ phase: 'fighting', round: 1, challenger: SELF }));
    fake.push(null);
    expect(host.leapTo).toHaveBeenLastCalledWith(ARENA_RING_RETURN, 'down');
    expect(session.isRingTileWalkable(20, 18)).toBe(false);
  });

  it('a late join to its own fight still leaps in (the round is new to this client)', () => {
    const fake = fakeChannel(ring({ phase: 'fighting', round: 9, challenger: SELF, swings: 5 }));
    const { host } = fakeHost(SPAWN);
    createArenaSession(fake.channel, host);
    expect(host.leapTo).toHaveBeenCalledWith(ARENA_RING_SPAWN, 'up');
    // The counter seen on joining is a baseline, not five swings.
    expect(host.playLocalSwing).not.toHaveBeenCalled();
  });

  it('the ring interior is walkable only for this client while it is the challenger, never the dummy', () => {
    const fake = fakeChannel(ring());
    const { host } = fakeHost(APPROACH);
    const session = createArenaSession(fake.channel, host);
    expect(session.isRingTileWalkable(20, 18)).toBe(false);
    fake.push(ring({ phase: 'fighting', round: 1, challenger: OTHER }));
    expect(session.isRingTileWalkable(20, 18)).toBe(false);
    fake.push(ring({ phase: 'fighting', round: 2, challenger: SELF }));
    expect(session.isRingTileWalkable(20, 18)).toBe(true);
    expect(session.isRingTileWalkable(16, 13)).toBe(true);
    expect(session.isRingTileWalkable(20, 14)).toBe(false); // the dummy
    expect(session.isRingTileWalkable(15, 13)).toBe(false); // the fence
    expect(session.isRingTileWalkable(20, 20)).toBe(false); // the gate
  });
});

describe('arena session: attacks', () => {
  function inFight(phase: ArenaPhase = 'fighting', start = 1_000) {
    const time = clock(start);
    const fake = fakeChannel(ring());
    const { host, state } = fakeHost(APPROACH);
    const session = createArenaSession(fake.channel, host, { now: time.now });
    fake.push(ring({ phase: 'countdown', round: 1, challenger: SELF }));
    if (phase !== 'countdown') fake.push(ring({ phase, round: 1, challenger: SELF }));
    return { time, fake, host, state, session };
  }

  it('E and a click attack only while fighting, with the local swing played at once', () => {
    const { fake, host, session, time } = inFight();
    expect(session.onInteract()).toBe(true);
    expect(fake.channel.attack).toHaveBeenCalledTimes(1);
    expect(host.playLocalSwing).toHaveBeenCalledTimes(1);
    time.advance(450);
    expect(session.onPrimary()).toBe(true);
    expect(fake.channel.attack).toHaveBeenCalledTimes(2);
  });

  it('drops a repeat inside the 450 ms client floor, never queues it', () => {
    const { fake, session, time } = inFight();
    session.onInteract();
    time.advance(449);
    session.onPrimary();
    session.onInteract();
    expect(fake.channel.attack).toHaveBeenCalledTimes(1);
    time.advance(1);
    session.onPrimary();
    expect(fake.channel.attack).toHaveBeenCalledTimes(2);
  });

  it('sends no attack in the countdown or once the fight has ended', () => {
    const counting = inFight('countdown');
    expect(counting.session.onInteract()).toBe(false);
    expect(counting.session.onPrimary()).toBe(false);
    expect(counting.fake.channel.attack).not.toHaveBeenCalled();
    const ended = inFight('ended');
    expect(ended.session.onPrimary()).toBe(false);
    expect(ended.fake.channel.attack).not.toHaveBeenCalled();
  });

  it('outside a fight E never attacks, even standing next to the dummy', () => {
    const fake = fakeChannel(ring({ phase: 'fighting', round: 1, challenger: OTHER }));
    const { host } = fakeHost(NEXT_TO_DUMMY);
    const session = createArenaSession(fake.channel, host);
    expect(session.onInteract()).toBe(false);
    expect(session.onPrimary()).toBe(false);
    expect(fake.channel.attack).not.toHaveBeenCalled();
  });

  it('sends nothing while a panel owns the keyboard', () => {
    const { fake, session, state, host } = inFight();
    state.suspended = true;
    expect(session.onInteract()).toBe(false);
    expect(session.onPrimary()).toBe(false);
    fake.strike();
    expect(fake.channel.attack).not.toHaveBeenCalled();
    expect(host.playLocalSwing).not.toHaveBeenCalled();
  });

  it('the HUD STRIKE takes the click path: floor and local swing included', () => {
    const { fake, host, time } = inFight();
    fake.strike();
    fake.strike();
    expect(fake.channel.attack).toHaveBeenCalledTimes(1);
    expect(host.playLocalSwing).toHaveBeenCalledTimes(1);
    time.advance(450);
    fake.strike();
    expect(fake.channel.attack).toHaveBeenCalledTimes(2);
  });

  it('shows E · STRIKE only while fighting with the dummy in reach and arc', () => {
    const { session, state, host } = inFight();
    state.x = NEXT_TO_DUMMY.x;
    state.y = NEXT_TO_DUMMY.y;
    state.facing = 'up';
    session.update(16);
    expect(lastPrompt(host)).toBe(ARENA_STRIKE_PROMPT);
    state.facing = 'down';
    session.update(16);
    expect(lastPrompt(host)).toBeNull();
  });

  it('the reach rule mirrors the lobby: 32 and 45 px hit, 53 px misses, point-blank always', () => {
    const dummy = arenaTileCentre({ x: 20, y: 14 });
    expect(dummyWithinReach(dummy.x, dummy.y + 32, 'up')).toBe(true);
    expect(dummyWithinReach(dummy.x + 32, dummy.y + 32, 'up')).toBe(true);
    expect(dummyWithinReach(dummy.x, dummy.y + 53, 'up')).toBe(false);
    expect(dummyWithinReach(dummy.x, dummy.y + 32, 'down')).toBe(false);
    expect(dummyWithinReach(dummy.x, dummy.y + 10, 'down')).toBe(true);
  });
});

describe('arena session: the swing echo', () => {
  it('skips the server’s echo of a swing it predicted within 400 ms', () => {
    const time = clock();
    const fake = fakeChannel(ring());
    const { host } = fakeHost(APPROACH);
    const session = createArenaSession(fake.channel, host, { now: time.now });
    fake.push(ring({ phase: 'fighting', round: 1, challenger: SELF, swings: 0 }));
    session.onPrimary();
    expect(host.playLocalSwing).toHaveBeenCalledTimes(1);
    time.advance(120);
    fake.push(ring({ phase: 'fighting', round: 1, challenger: SELF, swings: 1 }));
    expect(host.playLocalSwing).toHaveBeenCalledTimes(1);
  });

  it('plays a swing the server counted that this client did not predict', () => {
    const time = clock();
    const fake = fakeChannel(ring());
    const { host } = fakeHost(APPROACH);
    createArenaSession(fake.channel, host, { now: time.now });
    fake.push(ring({ phase: 'fighting', round: 1, challenger: SELF, swings: 0 }));
    fake.push(ring({ phase: 'fighting', round: 1, challenger: SELF, swings: 1 }));
    expect(host.playLocalSwing).toHaveBeenCalledTimes(1);
  });

  it('an echo after 400 ms is a new swing', () => {
    const time = clock();
    const fake = fakeChannel(ring());
    const { host } = fakeHost(APPROACH);
    const session = createArenaSession(fake.channel, host, { now: time.now });
    fake.push(ring({ phase: 'fighting', round: 1, challenger: SELF }));
    session.onPrimary();
    time.advance(401);
    fake.push(ring({ phase: 'fighting', round: 1, challenger: SELF, swings: 1 }));
    expect(host.playLocalSwing).toHaveBeenCalledTimes(2);
  });
});

describe('arena session: the frame is the server’s counters', () => {
  it('maps the snapshot without guessing: hp, hits and down come from state', () => {
    const fake = fakeChannel(ring({ phase: 'fighting', round: 1, challenger: OTHER, hp: 70, hits: 3, swings: 4 }));
    const { host } = fakeHost(SAND);
    const session = createArenaSession(fake.channel, host);
    expect(session.frame()).toEqual({
      phase: 'fighting',
      gate: 'busy',
      dummy: { hp: 70, maxHp: ARENA_MAX_HP, hits: 3, down: false },
      challengerId: OTHER,
      challengerSwings: 4,
      selfIsChallenger: false,
    });
    // Attacking locally changes nothing in the frame: only a new snapshot does.
    fake.push(ring({ phase: 'ended', round: 1, challenger: OTHER, hp: 0, hits: 10 }));
    expect(session.frame()?.dummy).toEqual({ hp: 0, maxHp: ARENA_MAX_HP, hits: 10, down: true });
  });

  it('refuses a malformed snapshot: no frame, no prompt, no claim', () => {
    const fake = fakeChannel(ring());
    const { host } = fakeHost(APPROACH);
    const session = createArenaSession(fake.channel, host);
    fake.push({ phase: 'fighting', round: -1 });
    expect(session.frame()).toBeNull();
    expect(session.onInteract()).toBe(false);
    expect(fake.channel.claim).not.toHaveBeenCalled();
  });

  it('destroy unsubscribes, clears the prompt and hands F back', () => {
    const time = clock();
    const fake = fakeChannel(ring());
    const { host } = fakeHost(APPROACH);
    const session = createArenaSession(fake.channel, host, { now: time.now });
    fake.push(ring({ phase: 'fighting', round: 1, challenger: SELF }));
    time.advance(JUMP_TOTAL_MS);
    session.update(16);
    session.destroy();
    expect(fake.listenerCount()).toBe(0);
    expect(host.setOutfitLocked).toHaveBeenLastCalledWith(false);
    expect(host.selectLook).toHaveBeenLastCalledWith('restore');
    expect(session.frame()).toBeNull();
    expect(session.onPrimary()).toBe(false);
  });
});
