import { constants } from 'node:fs';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { sep } from 'node:path';

/** Resolve a regular file only when its canonical path stays under the canonical root. */
export async function resolveContainedRegularFile(file: string, canonicalRoot: string): Promise<string | null> {
  const resolved = await realpath(file).catch(() => null);
  if (!resolved) return null;
  const within = resolved === canonicalRoot || resolved.startsWith(`${canonicalRoot}${sep}`);
  if (!within || !(await stat(resolved).then((entry) => entry.isFile()).catch(() => false))) return null;
  return resolved;
}

/** Open and retain one validated file descriptor so later path replacement cannot redirect the read. */
interface StaticFileObserver {
  readonly onResolved?: (file: string) => void | Promise<void>;
  readonly resolveDescriptor?: (fd: number) => Promise<string | null>;
  readonly requireDescriptorIdentity?: boolean;
}

async function resolveOpenDescriptor(fd: number): Promise<string | null> {
  return realpath(`/proc/self/fd/${fd}`).catch(() => null);
}

export async function openContainedRegularFile(
  file: string,
  canonicalRoot: string,
  observer: StaticFileObserver = {},
): Promise<FileHandle | null> {
  const resolved = await resolveContainedRegularFile(file, canonicalRoot);
  if (!resolved) return null;
  await observer.onResolved?.(resolved);
  // O_NOFOLLOW binds the validation to the final path component on platforms
  // that expose it (Linux/macOS). If unavailable, the descriptor's canonical
  // procfs path check below retains the fail-closed boundary on Linux.
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(file, constants.O_RDONLY | noFollow).catch(() => null);
  if (!handle) return null;
  const opened = await handle.stat().catch(() => null);
  const descriptorPath = observer.resolveDescriptor
    ? await observer.resolveDescriptor(handle.fd).catch(() => null)
    : await resolveOpenDescriptor(handle.fd);
  const descriptorWithin = descriptorPath === null
    ? noFollow !== 0 && observer.requireDescriptorIdentity !== true
    : descriptorPath === canonicalRoot || descriptorPath.startsWith(`${canonicalRoot}${sep}`);
  if (!opened?.isFile() || !descriptorWithin) {
    await handle.close().catch(() => undefined);
    return null;
  }
  return handle;
}
