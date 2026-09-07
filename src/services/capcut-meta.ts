/**
 * Repair the metadata CapCut uses to list a project.
 *
 * VectCutAPI builds every saved draft by copying a template directory, and
 * nothing in it ever rewrites `draft_meta_info.json`. So each saved draft ships
 * the template author's own values:
 *
 *   draft_fold_path  /Users/sunguannan/Movies/CapCut/.../com.lveditor.draft/0707
 *   draft_root_path  /Users/sunguannan/Movies/CapCut/.../com.lveditor.draft
 *   draft_id         989869B1-B560-489C-9C6F-4B444F24BF36   (identical every time)
 *   draft_name       0707
 *   tm_duration      0
 *
 * CapCut builds its Projects list from this file, so a draft that points at a
 * directory which does not exist on this machine -- and that shares one UUID
 * with every other draft -- does not show up. Saving is otherwise working: the
 * timeline in draft_info.json is correct, only its identity is wrong.
 *
 * This module rewrites the handful of fields that describe *where and what* the
 * project is, and touches nothing about its content.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWriteFile } from './backup.js';

const META_FILE = 'draft_meta_info.json';
const INFO_FILE = 'draft_info.json';

/**
 * A stable UUID for a draft, derived from its folder name.
 *
 * Deterministic on purpose: re-saving a draft must keep the same identity, or
 * CapCut accumulates a duplicate entry for every save. Different drafts get
 * different UUIDs, which is what the shared template UUID broke.
 */
export function draftUuid(draftId: string): string {
  const h = createHash('sha1').update(`capcut-mcp:${draftId}`).digest('hex');
  // Shape the digest as a v5-style UUID.
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    `${variant}${h.slice(18, 20)}`,
    h.slice(20, 32),
  ].join('-').toUpperCase();
}

export interface MetadataRepair {
  repaired: boolean;
  /** Field names that were changed. */
  changed: string[];
  /** Why nothing was changed, when `repaired` is false. */
  reason?: string;
}

async function fileExists(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

/**
 * Point a saved draft's metadata at where it actually lives.
 *
 * Never throws: the destructive save has already happened by the time this
 * runs, so a metadata problem is reported to the caller rather than raised as
 * a failure that would imply nothing was written.
 */
export async function repairDraftMetadata(
  projectDir: string,
  draftRoot: string,
  draftId: string,
  now: Date = new Date()
): Promise<MetadataRepair> {
  const metaPath = path.join(projectDir, META_FILE);
  if (!(await fileExists(metaPath))) {
    return { repaired: false, changed: [], reason: `${META_FILE} is not present in the saved draft` };
  }

  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return { repaired: false, changed: [], reason: `${META_FILE} is not valid JSON` };
  }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return { repaired: false, changed: [], reason: `${META_FILE} is not a JSON object` };
  }

  // CapCut records times in microseconds since the epoch.
  const micros = now.getTime() * 1000;

  // Mirror the real timeline duration so the Projects list shows a length.
  let duration = 0;
  try {
    const info = JSON.parse(await readFile(path.join(projectDir, INFO_FILE), 'utf8')) as {
      duration?: number;
    };
    if (typeof info.duration === 'number' && Number.isFinite(info.duration)) {
      duration = info.duration;
    }
  } catch {
    // Leave duration at 0; the timeline file is the backend's business.
  }

  const updates: Record<string, unknown> = {
    draft_fold_path: projectDir,
    draft_root_path: draftRoot,
    draft_name: draftId,
    draft_id: draftUuid(draftId),
    tm_draft_modified: micros,
    tm_duration: duration,
  };

  // Only claim a creation time if the template's is being carried over.
  if (typeof meta.tm_draft_create !== 'number' || meta.tm_draft_create <= 0) {
    updates.tm_draft_create = micros;
  }

  // A cover the file does not have leaves a broken thumbnail in the browser.
  const cover = typeof meta.draft_cover === 'string' ? meta.draft_cover : '';
  if (cover && !(await fileExists(path.join(projectDir, cover)))) {
    updates.draft_cover = '';
  }

  const changed: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (JSON.stringify(meta[key]) !== JSON.stringify(value)) {
      meta[key] = value;
      changed.push(key);
    }
  }

  if (changed.length === 0) {
    return { repaired: false, changed: [], reason: 'the metadata already pointed at this project' };
  }

  try {
    await atomicWriteFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  } catch (error) {
    return {
      repaired: false,
      changed: [],
      reason: `could not rewrite ${META_FILE}: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    };
  }

  return { repaired: true, changed: changed.sort() };
}
