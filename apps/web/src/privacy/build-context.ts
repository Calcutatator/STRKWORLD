/**
 * Whether this is a production build, as far as the shell can tell.
 *
 * It gates exactly one thing: whether the deterministic fake may be used. The
 * fake reports balances nobody holds, so shipping it would put money-shaped
 * fiction in front of a player.
 *
 * **Fails closed.** Only an explicit development signal counts as development.
 * `import.meta.env` is a Vite construct, present in a real build and under the
 * test runner and absent when the shell is imported by something else — a plain
 * Node process, another bundler, a consumer we have not thought of. Absent, or
 * present without a definite answer, means "cannot tell", and cannot-tell is
 * treated as production. Being wrong that way costs a loud error in
 * development; the opposite default costs invented balances in front of a real
 * user.
 */

export interface BuildContext {
  production: boolean;
}

/**
 * The decision, separated from where the flag comes from.
 *
 * Split out so the fail-closed branch is reachable from a test: inside Vite,
 * `import.meta.env` always exists, so `detectBuildContext` alone can never
 * exercise the case that matters.
 */
export function buildContextFrom(env: { PROD?: boolean; DEV?: boolean } | undefined): BuildContext {
  if (!env) return Object.freeze({ production: true });
  // `!== false`, not `=== true`: a bundler that defines the object but not the
  // flag is still a context we cannot vouch for.
  return Object.freeze({ production: env.PROD !== false });
}

export function detectBuildContext(): BuildContext {
  return buildContextFrom((import.meta as { env?: { PROD?: boolean; DEV?: boolean } }).env);
}
