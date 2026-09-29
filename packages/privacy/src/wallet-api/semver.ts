/**
 * Wallet API version strings, parsed strictly (SemVer 2.0 core and
 * prerelease; no build metadata, no leading zeros). Shared by the STRK20
 * capability check and the Vault's shadow-account check (D-077), so both read
 * one version list the same way.
 */

export interface Semver {
  core: [number, number, number];
  prerelease: string[] | null;
}

export function parseSemver(value: string): Semver | null {
  if (typeof value !== 'string') return null;
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as Semver['core'];
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  const prerelease = match[4]?.split('.') ?? null;
  if (prerelease?.some((identifier) =>
    identifier.length === 0 ||
    !/^[0-9A-Za-z-]+$/.test(identifier) ||
    (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))
  )) return null;
  return { core, prerelease };
}

export function compareSemver(left: Semver, right: Semver): number {
  for (let index = 0; index < left.core.length; index += 1) {
    const difference = left.core[index]! - right.core[index]!;
    if (difference !== 0) return difference;
  }
  if (left.prerelease === null) return right.prerelease === null ? 0 : 1;
  if (right.prerelease === null) return -1;
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumber = /^\d+$/.test(a) ? BigInt(a) : null;
    const bNumber = /^\d+$/.test(b) ? BigInt(b) : null;
    if (aNumber !== null && bNumber !== null) return aNumber < bNumber ? -1 : 1;
    if (aNumber !== null) return -1;
    if (bNumber !== null) return 1;
    return a.localeCompare(b);
  }
  return 0;
}

/** The highest parseable version in a wallet's list, with its raw spelling, or null. */
export function highestVersion(versions: readonly unknown[]): { raw: string; parsed: Semver } | null {
  const supported = versions
    .map((raw) => ({ raw, parsed: typeof raw === 'string' ? parseSemver(raw) : null }))
    .filter((version): version is { raw: string; parsed: Semver } => version.parsed !== null)
    .sort((left, right) => compareSemver(left.parsed, right.parsed));
  return supported.at(-1) ?? null;
}
