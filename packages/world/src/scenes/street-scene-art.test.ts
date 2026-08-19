import { describe, expect, it } from 'vitest';
import { createStreetMap } from '../map/street.js';
import { doorOverlayLayout } from './street-scene.js';

describe('street Kenney door presentation', () => {
  it('keeps the two-tile trigger but centers a native-size door image over it', () => {
    const bankDoor = createStreetMap().doors.find((door) => door.building === 'bank')!;

    expect(bankDoor).toMatchObject({ x: 5, y: 10, width: 2, height: 1 });
    expect(doorOverlayLayout(bankDoor)).toEqual({
      x: 6 * 32,
      y: 10.5 * 32,
      width: 32,
      height: 32,
    });
  });
});
