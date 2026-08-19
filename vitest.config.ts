import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // .test.tsx is included alongside .test.ts. Omitting it did not fail
    // loudly — a component test would simply never be collected, so it would
    // pass CI by not running. The Shell lane will write .tsx tests against
    // React panels, and a green build that ran nothing is the worst failure
    // mode available.
    //
    // scripts/**/*.test.mjs covers the D-005 header gate's own fixtures.
    // .mjs, not .ts: the gate is a plain Node script with no build step, and
    // importing it from TypeScript would need a declaration file for no gain.
    include: [
      'packages/**/*.test.ts',
      'packages/**/*.test.tsx',
      'apps/**/*.test.ts',
      'apps/**/*.test.tsx',
      'deploy/**/*.test.ts',
      'deploy/**/*.test.mjs',
      'scripts/**/*.test.mjs',
    ],
    environment: 'node',
  },
});
