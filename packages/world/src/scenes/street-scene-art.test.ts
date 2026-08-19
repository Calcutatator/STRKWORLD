import { describe, expect, it } from 'vitest';
import { createStreetMap } from '../map/street.js';
import { avatarPlaceholderTint, doorOverlayLayout } from './street-scene.js';

describe('street Kenney door presentation', () => {
  it('keeps the two-tile trigger but centers a native-size door over a facade surround', () => {
    const bankDoor = createStreetMap().doors.find((door) => door.building === 'bank')!;

    expect(bankDoor).toMatchObject({ x: 5, y: 10, width: 2, height: 1 });
    expect(doorOverlayLayout(bankDoor)).toEqual({
      x: 6 * 32,
      y: 10.5 * 32,
      width: 64,
      height: 32,
    });
  });

  it('keeps placeholder presentation deterministic across the 16 cosmetic keys', () => {
    expect(avatarPlaceholderTint('avatar-1')).toBe(0xf2e8c9);
    expect(avatarPlaceholderTint('avatar-9')).toBe(0xf2e8c9);
    expect(avatarPlaceholderTint('avatar-16')).toBe(0xc7f2df);
  });
});
