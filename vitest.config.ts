import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // scripts/**/*.test.mjs covers the D-005 header gate's own fixtures.
    // .mjs, not .ts: the gate is a plain Node script with no build step, and
    // importing it from TypeScript would need a declaration file for no gain.
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'scripts/**/*.test.mjs'],
    environment: 'node',
  },
});
