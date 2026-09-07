/**
 * Requirements 7-9: a mutation is preceded by a complete timestamped backup,
 * writes are atomic, and restore only ever touches an approved project's own
 * snapshots.
 *
 * The central property under test is that a snapshot survives what VectCutAPI's
 * save actually does to a project: delete the whole directory and rebuild it.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { beforeEach, describe } from 'node:test';
import {
  atomicWriteFile,
  backupDirFor,
  BACKUP_DIR_NAME,
  BackupError,
  createBackup,
  formatBackupStamp,
  listBackups,
  parseBackupStamp,
  resolveProjectDir,
  restoreBackup,
} from '../src/services/backup.js';
import { canonicalizeRoot, PathAccessError } from '../src/security/paths.js';

const DRAFT_ID = 'dfd_project1';
const CONTENT_V1 = JSON.stringify({ tracks: ['original'] });
const CONTENT_V2 = JSON.stringify({ tracks: ['edited'] });

let draftRoot: string;
let projectDir: string;

async function makeProject(): Promise<void> {
  draftRoot = await canonicalizeRoot(await mkdtemp(path.join(os.tmpdir(), 'capcut-drafts-')));
  projectDir = path.join(draftRoot, DRAFT_ID);
  await mkdir(path.join(projectDir, 'assets', 'video'), { recursive: true });
  await writeFile(path.join(projectDir, 'draft_info.json'), CONTENT_V1);
  await writeFile(path.join(projectDir, 'draft_meta_info.json'), '{"meta":1}');
  await writeFile(path.join(projectDir, 'template.tmp'), 'tmp');
  await writeFile(path.join(projectDir, 'assets', 'video', 'clip.mp4'), 'fake-media');
}

/** Reproduce VectCutAPI's destructive save: rmtree the project, then rebuild. */
async function simulateVectCutSave(): Promise<void> {
  await rm(projectDir, { recursive: true, force: true });
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, 'draft_info.json'), CONTENT_V2);
}

describe('backup stamps', () => {
  test('round-trip through format and parse', () => {
    const when = new Date(2026, 8, 7, 14, 31, 5);
    assert.equal(formatBackupStamp(when), '2026-09-07_14-31-05');
    assert.equal(parseBackupStamp('2026-09-07_14-31-05')?.getTime(), when.getTime());
    assert.equal(parseBackupStamp('not-a-stamp'), null);
    assert.equal(parseBackupStamp('../../etc'), null);
  });
});

describe('atomic writes', () => {
  test('leave no temp file behind and replace content wholesale', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'capcut-atomic-'));
    const target = path.join(dir, 'draft_info.json');
    await atomicWriteFile(target, CONTENT_V1);
    await atomicWriteFile(target, CONTENT_V2);
    assert.equal(await readFile(target, 'utf8'), CONTENT_V2);
    assert.deepEqual(await readdir(dir), ['draft_info.json']);
  });
});

describe('createBackup', () => {
  beforeEach(makeProject);

  test('captures the whole project, assets included', async () => {
    const result = await createBackup(projectDir, draftRoot, DRAFT_ID);
    assert.equal(result.created, true);
    assert.deepEqual(result.record!.files.sort(), [
      path.join('assets', 'video', 'clip.mp4'),
      'draft_info.json',
      'draft_meta_info.json',
      'template.tmp',
    ]);
    assert.ok(result.record!.bytes > 0);
  });

  test('the snapshot lives outside the project, so a destructive save cannot delete it', async () => {
    const backup = await createBackup(projectDir, draftRoot, DRAFT_ID);
    const snapshotDir = backup.record!.directory;

    // The snapshot must not be under the directory that save() removes.
    assert.equal(snapshotDir.startsWith(projectDir + path.sep), false);
    assert.ok(snapshotDir.startsWith(backupDirFor(draftRoot, DRAFT_ID)));

    await simulateVectCutSave();

    // Project content is gone; the snapshot is intact and still complete.
    assert.equal(await readFile(path.join(projectDir, 'draft_info.json'), 'utf8'), CONTENT_V2);
    assert.equal(
      await readFile(path.join(snapshotDir, 'draft_info.json'), 'utf8'),
      CONTENT_V1
    );
    assert.equal(
      await readFile(path.join(snapshotDir, 'assets', 'video', 'clip.mp4'), 'utf8'),
      'fake-media'
    );
    assert.equal((await listBackups(draftRoot, DRAFT_ID)).length, 1);
  });

  test('never overwrites a snapshot taken in the same second', async () => {
    const now = new Date(2026, 8, 7, 14, 31, 5);
    const first = await createBackup(projectDir, draftRoot, DRAFT_ID, { now });
    const second = await createBackup(projectDir, draftRoot, DRAFT_ID, { now });
    assert.equal(first.record!.version, '2026-09-07_14-31-05');
    assert.equal(second.record!.version, '2026-09-07_14-31-05_1');
  });

  test('coalesces snapshots inside one logical transaction', async () => {
    const start = new Date(2026, 8, 7, 14, 0, 0);
    assert.equal(
      (await createBackup(projectDir, draftRoot, DRAFT_ID, { now: start, coalesceSeconds: 300 }))
        .created,
      true
    );

    const soon = new Date(start.getTime() + 30_000);
    const skipped = await createBackup(projectDir, draftRoot, DRAFT_ID, {
      now: soon,
      coalesceSeconds: 300,
    });
    assert.equal(skipped.created, false);
    assert.match(skipped.skippedReason!, /coalescing window/);

    const later = new Date(start.getTime() + 400_000);
    assert.equal(
      (await createBackup(projectDir, draftRoot, DRAFT_ID, { now: later, coalesceSeconds: 300 }))
        .created,
      true
    );
    assert.equal((await listBackups(draftRoot, DRAFT_ID)).length, 2);
  });

  test('fails closed rather than taking a partial backup over budget', async () => {
    await writeFile(path.join(projectDir, 'big.bin'), Buffer.alloc(4096));
    await assert.rejects(
      createBackup(projectDir, draftRoot, DRAFT_ID, { maxBytes: 1024 }),
      /Refusing to save/
    );
    // Nothing half-copied was left behind.
    const backupRoot = backupDirFor(draftRoot, DRAFT_ID);
    const left = await readdir(backupRoot).catch(() => []);
    assert.deepEqual(left, []);
  });

  test('does not follow symlinks inside a project', async () => {
    const outside = await canonicalizeRoot(await mkdtemp(path.join(os.tmpdir(), 'capcut-out-')));
    await writeFile(path.join(outside, 'secret.txt'), 'top secret');
    await symlink(path.join(outside, 'secret.txt'), path.join(projectDir, 'link-to-secret'));

    const result = await createBackup(projectDir, draftRoot, DRAFT_ID);
    assert.equal(result.record!.files.includes('link-to-secret'), false);
  });

  test('reports rather than throws when there is nothing to back up', async () => {
    const emptyRoot = await canonicalizeRoot(
      await mkdtemp(path.join(os.tmpdir(), 'capcut-empty-'))
    );
    const missing = await createBackup(path.join(emptyRoot, 'nope'), emptyRoot, 'nope');
    assert.equal(missing.created, false);
    assert.match(missing.skippedReason!, /does not exist/);

    await mkdir(path.join(emptyRoot, 'bare'));
    const bare = await createBackup(path.join(emptyRoot, 'bare'), emptyRoot, 'bare');
    assert.equal(bare.created, false);
  });

  test('lists snapshots newest first', async () => {
    await createBackup(projectDir, draftRoot, DRAFT_ID, { now: new Date(2026, 8, 7, 10, 0, 0) });
    await createBackup(projectDir, draftRoot, DRAFT_ID, { now: new Date(2026, 8, 7, 12, 0, 0) });
    assert.deepEqual(
      (await listBackups(draftRoot, DRAFT_ID)).map(r => r.version),
      ['2026-09-07_12-00-00', '2026-09-07_10-00-00']
    );
  });

  test('the backup tree cannot be addressed as a project', async () => {
    // Safe segments must start with an alphanumeric, so `.smartcut_backups` is
    // not reachable as a draft id.
    await assert.rejects(resolveProjectDir(BACKUP_DIR_NAME, draftRoot), PathAccessError);
    await assert.rejects(listBackups(draftRoot, BACKUP_DIR_NAME), PathAccessError);
  });

  test('resolveProjectDir keeps draft ids inside the approved root', async () => {
    assert.equal(await resolveProjectDir(DRAFT_ID, draftRoot), projectDir);
    for (const badId of ['../escape', '/etc', 'a/b', '..']) {
      await assert.rejects(resolveProjectDir(badId, draftRoot), PathAccessError);
    }
  });

  test('resolveProjectDir rejects a project symlinked out of the root', async () => {
    const outside = await canonicalizeRoot(await mkdtemp(path.join(os.tmpdir(), 'capcut-out2-')));
    await symlink(outside, path.join(draftRoot, 'dfd_escape'));
    await assert.rejects(resolveProjectDir('dfd_escape', draftRoot), PathAccessError);
  });
});

describe('restoreBackup', () => {
  beforeEach(makeProject);

  test('recovers a project that a destructive save has already flattened', async () => {
    const backup = await createBackup(projectDir, draftRoot, DRAFT_ID, {
      now: new Date(2026, 8, 7, 10, 0, 0),
    });

    await simulateVectCutSave();
    assert.equal(await readFile(path.join(projectDir, 'draft_info.json'), 'utf8'), CONTENT_V2);

    const result = await restoreBackup(draftRoot, DRAFT_ID, backup.record!.version, {
      now: new Date(2026, 8, 7, 11, 0, 0),
    });

    assert.equal(result.version, backup.record!.version);
    assert.equal(await readFile(path.join(projectDir, 'draft_info.json'), 'utf8'), CONTENT_V1);
    // Assets the save destroyed come back too.
    assert.equal(
      await readFile(path.join(projectDir, 'assets', 'video', 'clip.mp4'), 'utf8'),
      'fake-media'
    );
  });

  test('snapshots the pre-restore state, so a restore is itself undoable', async () => {
    const backup = await createBackup(projectDir, draftRoot, DRAFT_ID, {
      now: new Date(2026, 8, 7, 10, 0, 0),
    });
    await atomicWriteFile(path.join(projectDir, 'draft_info.json'), CONTENT_V2);

    const result = await restoreBackup(draftRoot, DRAFT_ID, backup.record!.version, {
      now: new Date(2026, 8, 7, 11, 0, 0),
    });

    assert.ok(result.safetyBackup, 'a pre-restore snapshot should exist');
    assert.equal(
      await readFile(path.join(result.safetyBackup!.directory, 'draft_info.json'), 'utf8'),
      CONTENT_V2
    );
  });

  test("refuses a version that is not this project's own snapshot", async () => {
    await createBackup(projectDir, draftRoot, DRAFT_ID, { now: new Date(2026, 8, 7, 10, 0, 0) });
    await assert.rejects(restoreBackup(draftRoot, DRAFT_ID, '2020-01-01_00-00-00'), BackupError);
  });

  test('refuses traversal and arbitrary paths as a version or draft id', async () => {
    for (const [draftId, version] of [
      [DRAFT_ID, '../../etc'],
      [DRAFT_ID, '/etc/passwd'],
      [DRAFT_ID, 'latest'],
      [DRAFT_ID, '..'],
      ['../elsewhere', '2026-09-07_10-00-00'],
      ['a/b', '2026-09-07_10-00-00'],
    ] as Array<[string, string]>) {
      await assert.rejects(
        restoreBackup(draftRoot, draftId, version),
        (error: unknown) => error instanceof BackupError || error instanceof PathAccessError,
        `expected ${draftId} / ${version} to be rejected`
      );
    }
  });

  test('refuses a snapshot directory symlinked outside the backup tree', async () => {
    const outside = await canonicalizeRoot(await mkdtemp(path.join(os.tmpdir(), 'capcut-evil-')));
    await writeFile(path.join(outside, 'draft_info.json'), '{"evil":true}');
    const backupRoot = backupDirFor(draftRoot, DRAFT_ID);
    await mkdir(backupRoot, { recursive: true });
    await symlink(outside, path.join(backupRoot, '2020-01-01_00-00-00'));

    await assert.rejects(restoreBackup(draftRoot, DRAFT_ID, '2020-01-01_00-00-00'), BackupError);
    // The project is untouched.
    assert.equal(await readFile(path.join(projectDir, 'draft_info.json'), 'utf8'), CONTENT_V1);
  });
});
