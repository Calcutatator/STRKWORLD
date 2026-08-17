import { describe, expect, it } from 'vitest';
import { buildContextFrom, detectBuildContext } from './build-context.js';

describe('build context', () => {
  it('treats a missing bundler flag as production', () => {
    // The case that matters, and the one detection alone cannot reach: inside
    // Vite `import.meta.env` always exists. Outside it — a plain Node process,
    // another bundler — "cannot tell" must not permit the fake.
    expect(buildContextFrom(undefined).production).toBe(true);
  });

  it('treats a flag object with no definite answer as production', () => {
    expect(buildContextFrom({}).production).toBe(true);
    expect(buildContextFrom({ DEV: true }).production).toBe(true);
  });

  it('accepts only an explicit development signal', () => {
    expect(buildContextFrom({ PROD: false }).production).toBe(false);
    expect(buildContextFrom({ PROD: true }).production).toBe(true);
  });

  it('reports development under the test runner, which is a real Vite context', () => {
    expect(detectBuildContext().production).toBe(false);
  });
});
