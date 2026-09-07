/**
 * Shared test helpers.
 */

import { mkdtemp, realpath } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Create a temp directory and return its CANONICAL path.
 *
 * The realpath matters: on macOS `os.tmpdir()` is `/var/folders/...`, and
 * `/var` is a symlink to `/private/var`. The containment guard resolves
 * symlinks before comparing, so handing it a raw `/var/...` path as an approved
 * root makes every contained path look like an escape. Production never hits
 * this because `loadConfig` canonicalizes every configured root; tests must do
 * the same or they only pass on filesystems without a symlinked temp dir.
 */
export async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}
