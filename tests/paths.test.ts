/**
 * Requirement 6: every path is contained inside an approved directory after
 * full symlink resolution.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { before, describe } from 'node:test';
import {
  assertSafeSegment,
  assertWithinApprovedDirs,
  canonicalizeRoot,
  isContained,
  PathAccessError,
} from '../src/security/paths.js';

describe('path containment', () => {
  let approved: string;
  let outside: string;

  before(async () => {
    approved = await canonicalizeRoot(await mkdtemp(path.join(os.tmpdir(), 'capcut-approved-')));
    outside = await canonicalizeRoot(await mkdtemp(path.join(os.tmpdir(), 'capcut-outside-')));
    await mkdir(path.join(approved, 'projects', 'dfd_1'), { recursive: true });
    await writeFile(path.join(approved, 'projects', 'dfd_1', 'draft_content.json'), '{}');
    await writeFile(path.join(outside, 'secret.txt'), 'top secret');
  });

  test('accepts paths inside an approved root', async () => {
    const target = path.join(approved, 'projects', 'dfd_1', 'draft_content.json');
    assert.equal(await assertWithinApprovedDirs(target, [approved]), target);
    assert.equal(await assertWithinApprovedDirs(approved, [approved]), approved);
  });

  test('accepts a path that does not exist yet but would land inside', async () => {
    const target = path.join(approved, 'projects', 'dfd_1', 'not-created-yet.json');
    assert.equal(await assertWithinApprovedDirs(target, [approved]), target);
  });

  test('rejects ../ traversal out of the approved root', async () => {
    for (const candidate of [
      path.join(approved, '..'),
      path.join(approved, '..', 'etc', 'passwd'),
      path.join(approved, 'projects', '..', '..', 'passwd'),
      `${approved}/projects/dfd_1/../../../../etc/passwd`,
    ]) {
      await assert.rejects(
        assertWithinApprovedDirs(candidate, [approved]),
        PathAccessError,
        `expected ${candidate} to be rejected`
      );
    }
  });

  test('rejects a symlink that escapes the approved root', async () => {
    const escape = path.join(approved, 'escape-link');
    await symlink(outside, escape);

    // The link itself and anything under it resolve outside the root.
    await assert.rejects(assertWithinApprovedDirs(escape, [approved]), PathAccessError);
    await assert.rejects(
      assertWithinApprovedDirs(path.join(escape, 'secret.txt'), [approved]),
      PathAccessError
    );
  });

  test('rejects a symlink whose parent directory escapes', async () => {
    const nested = path.join(approved, 'nested');
    await mkdir(nested, { recursive: true });
    await symlink(path.join(outside, 'secret.txt'), path.join(nested, 'linked-secret'));
    await assert.rejects(
      assertWithinApprovedDirs(path.join(nested, 'linked-secret'), [approved]),
      PathAccessError
    );
  });

  test('rejects relative paths, tildes and NUL bytes', async () => {
    for (const candidate of ['relative/path', './x', '../x', '~/Movies/clip.mp4', 'a\0b', '']) {
      await assert.rejects(
        assertWithinApprovedDirs(candidate, [approved]),
        PathAccessError,
        `expected ${JSON.stringify(candidate)} to be rejected`
      );
    }
  });

  test('rejects everything when no root is approved', async () => {
    await assert.rejects(assertWithinApprovedDirs('/tmp/anything', []), PathAccessError);
  });

  test('a sibling directory sharing a name prefix is not contained', () => {
    assert.equal(isContained('/a/approved-evil/x', '/a/approved'), false);
    assert.equal(isContained('/a/approved/x', '/a/approved'), true);
    assert.equal(isContained('/a/approved', '/a/approved'), true);
  });

  test('canonicalizeRoot refuses relative or missing roots', async () => {
    await assert.rejects(canonicalizeRoot('relative'), PathAccessError);
    await assert.rejects(canonicalizeRoot('/definitely/not/here/12345'), PathAccessError);
  });

  test('identifier segments cannot contain separators or traversal', () => {
    assert.equal(assertSafeSegment('dfd_abc-123.v2', 'draft id'), 'dfd_abc-123.v2');
    for (const value of ['..', '../x', 'a/b', 'a\\b', '/abs', '.hidden', '', 'a\0b', 'x/../y']) {
      assert.throws(
        () => assertSafeSegment(value, 'draft id'),
        PathAccessError,
        `expected ${JSON.stringify(value)} to be rejected`
      );
    }
  });
});
