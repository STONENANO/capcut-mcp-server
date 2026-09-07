/**
 * CapCut project backups.
 *
 * Why this exists, concretely: VectCutAPI's `save_draft` does
 *
 *     if os.path.exists(draft_dir): shutil.rmtree(draft_dir)
 *     shutil.copytree(template_source_dir, draft_dir)
 *
 * -- it DELETES the entire existing project directory and rebuilds it from a
 * template. Saving over a draft id that already exists destroys whatever was
 * there, assets included, with no prompt and no undo. That is the destructive
 * write this module protects against.
 *
 * Two consequences shape the design:
 *
 *  1. Snapshots CANNOT live inside the project directory -- the save would
 *     delete them along with everything else. They live in a sibling tree at
 *     <draft root>/.smartcut_backups/<draft id>/<timestamp>/, still inside the
 *     operator-approved root, but out of rmtree's path.
 *  2. A snapshot must cover the WHOLE project, not just its metadata, because
 *     the whole project is what gets removed. If a project is too large to copy
 *     within the configured budget, the backup fails -- and so does the save.
 *     A partial backup would be a false promise.
 */

import { constants as fsConstants } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import * as path from 'node:path';
import { assertSafeSegment, assertWithinApprovedDirs, PathAccessError } from '../security/paths.js';

/** Snapshot tree name, created as a sibling of the projects it protects. */
export const BACKUP_DIR_NAME = '.smartcut_backups';

/** Default ceiling on the bytes copied into one snapshot. */
export const DEFAULT_MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

export interface BackupRecord {
  /** Directory name, e.g. "2026-09-07_14-31-05". */
  version: string;
  /** Absolute path of the snapshot directory. */
  directory: string;
  /** Project-relative paths captured in this snapshot. */
  files: string[];
  /** Total bytes copied. */
  bytes: number;
  createdAt: Date;
}

/** Format a timestamp as the directory name used for a snapshot. */
export function formatBackupStamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/** Parse a snapshot directory name back into a Date, or null if it is not one. */
export function parseBackupStamp(version: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:_\d+)?$/.exec(version);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isNaN(date.getTime()) ? null : date;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write `data` to `destination` atomically: a temp file in the same directory
 * is written, flushed to disk, then renamed over the target. Rename within a
 * filesystem is atomic, so a reader sees either the old file or the new one,
 * never a half-written project file.
 */
export async function atomicWriteFile(destination: string, data: string | Buffer): Promise<void> {
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.tmp`);

  const handle = await open(temporary, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Where snapshots for a given draft live. */
export function backupDirFor(draftRoot: string, draftId: string): string {
  return path.join(draftRoot, BACKUP_DIR_NAME, draftId);
}

/**
 * Resolve a project directory inside the approved CapCut draft root.
 * `draftId` is validated as a single safe path segment first, so it can never
 * address anything but a direct child of the root -- and, because a safe
 * segment must start with an alphanumeric, never the `.smartcut_backups` tree.
 */
export async function resolveProjectDir(draftId: string, draftRoot: string): Promise<string> {
  assertSafeSegment(draftId, 'draft id');
  const candidate = path.join(draftRoot, draftId);
  return assertWithinApprovedDirs(candidate, [draftRoot], 'CapCut project directory');
}

interface WalkEntry {
  relative: string;
  absolute: string;
  size: number;
}

/**
 * Walk a project tree, collecting regular files.
 *
 * Symlinks are not followed and not copied: a link inside a project could point
 * anywhere, and neither reading through it nor recreating it is something a
 * backup should do silently.
 */
async function walkProject(root: string, budgetBytes: number): Promise<WalkEntry[]> {
  const collected: WalkEntry[] = [];
  let total = 0;

  const visit = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = prefix === '' ? entry.name : path.join(prefix, entry.name);

      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      if (!entry.isFile()) continue;

      const info = await stat(absolute).catch(() => null);
      if (!info?.isFile()) continue;

      total += info.size;
      if (total > budgetBytes) {
        throw new BackupError(
          `Refusing to save: backing up this project would copy more than ${budgetBytes} bytes, ` +
            'and VectCutAPI deletes the existing project directory when it saves. ' +
            'Raise CAPCUT_MAX_BACKUP_BYTES, or move large media out of the project folder, ' +
            'so a complete backup can be taken first.'
        );
      }
      collected.push({ relative, absolute, size: info.size });
    }
  };

  await visit(root, '');
  return collected;
}

export interface CreateBackupResult {
  created: boolean;
  /** Set when `created` is true. */
  record?: BackupRecord;
  /** Why a snapshot was skipped, when `created` is false. */
  skippedReason?: string;
}

export interface CreateBackupOptions {
  /**
   * Suppress a new snapshot if one was taken within this many seconds. A single
   * logical edit session issues many mutating calls; without this every call
   * would leave its own near-identical copy.
   */
  coalesceSeconds?: number;
  /** Ceiling on bytes copied into one snapshot. */
  maxBytes?: number;
  /** Injected clock, for tests. */
  now?: Date;
}

/**
 * Snapshot a whole project before it is mutated.
 *
 * Never overwrites an existing snapshot: if a directory for this second already
 * exists, a numeric suffix is added. The snapshot is staged in a temporary
 * directory and renamed into place, so a snapshot directory is never observed
 * half-populated.
 */
export async function createBackup(
  projectDir: string,
  draftRoot: string,
  draftId: string,
  options: CreateBackupOptions = {}
): Promise<CreateBackupResult> {
  const now = options.now ?? new Date();
  const coalesceSeconds = options.coalesceSeconds ?? 0;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BACKUP_BYTES;

  if (!(await exists(projectDir))) {
    return { created: false, skippedReason: 'the project does not exist yet, so nothing can be lost' };
  }

  const files = await walkProject(projectDir, maxBytes);
  if (files.length === 0) {
    return { created: false, skippedReason: 'the project directory is empty' };
  }

  const backupRoot = backupDirFor(draftRoot, draftId);

  if (coalesceSeconds > 0) {
    const [latest] = await listBackups(draftRoot, draftId);
    if (latest) {
      const ageSeconds = (now.getTime() - latest.createdAt.getTime()) / 1000;
      if (ageSeconds >= 0 && ageSeconds < coalesceSeconds) {
        return {
          created: false,
          skippedReason:
            `a backup from ${latest.version} is ${Math.round(ageSeconds)}s old, within the ` +
            `${coalesceSeconds}s coalescing window`,
        };
      }
    }
  }

  await mkdir(backupRoot, { recursive: true });

  const stamp = formatBackupStamp(now);
  let version = stamp;
  let suffix = 1;
  while (await exists(path.join(backupRoot, version))) {
    version = `${stamp}_${suffix++}`;
  }

  const staging = await mkdtemp(path.join(backupRoot, '.staging-'));
  try {
    let bytes = 0;
    for (const file of files) {
      const destination = path.join(staging, file.relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(file.absolute, destination);
      bytes += file.size;
    }
    const directory = path.join(backupRoot, version);
    await rename(staging, directory);
    return {
      created: true,
      record: {
        version,
        directory,
        files: files.map(f => f.relative).sort(),
        bytes,
        createdAt: now,
      },
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error instanceof BackupError) throw error;
    throw new BackupError(
      `Failed to back up ${draftId}: ${error instanceof Error ? error.message : 'unknown error'}`
    );
  }
}

/** List existing snapshots for a project, newest first. */
export async function listBackups(draftRoot: string, draftId: string): Promise<BackupRecord[]> {
  assertSafeSegment(draftId, 'draft id');
  const backupRoot = backupDirFor(draftRoot, draftId);

  let entries: string[];
  try {
    entries = await readdir(backupRoot);
  } catch {
    return [];
  }

  const records: BackupRecord[] = [];
  for (const version of entries) {
    const createdAt = parseBackupStamp(version);
    if (!createdAt) continue;
    const directory = path.join(backupRoot, version);
    const info = await stat(directory).catch(() => null);
    if (!info?.isDirectory()) continue;

    const files = await walkProject(directory, Number.MAX_SAFE_INTEGER).catch(() => []);
    records.push({
      version,
      directory,
      files: files.map(f => f.relative).sort(),
      bytes: files.reduce((sum, f) => sum + f.size, 0),
      createdAt,
    });
  }

  return records.sort((a, b) => b.version.localeCompare(a.version));
}

export interface RestoreResult {
  version: string;
  restoredFiles: string[];
  /** Snapshot taken of the pre-restore state, so a restore is itself undoable. */
  safetyBackup?: BackupRecord;
}

/**
 * Restore a project from one of its own snapshots.
 *
 * Source and destination are both derived from the approved draft root and a
 * validated draft id, so neither can be an arbitrary filesystem path. The
 * pre-restore state is snapshotted first, and the swap happens by renaming a
 * fully-built staging directory into place -- so an interrupted restore leaves
 * either the old project or the new one, never a mixture.
 */
export async function restoreBackup(
  draftRoot: string,
  draftId: string,
  version: string,
  options: { now?: Date; maxBytes?: number } = {}
): Promise<RestoreResult> {
  assertSafeSegment(draftId, 'draft id');
  assertSafeSegment(version, 'backup version');
  if (!parseBackupStamp(version)) {
    throw new BackupError(
      `${JSON.stringify(version)} is not a backup version name (expected YYYY-MM-DD_HH-MM-SS)`
    );
  }

  const backupRoot = backupDirFor(draftRoot, draftId);
  const projectDir = await resolveProjectDir(draftId, draftRoot);

  // Re-verify containment after symlink resolution: the snapshot must still be
  // inside this draft's own backup tree.
  let resolvedSource: string;
  try {
    resolvedSource = await assertWithinApprovedDirs(
      path.join(backupRoot, version),
      [backupRoot],
      'backup directory'
    );
  } catch (error) {
    if (error instanceof PathAccessError) throw new BackupError(error.message);
    throw error;
  }

  const info = await stat(resolvedSource).catch(() => null);
  if (!info?.isDirectory()) {
    throw new BackupError(`Backup ${JSON.stringify(version)} does not exist for this project`);
  }

  const files = await walkProject(resolvedSource, options.maxBytes ?? DEFAULT_MAX_BACKUP_BYTES);
  if (files.length === 0) {
    throw new BackupError(`Backup ${JSON.stringify(version)} is empty`);
  }

  // Snapshot the current state first: restoring must never destroy the only
  // copy of what is on disk right now.
  const safety = await createBackup(projectDir, draftRoot, draftId, {
    now: options.now,
    maxBytes: options.maxBytes,
  });

  const staging = await mkdtemp(path.join(draftRoot, '.smartcut_restore-'));
  const retired = `${projectDir}.retired-${process.pid}`;
  try {
    for (const file of files) {
      const destination = path.join(staging, file.relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(file.absolute, destination);
    }

    const projectExists = await exists(projectDir);
    if (projectExists) await rename(projectDir, retired);
    try {
      await rename(staging, projectDir);
    } catch (error) {
      // Put the original back before surfacing the failure.
      if (projectExists) await rename(retired, projectDir).catch(() => undefined);
      throw error;
    }
    await rm(retired, { recursive: true, force: true });

    return { version, restoredFiles: files.map(f => f.relative).sort(), safetyBackup: safety.record };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error instanceof BackupError) throw error;
    throw new BackupError(
      `Failed to restore ${version}: ${error instanceof Error ? error.message : 'unknown error'}`
    );
  }
}
