import { describe, expect, it, vi } from 'vitest';
import {
  chooseInteractionTarget,
  createInteractionSystem,
  facingDot,
  inApproachRing,
  promptLabel,
  type InteractionPlayer,
  type InteractionPrompt,
  type InteractionTarget,
} from './interaction.js';

/** One 32 px tile, as the street's. */
const T = 32;

function at(id: string, x: number, y: number, used: string[] = []): InteractionTarget {
  return { id, label: id.toUpperCase(), rect: { x: x * T, y: y * T, width: T, height: T }, activate: () => used.push(id) };
}

function player(x: number, y: number, heading: { x: number; y: number } = { x: 0, y: 0 }): InteractionPlayer {
  return { position: { x: x * T + T / 2, y: y * T + T / 2 }, heading };
}

describe('the interaction system (D-117)', () => {
  it('picks the nearest target in reach, and the one first offered on a tie', () => {
    const near = at('near', 6, 5);
    const far = at('far', 3, 5);
    expect(chooseInteractionTarget([far, near], player(5, 5))).toBe(near);
    const left = at('left', 4, 5);
    const right = at('right', 6, 5);
    expect(chooseInteractionTarget([left, right], player(5, 5))).toBe(left);
    expect(chooseInteractionTarget([], player(5, 5))).toBeNull();
  });

  it('prefers the target the player faces, and never offers one behind them', () => {
    const ahead = at('ahead', 5, 2);
    const beside = at('beside', 6, 5);
    const behind = at('behind', 5, 6);
    const north = { x: 0, y: -1 };
    // Facing north: the one two tiles ahead beats the one right beside.
    expect(chooseInteractionTarget([beside, ahead], player(5, 5, north))).toBe(ahead);
    // Beside is roughly faced (90°) and still offered; behind is not.
    expect(chooseInteractionTarget([behind, beside], player(5, 5, north))).toBe(beside);
    expect(chooseInteractionTarget([behind], player(5, 5, north))).toBeNull();
    // Not moved yet: facing unknown, so nothing is behind.
    expect(chooseInteractionTarget([behind], player(5, 5))).toBe(behind);
    // Standing on a target faces it.
    expect(facingDot(at('under', 5, 5).rect, player(5, 5, north))).toBe(1);
  });

  it('shows the focused target\'s prompt over its centre, and only on a change', () => {
    const prompts: Array<InteractionPrompt | null> = [];
    const system = createInteractionSystem({ onPrompt: (prompt) => prompts.push(prompt) });
    let offered: InteractionTarget[] = [at('counter', 5, 4)];
    system.register({ targets: () => offered });
    system.update(player(5, 5));
    system.update(player(5, 5));
    expect(prompts).toEqual([{ id: 'counter', label: 'COUNTER', x: 5.5 * T, y: 4.5 * T }]);
    expect(system.focused).toEqual(prompts[0]);
    offered = [];
    system.update(player(5, 5));
    expect(prompts.at(-1)).toBeNull();
    expect(system.focused).toBeNull();
    expect(prompts).toHaveLength(2);
  });

  it('uses the focused target on interact, and only then offers E to the actions, highest priority first', () => {
    const used: string[] = [];
    const system = createInteractionSystem();
    let offered: InteractionTarget[] = [at('counter', 5, 4, used)];
    system.register({ targets: () => offered });
    const order: string[] = [];
    system.addAction({ id: 'kick', run: () => (order.push('kick'), false) });
    system.addAction({ id: 'attack', priority: 5, run: () => (order.push('attack'), true) });
    system.addAction({ id: 'sandbox', run: () => (order.push('sandbox'), true) });
    system.update(player(5, 5));
    expect(system.interact()).toBe(true);
    expect(used).toEqual(['counter']);
    expect(order).toEqual([]);
    offered = [];
    expect(system.interact()).toBe(true);
    expect(order).toEqual(['attack']);
  });

  it('falls through every action that declines, and reports when nothing took E', () => {
    const system = createInteractionSystem();
    const order: string[] = [];
    system.addAction({ id: 'a', run: () => (order.push('a'), false) });
    const stop = system.addAction({ id: 'b', run: () => (order.push('b'), true) });
    system.update(player(1, 1));
    expect(system.interact()).toBe(true);
    stop();
    expect(system.interact()).toBe(false);
    expect(order).toEqual(['a', 'b', 'a']);
  });

  it('yields every station while a suspension holds: no prompt, and E goes to the actions (the combat hook)', () => {
    const used: string[] = [];
    const prompts: Array<InteractionPrompt | null> = [];
    const system = createInteractionSystem({ onPrompt: (prompt) => prompts.push(prompt) });
    system.register({ targets: () => [at('gate', 5, 4, used)] });
    const attacks = vi.fn(() => true);
    system.addAction({ id: 'attack', run: attacks });
    system.update(player(5, 5));
    expect(system.focused?.id).toBe('gate');

    const fight = system.suspend('combat');
    const other = system.suspend('cutscene');
    expect(system.suspended).toBe(true);
    expect(system.focused).toBeNull();
    system.update(player(5, 5));
    expect(system.focused).toBeNull();
    expect(system.interact()).toBe(true);
    expect(attacks).toHaveBeenCalledOnce();
    expect(used).toEqual([]);

    fight();
    fight();
    expect(system.suspended).toBe(true);
    other();
    expect(system.suspended).toBe(false);
    // Released: the station's prompt is back at once.
    expect(system.focused?.id).toBe('gate');
    expect(prompts.map((prompt) => prompt?.id ?? null)).toEqual(['gate', null, 'gate']);
  });

  it('does nothing at all while blocked (a panel owns the keyboard), and fails closed if that cannot be read', () => {
    let blocked = true;
    const used: string[] = [];
    const action = vi.fn(() => true);
    const system = createInteractionSystem({ blocked: () => blocked });
    system.register({ targets: () => [at('counter', 5, 4, used)] });
    system.addAction({ id: 'kick', run: action });
    system.update(player(5, 5));
    expect(system.focused).toBeNull();
    expect(system.interact()).toBe(false);
    expect(action).not.toHaveBeenCalled();
    blocked = false;
    system.update(player(5, 5));
    expect(system.focused?.id).toBe('counter');

    const broken = createInteractionSystem({ blocked: () => { throw new Error('unreadable'); } });
    broken.register({ targets: () => [at('counter', 5, 4, used)] });
    broken.update(player(5, 5));
    expect(broken.interact()).toBe(false);
    expect(used).toEqual([]);
  });

  it('keeps working when one source throws or offers nonsense', () => {
    const used: string[] = [];
    const system = createInteractionSystem();
    system.register({ targets: () => { throw new Error('broken source'); } });
    system.register({ targets: () => [{ id: '', label: 'X', rect: { x: 0, y: 0, width: 1, height: 1 }, activate: () => {} }] as InteractionTarget[] });
    system.register({ targets: () => [at('counter', 5, 4, used)] });
    system.update(player(5, 5));
    expect(system.focused?.id).toBe('counter');
  });

  it('re-picks on interact, so a target gone since the last frame is never used', () => {
    const used: string[] = [];
    let offered = [at('counter', 5, 4, used)];
    const system = createInteractionSystem();
    system.register({ targets: () => offered });
    system.update(player(5, 5));
    offered = [];
    expect(system.interact()).toBe(false);
    expect(used).toEqual([]);
  });

  it('clears the prompt on a teleport, and drops everything on destroy', () => {
    const prompts: Array<InteractionPrompt | null> = [];
    const system = createInteractionSystem({ onPrompt: (prompt) => prompts.push(prompt) });
    const stop = system.register({ targets: () => [at('counter', 5, 4)] });
    system.update(player(5, 5));
    system.clear();
    expect(system.focused).toBeNull();
    system.update(player(5, 5));
    stop();
    system.update(player(5, 5));
    expect(system.focused).toBeNull();
    system.register({ targets: () => [at('counter', 5, 4)] });
    system.update(player(5, 5));
    system.destroy();
    expect(system.focused).toBeNull();
    expect(system.interact()).toBe(false);
    expect(prompts.map((prompt) => prompt?.id ?? null)).toEqual(['counter', null, 'counter', null, 'counter', null]);
  });

  it('measures a footprint\'s approach ring and folds a label to one line', () => {
    const counter = { x: 3, y: 3, width: 2, height: 1 };
    expect(inApproachRing(counter, 2, 2)).toBe(true);
    expect(inApproachRing(counter, 5, 4)).toBe(true);
    expect(inApproachRing(counter, 3, 3)).toBe(false);
    expect(inApproachRing(counter, 6, 4)).toBe(false);
    expect(inApproachRing(counter, 6, 4, 2)).toBe(true);
    expect(promptLabel('故障中\nOUT OF ORDER')).toBe('故障中 OUT OF ORDER');
    expect(promptLabel('  ')).toBeNull();
    expect(promptLabel(42)).toBeNull();
  });
});
