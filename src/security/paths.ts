/**
 * Filesystem containment.
 *
 * Every path that reaches this MCP from an agent is untrusted. A path is only
 * usable if, after full symlink resolution, it still lives inside one of the
 * directories the operator explicitly approved. Resolving first and comparing
 * second is what defeats `../` traversal, symlink escapes, and alternate
 * spellings of the same path at once -- there is no pattern matching on the
 * raw string to outwit.
 */

import { realpath } from 'node:fs/promises';
import * as path from 'node:path';

export class PathAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathAccessError';
  }
}

/**
 * Resolve `root` through symlinks. Approved roots must already exist; a root
 * that does not is a configuration error, not a runtime one.
 */
export async function canonicalizeRoot(root: string): Promise<string> {
  if (!path.isAbsolute(root)) {
    throw new PathAccessError(`Approved directory ${JSON.stringify(root)} must be an absolute path`);
  }
  try {
    return await realpath(root);
  } catch {
    throw new PathAccessError(
      `Approved directory ${JSON.stringify(root)} does not exist or is not readable`
    );
  }
}

/**
 * Resolve `candidate` as far as it exists, then extend with the not-yet-created
 * tail. This lets us vet the destination of a file we are about to write while
 * still following every symlink that is actually on disk.
 */
async function resolveExistingPrefix(candidate: string): Promise<string> {
  const segments: string[] = [];
  let current = path.resolve(candidate);

  for (;;) {
    try {
      const real = await realpath(current);
      return segments.length === 0 ? real : path.join(real, ...segments.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root without finding anything real.
        return path.resolve(candidate);
      }
      segments.push(path.basename(current));
      current = parent;
    }
  }
}

/** True when `child` is `root` itself or lives beneath it. */
export function isContained(child: string, root: string): boolean {
  if (child === root) return true;
  const relative = path.relative(root, child);
  return (
    relative !== '' &&
    !relative.startsWith('..' + path.sep) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}

/**
 * Validate that `candidate` resolves inside one of `approvedRoots`.
 *
 * @param approvedRoots Already-canonicalized roots (see {@link canonicalizeRoot}).
 * @returns The canonical, symlink-resolved path.
 * @throws {PathAccessError} when the path escapes every approved root.
 */
export async function assertWithinApprovedDirs(
  candidate: string,
  approvedRoots: readonly string[],
  label = 'path'
): Promise<string> {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new PathAccessError(`The ${label} is empty`);
  }
  if (candidate.includes('\0')) {
    throw new PathAccessError(`The ${label} contains a NUL byte`);
  }
  if (candidate.startsWith('~')) {
    throw new PathAccessError(
      `The ${label} starts with "~"; pass a fully expanded absolute path instead`
    );
  }
  if (!path.isAbsolute(candidate)) {
    throw new PathAccessError(
      `The ${label} ${JSON.stringify(candidate)} is relative; only absolute paths are accepted`
    );
  }
  if (approvedRoots.length === 0) {
    throw new PathAccessError(
      `No approved directories are configured, so no local ${label} can be used. ` +
        'Set CAPCUT_MEDIA_DIRS (for media) or CAPCUT_DRAFT_DIR (for CapCut projects).'
    );
  }

  const resolved = await resolveExistingPrefix(candidate);
  for (const root of approvedRoots) {
    if (isContained(resolved, root)) return resolved;
  }

  throw new PathAccessError(
    `The ${label} ${JSON.stringify(candidate)} resolves to ${JSON.stringify(resolved)}, ` +
      `which is outside every approved directory (${approvedRoots.map(r => JSON.stringify(r)).join(', ')}). ` +
      'Symlinks are followed before this check, so a link pointing outside an approved directory is rejected too.'
  );
}

/**
 * Validate a single path segment used as an identifier (draft ids, backup
 * version names). Rejects separators, traversal, and hidden/odd names so an id
 * can never be used to climb out of the directory it indexes.
 */
export function assertSafeSegment(value: string, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new PathAccessError(`The ${label} is empty`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes('..')) {
    throw new PathAccessError(
      `The ${label} ${JSON.stringify(value)} is not a valid name. ` +
        'Use only letters, digits, dot, dash and underscore, starting with a letter or digit.'
    );
  }
  return value;
}
