import { describe, expect, it, vi } from 'vitest';
import {
  ARENA_BLOCK_CLIENT_INTERVAL_MS,
  ARENA_BOX_STAND,
  ARENA_DUMMY_TILE,
  ARENA_INTENT_CLIENT_INTERVAL_MS,
  ARENA_MAX_HP,
  ARENA_RING_RETURN,
  ARENA_RING_RETURN_FACING,
  ARENA_RING_SPAWN,
  ARENA_RING_SPAWN_FACING,
  arenaTileCentre,
  type ArenaPhase,
  type ArenaRingSnapshot,
  type Facing,
  type GameId,
} from '@strkworld/shared';
import type { ArenaChannel, ArenaGateTarget, ArenaSession, ArenaSessionHost } from './arena-channel.js';
import {
  ARENA_BOX_CLOSED_LABEL,
  ARENA_BOX_TARGET_ID,
  ARENA_BUSY_LABEL,
  ARENA_BUSY_PROMPT,
  ARENA_CLAIM_LABEL,
  ARENA_CLAIM_PROMPT,
  ARENA_GATE_RECT,
  ARENA_SIT_LABEL,
  ARENA_STAND_LABEL,
  ARENA_STRIKE_PROMPT,
  createArenaSession,
  dummyWithinReach,
  onArenaGateApproach,
} from './arena-session.js';
import { JUMP_TOTAL_MS } from './jump.js';

const SELF = 'g-self' as GameId;
const OTHER = 'g-other' as GameId;
/** On the gate approach: the column of sand against the ring's west gate. */
const APPROACH = arenaTileCentre({ x: 14, y: 16 });
const SAND = arenaTileCentre({ x: 10, y: 16 });
const SPAWN = arenaTileCentre(ARENA_RING_SPAWN);
/** One tile west of the dummy (the gate side), facing it. */
const NEXT_TO_DUMMY = arenaTileCentre({ x: 20, y: 16 });

interface RingInit {
  phase?: ArenaPhase;
  round?: number;
  challenger?: GameId | null;
  hp?: number;
  swings?: number;
  hits?: number;
  /** D-128. */
  guarding?: boolean;
  blocks?: number;
  champion?: GameId | null;
  seated?: boolean;
}

const EMPTY_SLOT = { kind: 'empty', gameId: null, hp: 0, swings: 0, hits: 0, guarding: false, blocks: 0 } as const;

function ring({
  phase = 'idle',
  round = 0,
  challenger = null,
  hp = ARENA_MAX_HP,
  swings = 0,
  hits = 0,
  guarding = false,
  blocks = 0,
  champion = null,
  seated = false,
}: RingInit = {}): ArenaRingSnapshot {
  const busy = phase !== 'idle';
  return {
    phase,
    round,
    challenger: busy && challenger
      ? { kind: 'player', gameId: challenger, hp: ARENA_MAX_HP, swings, hits: 0, guarding, blocks }
      : EMPTY_SLOT,
    opponent: busy ? { kind: 'dummy', gameId: null, hp, swings: 0, hits, guarding: false, blocks: 0 } : EMPTY_SLOT,
    secondsLeft: phase === 'countdown' ? 3 : phase === 'fighting' ? 90 : 0,
    outcome: phase === 'ended' ? { reason: hp === 0 ? 'knockout' : 'left', winner: hp === 0 ? 'challenger' : null } : null,
    champion,
    seated: champion !== null && seated,
  };
}

function fakeChannel(initial: ArenaRingSnapshot | null = ring(), self: GameId | null = SELF) {
  let current: unknown = initial;
  const listeners = new Set<(ring: ArenaRingSnapshot | null) => void>();
  const strikes = new Set<() => void>();
  const blocks = new Set<(down: boolean) => void>();
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
    // D-128: the block's two intents and the box's press.
    block: vi.fn(),
    sit: vi.fn(),
    subscribeBlocks(listener: (down: boolean) => void) {
      blocks.add(listener);
      return () => blocks.delete(listener);
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
    /** D-128: the HUD's touch BLOCK button, as the World routes it. */
    touchBlock(down: boolean) {
      for (const listener of [...blocks]) listener(down);
    },
    listenerCount: () => listeners.size + strikes.size + blocks.size,
  };
}

function fakeHost(at: { x: number; y: number; facing?: Facing } = APPROACH) {
  const state = { x: at.x, y: at.y, facing: at.facing ?? ('right' as Facing), reduced: false, suspended: false, throned: false };
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
    // D-128, amended 2026-10-03: the World seats and unseats the avatar.
    setThroned: vi.fn((seated: boolean) => {
      state.throned = seated;
    }),
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
    const left = 64 + 13 * 32;
    const top = 64 + 15 * 32;
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
    expect(host.leapTo).toHaveBeenCalledWith(ARENA_RING_SPAWN, ARENA_RING_SPAWN_FACING);
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
    expect(host.leapTo).toHaveBeenLastCalledWith(ARENA_RING_RETURN, ARENA_RING_RETURN_FACING);
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
    expect(host.leapTo).toHaveBeenLastCalledWith(ARENA_RING_RETURN, ARENA_RING_RETURN_FACING);
    expect(session.isRingTileWalkable(20, 18)).toBe(false);
  });

  it('a late join to its own fight still leaps in (the round is new to this client)', () => {
    const fake = fakeChannel(ring({ phase: 'fighting', round: 9, challenger: SELF, swings: 5 }));
    const { host } = fakeHost(SPAWN);
    createArenaSession(fake.channel, host);
    expect(host.leapTo).toHaveBeenCalledWith(ARENA_RING_SPAWN, ARENA_RING_SPAWN_FACING);
    // The counter seen on joining is a baseline, not five swings.
    expect(host.playLocalSwing).not.toHaveBeenCalled();
  });

  it('the ring interior is walkable only for this client while it is the challenger, never the dummy', () => {
    const fake = fakeChannel(ring());
    const { host } = fakeHost(APPROACH);
    const session = createArenaSession(fake.channel, host);
    expect(session.isRingTileWalkable(17, 16)).toBe(false);
    fake.push(ring({ phase: 'fighting', round: 1, challenger: OTHER }));
    expect(session.isRingTileWalkable(17, 16)).toBe(false);
    fake.push(ring({ phase: 'fighting', round: 2, challenger: SELF }));
    expect(session.isRingTileWalkable(17, 16)).toBe(true);
    expect(session.isRingTileWalkable(24, 19)).toBe(true);
    expect(session.isRingTileWalkable(21, 16)).toBe(false); // the dummy
    expect(session.isRingTileWalkable(25, 19)).toBe(false); // the fence
    expect(session.isRingTileWalkable(15, 16)).toBe(false); // the gate
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
    state.facing = 'right';
    session.update(16);
    expect(lastPrompt(host)).toBe(ARENA_STRIKE_PROMPT);
    state.facing = 'left';
    session.update(16);
    expect(lastPrompt(host)).toBeNull();
  });

  it('the reach rule mirrors the lobby: 32 and 45 px hit, 53 px misses, point-blank always', () => {
    const dummy = arenaTileCentre(ARENA_DUMMY_TILE);
    expect(dummyWithinReach(dummy.x - 32, dummy.y, 'right')).toBe(true);
    expect(dummyWithinReach(dummy.x - 32, dummy.y + 32, 'right')).toBe(true);
    expect(dummyWithinReach(dummy.x - 53, dummy.y, 'right')).toBe(false);
    expect(dummyWithinReach(dummy.x - 32, dummy.y, 'left')).toBe(false);
    expect(dummyWithinReach(dummy.x - 10, dummy.y, 'left')).toBe(true);
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
      // D-128: no guard, no champion and no throne in this snapshot.
      challengerGuarding: false,
      challengerBlocks: 0,
      championId: null,
      throneId: null,
      selfIsChampion: false,
      selfOnThrone: false,
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

describe('arena session: the press-E system (D-117)', () => {
  function withInteractions(initial: ArenaRingSnapshot | null, at = APPROACH) {
    const time = clock();
    const fake = fakeChannel(initial);
    const { host, state } = fakeHost(at);
    const holds: string[] = [];
    const released = vi.fn();
    const suspendInteractions = vi.fn((reason: string) => {
      holds.push(reason);
      return released;
    });
    const session = createArenaSession(fake.channel, { ...host, suspendInteractions }, { now: time.now });
    return { time, fake, host, state, session, holds, released, suspendInteractions };
  }

  it('offers the gate as one CLAIM target on the approach while idle; activating it claims', () => {
    const { session, fake } = withInteractions(ring());
    const targets = session.gateTargets!();
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ id: 'arena:gate', label: ARENA_CLAIM_LABEL, rect: ARENA_GATE_RECT });
    // The footprint is the three gate tiles, World pixels with the room origin.
    expect(ARENA_GATE_RECT).toEqual({ x: 64 + 15 * 32, y: 64 + 15 * 32, width: 32, height: 96 });
    targets[0]!.activate();
    expect(fake.channel.claim).toHaveBeenCalledTimes(1);
  });

  it('IN USE while busy takes the press and sends nothing; no target off the approach', () => {
    const busy = withInteractions(ring({ phase: 'fighting', round: 1, challenger: OTHER }));
    const targets = busy.session.gateTargets!();
    expect(targets.map((t) => t.label)).toEqual([ARENA_BUSY_LABEL]);
    targets[0]!.activate();
    expect(busy.fake.channel.claim).not.toHaveBeenCalled();
    const away = withInteractions(ring(), SAND);
    expect(away.session.gateTargets!()).toEqual([]);
  });

  it('hands the gate’s mesh to its target, for the cues to glow', () => {
    const fake = fakeChannel(ring());
    const { host } = fakeHost(APPROACH);
    const gate = { name: 'arena:gate' };
    const session = createArenaSession(fake.channel, { ...host, suspendInteractions: () => () => {}, gateObject: () => gate });
    const [target] = session.gateTargets!();
    expect(target).toMatchObject({ label: ARENA_CLAIM_LABEL, object: gate });
    target!.activate();
    expect(fake.channel.claim).toHaveBeenCalledTimes(1);
  });

  it('draws no gate prompt of its own when the interaction system draws it', () => {
    const { session, host } = withInteractions(ring());
    session.update(16);
    expect(host.setPrompt).not.toHaveBeenCalled();
  });

  it('holds the combat yield from the new round until the ring is idle, and E attacks through onAttack', () => {
    const { session, fake, holds, released, time } = withInteractions(ring());
    fake.push(ring({ phase: 'countdown', round: 1, challenger: SELF }));
    expect(holds).toEqual(['combat']);
    expect(session.gateTargets!()).toEqual([]);
    expect(session.onAttack!()).toBe(false); // the countdown
    fake.push(ring({ phase: 'fighting', round: 1, challenger: SELF }));
    expect(session.onAttack!()).toBe(true);
    expect(fake.channel.attack).toHaveBeenCalledTimes(1);
    time.advance(100);
    session.onAttack!();
    expect(fake.channel.attack).toHaveBeenCalledTimes(1); // the client floor
    fake.push(ring({ phase: 'idle', round: 1 }));
    expect(released).toHaveBeenCalledTimes(1);
    expect(session.onAttack!()).toBe(false);
  });

  it('a spectator’s E never attacks through the action', () => {
    const { session, fake } = withInteractions(ring({ phase: 'fighting', round: 1, challenger: OTHER }), NEXT_TO_DUMMY);
    expect(session.onAttack!()).toBe(false);
    expect(fake.channel.attack).not.toHaveBeenCalled();
  });

  it('destroy releases the yield', () => {
    const { session, fake, released } = withInteractions(ring());
    fake.push(ring({ phase: 'fighting', round: 1, challenger: SELF }));
    session.destroy();
    expect(released).toHaveBeenCalledTimes(1);
  });
});

describe('arena session on the real press-E system (D-117)', () => {
  it('E claims at the gate through the system, then attacks through the action while the yield holds', async () => {
    const { createInteractionSystem } = await import('./interaction.js');
    const time = clock();
    const fake = fakeChannel(ring());
    const { host, state } = fakeHost(APPROACH);
    const prompts: Array<string | null> = [];
    const interactions = createInteractionSystem({ onPrompt: (prompt) => prompts.push(prompt?.label ?? null) });
    const session = createArenaSession(
      fake.channel,
      { ...host, suspendInteractions: (reason: string) => interactions.suspend(reason) },
      { now: time.now },
    );
    interactions.register({ targets: () => session.gateTargets!() });
    interactions.addAction({ id: 'arena', priority: 10, run: () => session.onAttack!() });
    const player = () => ({ position: { x: state.x, y: state.y }, heading: { x: 1, y: 0 } });
    interactions.update(player());
    expect(prompts.at(-1)).toBe(ARENA_CLAIM_LABEL);
    expect(interactions.interact()).toBe(true);
    expect(fake.channel.claim).toHaveBeenCalledTimes(1);
    // The server's new round: the session leaps in and holds the yield.
    fake.push(ring({ phase: 'fighting', round: 1, challenger: SELF }));
    expect(interactions.suspended).toBe(true);
    interactions.update(player());
    expect(interactions.focused).toBeNull();
    expect(interactions.interact()).toBe(true);
    expect(fake.channel.attack).toHaveBeenCalledTimes(1);
    // Back to idle: the yield is released and a spectator's E is the gate's again.
    fake.push(ring({ phase: 'idle', round: 1 }));
    expect(interactions.suspended).toBe(false);
    session.destroy();
    interactions.destroy();
  });
});

describe('arena session: one attack path', () => {
  it('E, a click and STRIKE share one floor: three inputs in one instant send one attack', () => {
    const time = clock();
    const fake = fakeChannel(ring());
    const { host } = fakeHost(APPROACH);
    const session = createArenaSession(fake.channel, { ...host, suspendInteractions: () => () => {} }, { now: time.now });
    fake.push(ring({ phase: 'fighting', round: 1, challenger: SELF }));
    expect(session.onAttack!()).toBe(true);
    session.onPrimary();
    fake.strike();
    expect(fake.channel.attack).toHaveBeenCalledTimes(1);
    expect(host.playLocalSwing).toHaveBeenCalledTimes(1);
  });
});

describe('arena session: the block (D-128)', () => {
  /** A session whose client is the fighter in the ring, mid-fight. */
  function fighting(at = NEXT_TO_DUMMY) {
    const time = clock();
    const fake = fakeChannel(ring());
    const { host, state } = fakeHost(at);
    const session = createArenaSession(fake.channel, { ...host, suspendInteractions: () => () => {} }, { now: time.now });
    fake.push(ring({ phase: 'fighting', round: 1, challenger: SELF }));
    return { time, fake, host, state, session };
  }

  it('sends a start on Q down and a release on Q up', () => {
    const { fake, session } = fighting();
    expect(session.onBlock!(true)).toBe(true);
    expect(fake.channel.block).toHaveBeenCalledWith(true);
    expect(session.onBlock!(false)).toBe(true);
    expect(fake.channel.block).toHaveBeenLastCalledWith(false);
    expect(fake.channel.block).toHaveBeenCalledTimes(2);
  });

  it('holds a start to the 500 ms client floor, and never sends a release it does not owe', () => {
    const { time, fake, session } = fighting();
    // Nothing is raised, so there is nothing to release.
    expect(session.onBlock!(false)).toBe(false);
    expect(fake.channel.block).not.toHaveBeenCalled();
    session.onBlock!(true);
    session.onBlock!(false);
    expect(fake.channel.block).toHaveBeenCalledTimes(2);
    // Inside the floor the next start is swallowed, not queued.
    session.onBlock!(true);
    expect(fake.channel.block).toHaveBeenCalledTimes(2);
    time.advance(ARENA_BLOCK_CLIENT_INTERVAL_MS);
    session.onBlock!(true);
    expect(fake.channel.block).toHaveBeenCalledTimes(3);
    expect(fake.channel.block).toHaveBeenLastCalledWith(true);
  });

  it('refuses Q outside a fight: idle, a countdown, as a spectator and with no ring', () => {
    const idle = fighting();
    idle.fake.push(ring({ phase: 'idle', round: 1 }));
    expect(idle.session.onBlock!(true)).toBe(false);

    const counting = fighting();
    counting.fake.push(ring({ phase: 'countdown', round: 2, challenger: SELF }));
    expect(counting.session.onBlock!(true)).toBe(false);

    const watching = fighting();
    watching.fake.push(ring({ phase: 'fighting', round: 2, challenger: OTHER }));
    expect(watching.session.onBlock!(true)).toBe(false);

    const gone = fighting();
    gone.fake.push(null);
    expect(gone.session.onBlock!(true)).toBe(false);

    for (const each of [idle, counting, watching, gone]) {
      expect(each.fake.channel.block).not.toHaveBeenCalledWith(true);
    }
  });

  it('refuses Q while the World’s input is suspended (a panel or a text field has it)', () => {
    const { fake, state, session } = fighting();
    state.suspended = true;
    expect(session.onBlock!(true)).toBe(false);
    expect(fake.channel.block).not.toHaveBeenCalled();
    // The release still goes if one were ever owed: a guard must never stick.
    state.suspended = false;
    session.onBlock!(true);
    state.suspended = true;
    expect(session.onBlock!(false)).toBe(true);
    expect(fake.channel.block).toHaveBeenLastCalledWith(false);
  });

  it('lowers a raised guard on the way out of the ring and on destroy', () => {
    const left = fighting();
    left.session.onBlock!(true);
    // The ring resets: this client no longer holds the challenger slot.
    left.fake.push(ring({ phase: 'idle', round: 1 }));
    expect(left.fake.channel.block).toHaveBeenLastCalledWith(false);

    const killed = fighting();
    killed.session.onBlock!(true);
    killed.fake.channel.block.mockClear();
    killed.session.destroy();
    expect(killed.fake.channel.block).toHaveBeenCalledWith(false);
  });

  it('routes the HUD’s touch BLOCK button through the same gates and floor as Q', () => {
    const { fake, session } = fighting();
    fake.touchBlock(true);
    expect(fake.channel.block).toHaveBeenCalledWith(true);
    fake.touchBlock(false);
    expect(fake.channel.block).toHaveBeenLastCalledWith(false);
    // Off the fight it sends nothing, exactly as Q does.
    fake.push(ring({ phase: 'idle', round: 1 }));
    fake.channel.block.mockClear();
    fake.touchBlock(true);
    expect(fake.channel.block).not.toHaveBeenCalled();
    session.destroy();
  });

  it('draws the stance from the server’s guarding, never from the local press', () => {
    const { fake, session } = fighting();
    session.onBlock!(true);
    // The intent is out, but nothing is predicted: the frame still says no guard.
    expect(session.frame()?.challengerGuarding).toBe(false);
    fake.push(ring({ phase: 'fighting', round: 1, challenger: SELF, guarding: true, blocks: 3 }));
    expect(session.frame()?.challengerGuarding).toBe(true);
    expect(session.frame()?.challengerBlocks).toBe(3);
  });

  it('a spectator reads the fighter’s guard from the same frame', () => {
    const fake = fakeChannel(ring());
    const { host } = fakeHost(SAND);
    const session = createArenaSession(fake.channel, host);
    fake.push(ring({ phase: 'fighting', round: 1, challenger: OTHER, guarding: true, blocks: 2 }));
    expect(session.frame()).toMatchObject({
      selfIsChallenger: false,
      challengerId: OTHER,
      challengerGuarding: true,
      challengerBlocks: 2,
    });
  });
});

describe('arena session: the emperor’s box (D-128)', () => {
  const BOX = arenaTileCentre(ARENA_BOX_STAND);

  function atBox(self: GameId | null = SELF) {
    const fake = fakeChannel(ring(), self);
    const { host } = fakeHost(BOX);
    const session = createArenaSession(fake.channel, host);
    return { fake, host, session };
  }

  /** The box as the interaction system sees it: press-E runs the target's own `activate`. */
  const boxTarget = (session: ArenaSession): ArenaGateTarget | null =>
    session.gateTargets?.().find((target) => target.id === ARENA_BOX_TARGET_ID) ?? null;

  it('offers the throne to the champion, and sits them with E', () => {
    const { fake, session } = atBox();
    fake.push(ring({ phase: 'idle', round: 1, champion: SELF }));
    expect(boxTarget(session)?.label).toBe(ARENA_SIT_LABEL);
    expect(boxTarget(session)?.activate()).toBe(true);
    expect(fake.channel.sit).toHaveBeenCalledTimes(1);
  });

  it('offers STAND once seated, which sends the same intent', () => {
    const { fake, session } = atBox();
    fake.push(ring({ phase: 'idle', round: 1, champion: SELF, seated: true }));
    expect(boxTarget(session)?.label).toBe(ARENA_STAND_LABEL);
    expect(session.frame()?.selfOnThrone).toBe(true);
    expect(boxTarget(session)?.activate()).toBe(true);
    expect(fake.channel.sit).toHaveBeenCalledTimes(1);
  });

  it('shows everyone else CHAMPION ONLY, and their E sends nothing', () => {
    const { fake, session } = atBox();
    fake.push(ring({ phase: 'idle', round: 1, champion: OTHER }));
    expect(boxTarget(session)?.label).toBe(ARENA_BOX_CLOSED_LABEL);
    expect(session.frame()?.selfIsChampion).toBe(false);
    expect(boxTarget(session)?.activate()).toBe(false);
    expect(fake.channel.sit).not.toHaveBeenCalled();
  });

  it('shows CHAMPION ONLY while nobody has won yet', () => {
    const { fake, session } = atBox();
    fake.push(ring({ phase: 'idle', round: 1 }));
    expect(boxTarget(session)?.label).toBe(ARENA_BOX_CLOSED_LABEL);
    expect(boxTarget(session)?.activate()).toBe(false);
    expect(fake.channel.sit).not.toHaveBeenCalled();
  });

  it('keeps the box’s own station id, so it keeps the room’s shimmer and glow (D-123)', () => {
    const { fake, session } = atBox();
    fake.push(ring({ phase: 'idle', round: 1, champion: SELF }));
    expect(boxTarget(session)?.id).toBe(ARENA_BOX_TARGET_ID);
  });

  it('offers nothing at the box from off its approach', () => {
    const fake = fakeChannel(ring());
    const { host } = fakeHost(SAND);
    const session = createArenaSession(fake.channel, host);
    fake.push(ring({ phase: 'idle', round: 1, champion: SELF }));
    expect(boxTarget(session)).toBeNull();
  });

  /*
   * D-128, amended 2026-10-03: the session tells the World to seat the avatar,
   * and only ever from the server's own `seated`. The press is not the seat.
   */
  it('tells the World to seat the avatar when the server does, and to stand it when the server does', () => {
    const { fake, host, session } = atBox();
    fake.push(ring({ phase: 'idle', round: 1, champion: SELF }));
    expect(host.setThroned).not.toHaveBeenCalled();
    fake.push(ring({ phase: 'idle', round: 1, champion: SELF, seated: true }));
    expect(host.setThroned).toHaveBeenLastCalledWith(true);
    // A repeat of the same ring does not seat them twice.
    fake.push(ring({ phase: 'idle', round: 1, champion: SELF, seated: true }));
    expect(host.setThroned).toHaveBeenCalledTimes(1);
    fake.push(ring({ phase: 'idle', round: 1, champion: SELF }));
    expect(host.setThroned).toHaveBeenLastCalledWith(false);
    expect(session.onThrone?.()).toBe(false);
  });

  it('stands the avatar up when the server gives the box to a new champion', () => {
    const { fake, host } = atBox();
    fake.push(ring({ phase: 'idle', round: 1, champion: SELF, seated: true }));
    expect(host.setThroned).toHaveBeenLastCalledWith(true);
    // Someone else won the next fight: the throne is theirs, and this client
    // is put down beside the box without ever pressing anything.
    fake.push(ring({ phase: 'ended', round: 2, champion: OTHER }));
    expect(host.setThroned).toHaveBeenLastCalledWith(false);
  });

  it('leaveThrone asks the server, and keeps asking until the intent floor lets it through', () => {
    const time = clock();
    const fake = fakeChannel(ring(), SELF);
    const { host } = fakeHost(BOX);
    const session = createArenaSession(fake.channel, host, { now: time.now });
    fake.push(ring({ phase: 'idle', round: 1, champion: SELF }));
    // Sitting down spends the floor...
    expect(boxTarget(session)?.activate()).toBe(true);
    expect(fake.channel.sit).toHaveBeenCalledTimes(1);
    fake.push(ring({ phase: 'idle', round: 1, champion: SELF, seated: true }));
    // ...so a stand-up straight after is refused by it, and kept.
    expect(session.leaveThrone?.()).toBe(true);
    expect(fake.channel.sit).toHaveBeenCalledTimes(1);
    session.update(16);
    expect(fake.channel.sit).toHaveBeenCalledTimes(1);
    // Once the floor is out it goes, once, without another press.
    time.advance(ARENA_INTENT_CLIENT_INTERVAL_MS + 1);
    session.update(16);
    expect(fake.channel.sit).toHaveBeenCalledTimes(2);
    session.update(16);
    expect(fake.channel.sit).toHaveBeenCalledTimes(2);
  });

  it('asks nothing when it is not on the throne, and drops a kept request once the server stands them', () => {
    const time = clock();
    const fake = fakeChannel(ring(), SELF);
    const { host } = fakeHost(BOX);
    const session = createArenaSession(fake.channel, host, { now: time.now });
    fake.push(ring({ phase: 'idle', round: 1, champion: SELF }));
    expect(session.leaveThrone?.()).toBe(false);
    expect(fake.channel.sit).not.toHaveBeenCalled();
    fake.push(ring({ phase: 'idle', round: 1, champion: SELF, seated: true }));
    expect(session.leaveThrone?.()).toBe(true);
    expect(fake.channel.sit).toHaveBeenCalledTimes(1);
    // The server stands them up for its own reasons; the kept request dies.
    fake.push(ring({ phase: 'idle', round: 1, champion: SELF }));
    time.advance(ARENA_INTENT_CLIENT_INTERVAL_MS + 1);
    session.update(16);
    expect(fake.channel.sit).toHaveBeenCalledTimes(1);
  });

  it('destroy puts the World back on its feet, so a torn-down session leaves nobody frozen', () => {
    const { fake, host, session } = atBox();
    fake.push(ring({ phase: 'idle', round: 1, champion: SELF, seated: true }));
    expect(host.setThroned).toHaveBeenLastCalledWith(true);
    session.destroy();
    expect(host.setThroned).toHaveBeenLastCalledWith(false);
  });

  it('everyone in the arena sees who is on the throne, spectator or not', () => {
    const fake = fakeChannel(ring());
    const { host } = fakeHost(SAND);
    const session = createArenaSession(fake.channel, host);
    fake.push(ring({ phase: 'idle', round: 1, champion: OTHER, seated: true }));
    expect(session.frame()).toMatchObject({
      championId: OTHER,
      throneId: OTHER,
      selfIsChampion: false,
      selfOnThrone: false,
    });
    // A champion who is not sitting is nobody's throne.
    fake.push(ring({ phase: 'idle', round: 1, champion: OTHER }));
    expect(session.frame()?.throneId).toBeNull();
  });
});
