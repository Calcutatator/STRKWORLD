import { realpath, stat } from 'node:fs/promises';
import { sep } from 'node:path';

/** Resolve a regular file only when its canonical path stays under the canonical root. */
export async function resolveContainedRegularFile(file: string, canonicalRoot: string): Promise<string | null> {
  const resolved = await realpath(file).catch(() => null);
  if (!resolved) return null;
  const within = resolved === canonicalRoot || resolved.startsWith(`${canonicalRoot}${sep}`);
  if (!within || !(await stat(resolved).then((entry) => entry.isFile()).catch(() => false))) return null;
  return resolved;
}
