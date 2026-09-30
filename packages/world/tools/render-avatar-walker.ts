/**
 * Regenerate the Shell's walker strip (AVATAR_WALKER) from the 3D figure.
 *
 *   npm run render:walker --workspace=@strkworld/world
 *   npm run render:walker --workspace=@strkworld/world -- /some/other/path.png
 *
 * Writes `assets/avatar-walker/walk.png` unless given another path, and prints
 * its size and the SHA-256 of its pixels. Run it after changing the figure, its
 * walk or the World's lighting; `avatar-walker.test.ts` fails until you do.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AVATAR_WALKER_FILE, encodePng, renderAvatarWalker } from './avatar-walker.js';

const target = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(AVATAR_WALKER_FILE);
const strip = renderAvatarWalker();
const png = encodePng(strip.width, strip.height, strip.rgba);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, png);
const pixels = createHash('sha256').update(strip.rgba).digest('hex');
console.log(
  `${target}\n  ${strip.width}x${strip.height}, ${strip.cells} cells, ${png.length} bytes\n  pixels sha256 ${pixels}`,
);
