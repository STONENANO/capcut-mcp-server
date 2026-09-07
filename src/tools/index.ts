/**
 * MCP tool registration.
 *
 * Every tool here maps 1:1 onto a VectCutAPI route that actually exists, with
 * the parameter names that route actually reads. Media references pass through
 * the SSRF guard, local paths through the containment guard, and the one tool
 * that writes to the user's CapCut project folder takes a backup first.
 *
 * There is deliberately no tool that runs a command, evaluates code, reads an
 * arbitrary file, or lets the caller choose a backend host.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerConfig } from '../config.js';
import { ASSET_CATALOGUES, CHARACTER_LIMIT, type AssetCatalogue } from '../constants.js';
import {
  AddAudioSchema,
  AddEffectSchema,
  AddImageSchema,
  AddKeyframeSchema,
  AddStickerSchema,
  AddSubtitleSchema,
  AddTextSchema,
  AddVideoSchema,
  CreateDraftSchema,
  ListAssetTypesSchema,
  RestoreBackupSchema,
  SaveDraftSchema,
  type AddAudioInput,
  type AddEffectInput,
  type AddImageInput,
  type AddKeyframeInput,
  type AddStickerInput,
  type AddSubtitleInput,
  type AddTextInput,
  type AddVideoInput,
  type CreateDraftInput,
  type ListAssetTypesInput,
  type RestoreBackupInput,
  type SaveDraftInput,
} from '../schemas/index.js';
import {
  BACKEND_ENDPOINTS,
  type BackendEndpoint,
  type CapCutApiClient,
} from '../services/api-client.js';
import { createBackup, listBackups, resolveProjectDir, restoreBackup } from '../services/backup.js';
import {
  validateMediaReference,
  type MediaGuardOptions,
} from '../security/media-url.js';
import { ToolKind, type ResponseFormat } from '../types.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export interface ToolContext {
  client: CapCutApiClient;
  config: ServerConfig;
}

// --------------------------------------------------------------------------
// Result shaping
// --------------------------------------------------------------------------

function truncate(text: string): string {
  return text.length <= CHARACTER_LIMIT
    ? text
    : `${text.slice(0, CHARACTER_LIMIT)}\n\n[truncated at ${CHARACTER_LIMIT} characters]`;
}

function ok(
  summary: string,
  payload: unknown,
  format: ResponseFormat
): ToolResult {
  const structured =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : { output: payload };

  const text =
    format === 'json'
      ? JSON.stringify(payload, null, 2)
      : `${summary}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;

  return { content: [{ type: 'text', text: truncate(text) }], structuredContent: structured };
}

/**
 * Turn a thrown error into a tool result.
 *
 * Only the error's own message is surfaced. Stack traces, the environment, and
 * request bodies are deliberately not included: the message is written to be
 * actionable on its own, and everything else risks leaking local paths or
 * project content into the transcript.
 */
function fail(error: unknown): ToolResult {
  const message =
    error instanceof Error && error.message ? error.message : 'The operation failed';
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/** Drop keys the backend does not read, and any `undefined` from optional fields. */
function backendBody(input: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'response_format' || value === undefined) continue;
    body[key] = value;
  }
  return body;
}

// --------------------------------------------------------------------------
// Guards
// --------------------------------------------------------------------------

function mediaGuardOptions(config: ServerConfig): MediaGuardOptions {
  return {
    approvedMediaDirs: config.mediaDirs,
    maxDownloadBytes: config.maxDownloadBytes,
    requestTimeoutMs: config.requestTimeoutMs,
    preflight: config.mediaPreflight,
    maxRedirects: config.maxRedirects,
  };
}

/** Validate one media reference and return the value to send to the backend. */
async function guardMedia(value: string, config: ServerConfig): Promise<string> {
  const reference = await validateMediaReference(value, mediaGuardOptions(config));
  return reference.value;
}

/** Inline SRT text is recognised by its cue arrow, and needs no network check. */
function isInlineSrt(value: string): boolean {
  return value.includes('-->') && /\r?\n/.test(value);
}

function requireDraftDir(config: ServerConfig): string {
  if (!config.draftDir) {
    throw new Error(
      'CAPCUT_DRAFT_DIR is not set, so this server cannot locate (or back up) your CapCut ' +
        'projects. Point it at your CapCut "Draft Content" directory and restart the server.'
    );
  }
  return config.draftDir;
}

// --------------------------------------------------------------------------
// Registration
// --------------------------------------------------------------------------

const MUTATING_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Prefix every description with its read/write classification. */
function describe(kind: ToolKind, body: string): string {
  return `[${kind}] ${body.trim()}`;
}

export function registerTools(server: McpServer, context: ToolContext): void {
  const { client, config } = context;

  /** Shared shape for the simple "validate, forward, report" tools. */
  const forward = async <T extends { response_format: ResponseFormat }>(
    endpoint: BackendEndpoint,
    input: T,
    summary: string,
    transform?: (input: T) => Promise<Record<string, unknown>> | Record<string, unknown>
  ): Promise<ToolResult> => {
    try {
      const body = transform ? await transform(input) : backendBody(input);
      const output = await client.post(endpoint, body);
      return ok(summary, output, input.response_format);
    } catch (error) {
      return fail(error);
    }
  };

  // ---- 1. Create draft (MUTATING: allocates a new draft) -------------------
  server.registerTool(
    'capcut_create_draft',
    {
      title: 'Create CapCut Draft',
      description: describe(
        ToolKind.MUTATING,
        `Create a new, empty CapCut draft and return its draft_id.

Creates in-memory state on the local VectCutAPI; nothing is written to your CapCut
projects folder until capcut_save_draft is called.

Note: VectCutAPI derives frame rate from the source media, so there is no fps
parameter. Only the canvas size is set here.

Returns: { "draft_id": string, "draft_url": string }`
      ),
      inputSchema: CreateDraftSchema,
      annotations: MUTATING_ANNOTATIONS,
    },
    async (input: CreateDraftInput) =>
      forward(BACKEND_ENDPOINTS.createDraft, input, '## Draft created')
  );

  // ---- 2. Add video -------------------------------------------------------
  server.registerTool(
    'capcut_add_video',
    {
      title: 'Add Video to Draft',
      description: describe(
        ToolKind.MUTATING,
        `Add a video clip to a draft's timeline.

'start'/'end' trim the SOURCE clip; 'target_start' is where it lands on the
timeline. Set end=0 to use the clip to its end.

video_url must be an https:// URL or an absolute path inside an approved media
directory (CAPCUT_MEDIA_DIRS). Private, loopback and metadata destinations are
rejected before the backend ever fetches it.

Transitions attach to the EARLIER clip of a pair on the same track. Setting one
on the later clip is accepted but renders nothing.`
      ),
      inputSchema: AddVideoSchema,
      annotations: MUTATING_ANNOTATIONS,
    },
    async (input: AddVideoInput) =>
      forward(BACKEND_ENDPOINTS.addVideo, input, '## Video added', async raw => ({
        ...backendBody(raw),
        video_url: await guardMedia(raw.video_url, config),
      }))
  );

  // ---- 3. Add audio -------------------------------------------------------
  server.registerTool(
    'capcut_add_audio',
    {
      title: 'Add Audio to Draft',
      description: describe(
        ToolKind.MUTATING,
        `Add an audio track to a draft's timeline.

'start'/'end' trim the SOURCE audio; 'target_start' is the timeline position.

Note: VectCutAPI's /add_audio has no fade-in/fade-out parameters, so none are
offered here. Use capcut_add_keyframe on the 'volume' property to ramp levels.`
      ),
      inputSchema: AddAudioSchema,
      annotations: MUTATING_ANNOTATIONS,
    },
    async (input: AddAudioInput) =>
      forward(BACKEND_ENDPOINTS.addAudio, input, '## Audio added', async raw => ({
        ...backendBody(raw),
        audio_url: await guardMedia(raw.audio_url, config),
      }))
  );

  // ---- 4. Add text --------------------------------------------------------
  server.registerTool(
    'capcut_add_text',
    {
      title: 'Add Text Overlay',
      description: describe(
        ToolKind.MUTATING,
        `Add a styled text overlay to a draft.

Position uses CapCut's normalised canvas coordinates via transform_x/transform_y
(0,0 is centre; roughly -1..1 spans the canvas) -- not 0..1 pixel fractions.

font_size is CapCut's own scale (about 1-100, default 8), not points.

A background is only drawn when background_alpha > 0. Animation names come from
capcut_list_asset_types(category="text_intro" / "text_outro").

Two overlapping captions need two different track_name values: CapCut rejects a
segment that overlaps another on the same track.`
      ),
      inputSchema: AddTextSchema,
      annotations: MUTATING_ANNOTATIONS,
    },
    async (input: AddTextInput) => forward(BACKEND_ENDPOINTS.addText, input, '## Text added')
  );

  // ---- 5. Add image -------------------------------------------------------
  server.registerTool(
    'capcut_add_image',
    {
      title: 'Add Image Overlay',
      description: describe(
        ToolKind.MUTATING,
        `Add an image overlay to a draft.

Position uses transform_x/transform_y and size uses scale_x/scale_y, matching
CapCut's own model. VectCutAPI's /add_image has no rotation parameter, so none is
offered; use capcut_add_keyframe on 'rotation' instead.

image_url is validated exactly like video_url. Transitions attach to the EARLIER
clip of a pair on the same track; on the later clip they render nothing.`
      ),
      inputSchema: AddImageSchema,
      annotations: MUTATING_ANNOTATIONS,
    },
    async (input: AddImageInput) =>
      forward(BACKEND_ENDPOINTS.addImage, input, '## Image added', async raw => ({
        ...backendBody(raw),
        image_url: await guardMedia(raw.image_url, config),
      }))
  );

  // ---- 6. Add subtitle ----------------------------------------------------
  server.registerTool(
    'capcut_add_subtitle',
    {
      title: 'Add Subtitles',
      description: describe(
        ToolKind.MUTATING,
        `Add SRT subtitles to a draft.

The 'srt' field takes inline SRT text (preferred), an https:// URL, or an
absolute path inside an approved media directory. URLs and paths are validated
before the backend fetches them.

A background is only drawn when background_alpha > 0.`
      ),
      inputSchema: AddSubtitleSchema,
      annotations: MUTATING_ANNOTATIONS,
    },
    async (input: AddSubtitleInput) =>
      forward(BACKEND_ENDPOINTS.addSubtitle, input, '## Subtitles added', async raw => ({
        ...backendBody(raw),
        // The backend field is `srt`, not `srt_content`.
        srt: isInlineSrt(raw.srt) ? raw.srt : await guardMedia(raw.srt, config),
      }))
  );

  // ---- 7. Add keyframes ---------------------------------------------------
  server.registerTool(
    'capcut_add_keyframe',
    {
      title: 'Add Keyframe Animation',
      description: describe(
        ToolKind.MUTATING,
        `Animate track properties with keyframes.

property_types, times and values are PARALLEL arrays -- one entry each per
keyframe -- and must all be the same length. A property animated at two times
appears twice. Targets VectCutAPI's /add_video_keyframe route.

Example -- fade in over 2s:
  property_types=["alpha", "alpha"], times=[0, 2], values=["0.0", "1.0"]`
      ),
      inputSchema: AddKeyframeSchema,
      annotations: MUTATING_ANNOTATIONS,
    },
    async (input: AddKeyframeInput) => {
      // The backend enforces this too, but it reports the failure only after the
      // draft has been touched; catching it here keeps the call a no-op.
      const lengths = new Set([
        input.property_types.length,
        input.times.length,
        input.values.length,
      ]);
      if (lengths.size !== 1) {
        return fail(
          new Error(
            `property_types (${input.property_types.length}), times (${input.times.length}) and ` +
              `values (${input.values.length}) must all have the same length: they are parallel ` +
              'arrays of (property, time, value) triples, one entry per keyframe'
          )
        );
      }
      return forward(BACKEND_ENDPOINTS.addKeyframe, input, '## Keyframes added');
    }
  );

  // ---- 8. Add effect ------------------------------------------------------
  server.registerTool(
    'capcut_add_effect',
    {
      title: 'Add Visual Effect',
      description: describe(
        ToolKind.MUTATING,
        `Apply a CapCut visual effect over a time range.

'effect_type' must be an exact name from
capcut_list_asset_types(category="video_scene_effect") or ("video_character_effect")
-- CapCut matches these by enum name, so invented names such as "blur_filter" fail.

'params' are the effect's own sliders, each 0-100.`
      ),
      inputSchema: AddEffectSchema,
      annotations: MUTATING_ANNOTATIONS,
    },
    async (input: AddEffectInput) => forward(BACKEND_ENDPOINTS.addEffect, input, '## Effect added')
  );

  // ---- 9. Add sticker -----------------------------------------------------
  server.registerTool(
    'capcut_add_sticker',
    {
      title: 'Add Sticker',
      description: describe(
        ToolKind.MUTATING,
        `Add a CapCut sticker to a draft.

Takes 'sticker_id' -- a CapCut sticker RESOURCE ID, not an image URL. VectCutAPI
references stickers from CapCut's own library; to overlay your own artwork use
capcut_add_image instead.`
      ),
      inputSchema: AddStickerSchema,
      annotations: MUTATING_ANNOTATIONS,
    },
    async (input: AddStickerInput) =>
      forward(BACKEND_ENDPOINTS.addSticker, input, '## Sticker added')
  );

  // ---- 10. Save draft (writes to the CapCut projects folder) --------------
  server.registerTool(
    'capcut_save_draft',
    {
      title: 'Save Draft to CapCut',
      description: describe(
        ToolKind.MUTATING,
        `Write the draft into your CapCut projects folder (CAPCUT_DRAFT_DIR).

This is the only tool that touches files CapCut itself reads. Before writing, the
VectCutAPI DELETES the existing project directory and rebuilds it when it saves,
so the whole project is snapshotted first to
<draft dir>/.smartcut_backups/<draft id>/<timestamp>/ -- outside the project, so
the save cannot destroy it. If that snapshot cannot be taken, the save is not
attempted. Recover one with capcut_restore_backup. Snapshots within
CAPCUT_BACKUP_COALESCE_SECONDS of each other are coalesced into one.`
      ),
      inputSchema: SaveDraftSchema,
      annotations: { ...MUTATING_ANNOTATIONS, destructiveHint: true },
    },
    async (input: SaveDraftInput) => {
      try {
        const draftDir = requireDraftDir(config);
        const projectDir = await resolveProjectDir(input.draft_id, draftDir);

        // VectCutAPI deletes the existing project directory before rewriting
        // it, so this snapshot -- taken outside the project -- is the only
        // copy of the current state once the save begins. If it cannot be
        // taken, the save does not happen.
        const backup = await createBackup(projectDir, draftDir, input.draft_id, {
          coalesceSeconds: config.backupCoalesceSeconds,
          maxBytes: config.maxBackupBytes,
        });

        const output = await client.post(BACKEND_ENDPOINTS.saveDraft, {
          draft_id: input.draft_id,
          draft_folder: draftDir,
        });

        const payload = {
          saved: output,
          backup: backup.created
            ? {
                created: true,
                version: backup.record?.version,
                file_count: backup.record?.files.length,
                bytes: backup.record?.bytes,
              }
            : { created: false, reason: backup.skippedReason },
        };
        const summary = backup.created
          ? `## Draft saved\n\nBacked up to \`${backup.record?.version}\` before writing.`
          : `## Draft saved\n\nNo new backup: ${backup.skippedReason}.`;
        return ok(summary, payload, input.response_format);
      } catch (error) {
        return fail(error);
      }
    }
  );

  // ---- 11. List asset catalogues (READ-ONLY) ------------------------------
  server.registerTool(
    'capcut_list_asset_types',
    {
      title: 'List CapCut Asset Names',
      description: describe(
        ToolKind.READ_ONLY,
        `List the exact asset names CapCut accepts for a given category.

Call this before capcut_add_effect, or before passing any transition, font or
animation name -- CapCut matches these by exact name and rejects anything else.

Categories: ${Object.keys(ASSET_CATALOGUES).join(', ')}`
      ),
      inputSchema: ListAssetTypesSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input: ListAssetTypesInput) => {
      try {
        const endpoint = ASSET_CATALOGUES[input.category as AssetCatalogue] as BackendEndpoint;
        const output = await client.get(endpoint);
        return ok(`## ${input.category} names`, output, input.response_format);
      } catch (error) {
        return fail(error);
      }
    }
  );

  // ---- 12. Restore a backup ----------------------------------------------
  server.registerTool(
    'capcut_restore_backup',
    {
      title: 'Restore CapCut Project Backup',
      description: describe(
        ToolKind.MUTATING,
        `List or restore the automatic backups of a CapCut project.

Omit 'version' to list available versions without changing anything. Supply a
'version' to restore that snapshot's metadata over the project.

Only backups belonging to the named project inside CAPCUT_DRAFT_DIR can be
restored: there is no way to name an arbitrary source or destination path. The
pre-restore state is itself snapshotted first, so a restore is undoable.`
      ),
      inputSchema: RestoreBackupSchema,
      annotations: { ...MUTATING_ANNOTATIONS, destructiveHint: true },
    },
    async (input: RestoreBackupInput) => {
      try {
        const draftDir = requireDraftDir(config);
        // Validates the draft id and its containment before anything else runs.
        await resolveProjectDir(input.draft_id, draftDir);

        if (!input.version) {
          const records = await listBackups(draftDir, input.draft_id);
          return ok(
            records.length === 0
              ? `## No backups\n\nNo snapshots exist yet for \`${input.draft_id}\`.`
              : `## ${records.length} backup(s) for \`${input.draft_id}\``,
            {
              draft_id: input.draft_id,
              versions: records.map(r => ({
                version: r.version,
                created_at: r.createdAt.toISOString(),
                file_count: r.files.length,
                bytes: r.bytes,
              })),
            },
            input.response_format
          );
        }

        const result = await restoreBackup(draftDir, input.draft_id, input.version, {
          maxBytes: config.maxBackupBytes,
        });
        return ok(
          `## Restored \`${result.version}\``,
          {
            draft_id: input.draft_id,
            restored_version: result.version,
            restored_file_count: result.restoredFiles.length,
            pre_restore_backup: result.safetyBackup?.version ?? null,
          },
          input.response_format
        );
      } catch (error) {
        return fail(error);
      }
    }
  );
}
