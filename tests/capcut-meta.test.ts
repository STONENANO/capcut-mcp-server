/**
 * A saved draft must identify itself as living where it actually lives.
 *
 * VectCutAPI copies its draft template verbatim, so without this repair every
 * saved project claims the template author's paths, shares one UUID, is named
 * "0707" and reports a zero duration -- and CapCut, which builds its Projects
 * list from that file, does not show it.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { beforeEach, describe } from 'node:test';
import { draftUuid, repairDraftMetadata } from '../src/services/capcut-meta.js';

/** The values VectCutAPI's template actually ships with. */
const TEMPLATE_META = {
  draft_fold_path: '/Users/sunguannan/Movies/CapCut/User Data/Projects/com.lveditor.draft/0707',
  draft_root_path: '/Users/sunguannan/Movies/CapCut/User Data/Projects/com.lveditor.draft',
  draft_id: '989869B1-B560-489C-9C6F-4B444F24BF36',
  draft_name: '0707',
  draft_cover: 'draft_cover.jpg',
  tm_draft_create: 1751876007857286,
  tm_draft_modified: 1751876105604683,
  tm_duration: 0,
  draft_is_invisible: false,
};

const DRAFT_ID = 'dfd_cat_1_abc';
let draftRoot: string;
let projectDir: string;

async function makeSavedDraft(meta: object = TEMPLATE_META, duration = 8_000_000): Promise<void> {
  draftRoot = await mkdtemp(path.join(os.tmpdir(), 'capcut-meta-'));
  projectDir = path.join(draftRoot, DRAFT_ID);
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, 'draft_meta_info.json'), JSON.stringify(meta, null, 2));
  await writeFile(path.join(projectDir, 'draft_info.json'), JSON.stringify({ duration }));
}

const readMeta = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path.join(projectDir, 'draft_meta_info.json'), 'utf8'));

describe('draftUuid', () => {
  test('is stable for one draft and distinct between drafts', () => {
    assert.equal(draftUuid('dfd_a'), draftUuid('dfd_a'));
    assert.notEqual(draftUuid('dfd_a'), draftUuid('dfd_b'));
  });

  test('looks like a UUID and is not the template UUID', () => {
    const id = draftUuid(DRAFT_ID);
    assert.match(id, /^[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
    assert.notEqual(id, TEMPLATE_META.draft_id);
  });
});

describe('repairDraftMetadata', () => {
  beforeEach(() => makeSavedDraft());

  test("replaces the template's foreign paths and shared identity", async () => {
    const result = await repairDraftMetadata(projectDir, draftRoot, DRAFT_ID);
    assert.equal(result.repaired, true);

    const meta = await readMeta();
    assert.equal(meta.draft_fold_path, projectDir);
    assert.equal(meta.draft_root_path, draftRoot);
    assert.equal(meta.draft_name, DRAFT_ID);
    assert.equal(meta.draft_id, draftUuid(DRAFT_ID));
    assert.equal(meta.tm_duration, 8_000_000);

    // No path may still point at the template author's machine.
    assert.doesNotMatch(JSON.stringify(meta), /sunguannan/);
  });

  test('leaves unrelated fields alone', async () => {
    await repairDraftMetadata(projectDir, draftRoot, DRAFT_ID);
    const meta = await readMeta();
    assert.equal(meta.draft_is_invisible, false);
    assert.equal(Object.keys(meta).length, Object.keys(TEMPLATE_META).length);
  });

  test('keeps a real creation time but refreshes the modified time', async () => {
    const before = Date.now() * 1000;
    await repairDraftMetadata(projectDir, draftRoot, DRAFT_ID);
    const meta = await readMeta();
    assert.equal(meta.tm_draft_create, TEMPLATE_META.tm_draft_create);
    assert.ok((meta.tm_draft_modified as number) >= before);
  });

  test('sets a creation time when the template has none', async () => {
    await makeSavedDraft({ ...TEMPLATE_META, tm_draft_create: 0 });
    await repairDraftMetadata(projectDir, draftRoot, DRAFT_ID);
    assert.ok(((await readMeta()).tm_draft_create as number) > 0);
  });

  test('clears a cover reference the draft does not have', async () => {
    await repairDraftMetadata(projectDir, draftRoot, DRAFT_ID);
    assert.equal((await readMeta()).draft_cover, '');
  });

  test('keeps a cover reference that resolves', async () => {
    await writeFile(path.join(projectDir, 'draft_cover.jpg'), 'jpeg');
    await repairDraftMetadata(projectDir, draftRoot, DRAFT_ID);
    assert.equal((await readMeta()).draft_cover, 'draft_cover.jpg');
  });

  test('is idempotent: a second run finds nothing to change', async () => {
    assert.equal((await repairDraftMetadata(projectDir, draftRoot, DRAFT_ID)).repaired, true);
    const second = await repairDraftMetadata(projectDir, draftRoot, DRAFT_ID, new Date(0));
    // Only the modified timestamp may differ, and a fixed clock removes that.
    assert.deepEqual(second.changed.filter(f => f !== 'tm_draft_modified'), []);
  });

  test('reports rather than throws when the metadata is missing or corrupt', async () => {
    await makeSavedDraft();
    const empty = await mkdtemp(path.join(os.tmpdir(), 'capcut-nometa-'));
    const missing = await repairDraftMetadata(empty, empty, DRAFT_ID);
    assert.equal(missing.repaired, false);
    assert.match(missing.reason!, /not present/);

    await writeFile(path.join(projectDir, 'draft_meta_info.json'), '{ not json');
    const corrupt = await repairDraftMetadata(projectDir, draftRoot, DRAFT_ID);
    assert.equal(corrupt.repaired, false);
    assert.match(corrupt.reason!, /not valid JSON/);

    await writeFile(path.join(projectDir, 'draft_meta_info.json'), '[]');
    const wrongShape = await repairDraftMetadata(projectDir, draftRoot, DRAFT_ID);
    assert.equal(wrongShape.repaired, false);
    assert.match(wrongShape.reason!, /not a JSON object/);
  });

  test('still repairs paths when the timeline duration cannot be read', async () => {
    await writeFile(path.join(projectDir, 'draft_info.json'), 'not json');
    const result = await repairDraftMetadata(projectDir, draftRoot, DRAFT_ID);
    assert.equal(result.repaired, true);
    assert.equal((await readMeta()).draft_fold_path, projectDir);
  });
});
