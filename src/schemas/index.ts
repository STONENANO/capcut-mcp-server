/**
 * Zod schemas for every MCP tool input.
 *
 * Two rules run through this file:
 *
 *  1. Field names mirror VectCutAPI's actual request bodies. A field the
 *     backend does not read is not offered, so a caller can never set something
 *     that is silently dropped.
 *  2. Every numeric is bounded and every object is `.strict()`. Unknown keys are
 *     an error rather than something quietly forwarded to the backend.
 */

import { z } from 'zod';
import { ASSET_CATALOGUES, DEFAULT_CANVAS } from '../constants.js';

/** Output format for a tool result. */
export const ResponseFormatSchema = z
  .enum(['markdown', 'json'])
  .default('markdown')
  .describe("Output format: 'markdown' for a readable summary, 'json' for the raw backend payload");

/**
 * A media reference: an https URL, or an absolute path inside a directory
 * listed in CAPCUT_MEDIA_DIRS. Content is validated for real by the SSRF/path
 * guards at call time; this only bounds the string.
 */
const MediaRefSchema = z
  .string()
  .min(1, 'A media reference is required')
  .max(4096, 'Media reference is too long')
  .refine(v => !v.includes('\0'), 'Media reference must not contain a NUL byte')
  .describe(
    'An https:// URL, or an absolute path to a file inside an approved media directory. ' +
      'http://, file://, ftp:// and other schemes are rejected, as are private, loopback, ' +
      'link-local and cloud-metadata destinations.'
  );

const DraftIdSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    'Draft ID must be 1-128 characters of letters, digits, dot, dash or underscore'
  )
  .describe('The draft ID returned by capcut_create_draft');

const TrackNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'Track name must be 1-64 alphanumeric/._- characters')
  .describe(
    'Timeline track name; segments sharing a name land on the same track. ' +
      'Segments on ONE track may not overlap in time -- CapCut rejects the second ' +
      'one. To show two things at once, put them on different track names.'
  );

/** CapCut asset names come from the backend catalogues and may be non-ASCII. */
const AssetNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(v => !/[\0\n\r]/.test(v), 'Asset name must not contain control characters')
  .describe('Exact asset name from capcut_list_asset_types');

/**
 * A CapCut transition, attached to the segment the cut happens AFTER.
 *
 * VectCutAPI accepts this on any segment and validates only the name: put it on
 * the later clip, or on a clip with nothing after it on the same track, and the
 * transition is written into the project but renders nothing. There is no
 * warning, so the description has to carry the rule.
 */
const TransitionSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(v => !/[\0\n\r]/.test(v), 'Transition name must not contain control characters')
  .describe(
    'Transition name from capcut_list_asset_types(category="transition"). ' +
      'Set it on the EARLIER of the two clips -- it plays between this segment and ' +
      'the next one on the SAME track. On the later clip, or on a clip nothing ' +
      'follows, it is silently ignored.'
  );

const HexColorSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a 6-digit hex color such as #FFFFFF');

const SecondsSchema = z.number().finite().min(0).max(86_400);
const UnitIntervalSchema = z.number().finite().min(0).max(1);
/** CapCut normalises canvas position to roughly -1..1; allow a little overscan. */
const TransformSchema = z.number().finite().min(-10).max(10);
const ScaleSchema = z.number().finite().min(0.01).max(20);

const CanvasShape = {
  width: z.number().int().min(360).max(4096).default(DEFAULT_CANVAS.width)
    .describe('Canvas width in pixels'),
  height: z.number().int().min(360).max(4096).default(DEFAULT_CANVAS.height)
    .describe('Canvas height in pixels'),
};

const CommonShape = { response_format: ResponseFormatSchema };

// --------------------------------------------------------------------------
// Tool input shapes. Exported as raw shapes (what registerTool wants) plus a
// strict ZodObject for standalone validation and tests.
// --------------------------------------------------------------------------

const CreateDraftShape = {
  ...CanvasShape,
  ...CommonShape,
};

const AddVideoShape = {
  draft_id: DraftIdSchema,
  video_url: MediaRefSchema,
  start: SecondsSchema.default(0).describe('Trim start within the source clip, in seconds'),
  end: SecondsSchema.default(0)
    .describe('Trim end within the source clip, in seconds; 0 means "to the end of the clip"'),
  target_start: SecondsSchema.default(0)
    .describe('Where the clip is placed on the timeline, in seconds'),
  duration: SecondsSchema.optional()
    .describe('Override the source duration when the backend cannot probe it'),
  speed: z.number().finite().min(0.1).max(10).default(1)
    .describe('Playback speed multiplier'),
  volume: z.number().finite().min(0).max(2).default(1)
    .describe('Audio volume; 1.0 is unchanged, 2.0 doubles the level'),
  transform_x: TransformSchema.default(0).describe('Horizontal offset; 0 is centred'),
  transform_y: TransformSchema.default(0).describe('Vertical offset; 0 is centred'),
  scale_x: ScaleSchema.default(1).describe('Horizontal scale multiplier'),
  scale_y: ScaleSchema.default(1).describe('Vertical scale multiplier'),
  track_name: TrackNameSchema.default('video_main'),
  relative_index: z.number().int().min(-100).max(100).default(0)
    .describe('Render order among tracks; higher draws on top'),
  transition: TransitionSchema.optional(),
  transition_duration: z.number().finite().min(0).max(10).default(0.5)
    .describe('Transition length in seconds'),
  background_blur: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional()
    .describe('Blurred-background strength: 1 light, 2 medium, 3 strong, 4 maximum'),
  ...CanvasShape,
  ...CommonShape,
};

const AddAudioShape = {
  draft_id: DraftIdSchema,
  audio_url: MediaRefSchema,
  start: SecondsSchema.default(0).describe('Trim start within the source audio, in seconds'),
  end: SecondsSchema.optional()
    .describe('Trim end within the source audio, in seconds; omit for the whole file'),
  target_start: SecondsSchema.default(0)
    .describe('Where the audio is placed on the timeline, in seconds'),
  duration: SecondsSchema.optional().describe('Override the source duration'),
  speed: z.number().finite().min(0.1).max(10).default(1).describe('Playback speed multiplier'),
  volume: z.number().finite().min(0).max(2).default(1).describe('Volume; 1.0 is unchanged'),
  track_name: TrackNameSchema.default('audio_main'),
  effect_type: AssetNameSchema.optional()
    .describe('Audio effect from capcut_list_asset_types(category="audio_effect")'),
  effect_params: z.array(z.number().finite().min(0).max(100)).max(16).optional()
    .describe('Audio effect parameters, each 0-100'),
  ...CanvasShape,
  ...CommonShape,
};

const AddTextShape = {
  draft_id: DraftIdSchema,
  text: z.string().min(1).max(2000).describe('Text content to display'),
  start: SecondsSchema.describe('Timeline start, in seconds'),
  end: SecondsSchema.describe('Timeline end, in seconds'),
  font: AssetNameSchema.optional()
    .describe('Font name from capcut_list_asset_types(category="font")'),
  font_size: z.number().finite().min(1).max(100).default(8)
    .describe("CapCut's own font scale (not points); 8 is the editor default"),
  font_color: HexColorSchema.default('#FFFFFF'),
  font_alpha: UnitIntervalSchema.default(1).describe('Text opacity'),
  transform_x: TransformSchema.default(0).describe('Horizontal offset; 0 is centred'),
  transform_y: TransformSchema.default(0).describe('Vertical offset; 0 is centred'),
  vertical: z.boolean().default(false).describe('Render the text vertically'),
  border_color: HexColorSchema.default('#000000'),
  border_alpha: UnitIntervalSchema.default(1),
  border_width: z.number().finite().min(0).max(100).default(0)
    .describe('Outline width; 0 disables the outline'),
  background_color: HexColorSchema.default('#000000'),
  background_alpha: UnitIntervalSchema.default(0)
    .describe('Background opacity; 0 means no background is drawn'),
  // CapCut has exactly two background styles, and the draft library maps them
  // with `(0, 2)[style - 1]`. Passing 0 indexes [-1] and silently selects style
  // 2, so the accepted range starts at 1.
  background_style: z.number().int().min(1).max(2).default(1)
    .describe('Text background style: 1 or 2 (CapCut offers no others)'),
  background_round_radius: UnitIntervalSchema.default(0),
  shadow_enabled: z.boolean().default(false),
  shadow_color: HexColorSchema.default('#000000'),
  shadow_alpha: UnitIntervalSchema.default(0.9),
  shadow_angle: z.number().finite().min(-180).max(180).default(-45),
  shadow_distance: z.number().finite().min(0).max(100).default(5),
  shadow_smoothing: UnitIntervalSchema.default(0.15),
  intro_animation: AssetNameSchema.optional()
    .describe('Entrance animation from capcut_list_asset_types(category="text_intro")'),
  intro_duration: z.number().finite().min(0).max(10).default(0.5),
  outro_animation: AssetNameSchema.optional()
    .describe('Exit animation from capcut_list_asset_types(category="text_outro")'),
  outro_duration: z.number().finite().min(0).max(10).default(0.5),
  track_name: TrackNameSchema.default('text_main'),
  ...CanvasShape,
  ...CommonShape,
};

const AddImageShape = {
  draft_id: DraftIdSchema,
  image_url: MediaRefSchema,
  start: SecondsSchema.default(0).describe('Timeline start, in seconds'),
  end: SecondsSchema.default(3).describe('Timeline end, in seconds'),
  transform_x: TransformSchema.default(0).describe('Horizontal offset; 0 is centred'),
  transform_y: TransformSchema.default(0).describe('Vertical offset; 0 is centred'),
  scale_x: ScaleSchema.default(1).describe('Horizontal scale multiplier'),
  scale_y: ScaleSchema.default(1).describe('Vertical scale multiplier'),
  track_name: TrackNameSchema.default('image_main'),
  relative_index: z.number().int().min(-100).max(100).default(0),
  intro_animation: AssetNameSchema.optional()
    .describe('Entrance animation from capcut_list_asset_types(category="intro_animation")'),
  intro_animation_duration: z.number().finite().min(0).max(10).default(0.5),
  outro_animation: AssetNameSchema.optional()
    .describe('Exit animation from capcut_list_asset_types(category="outro_animation")'),
  outro_animation_duration: z.number().finite().min(0).max(10).default(0.5),
  transition: TransitionSchema.optional(),
  transition_duration: z.number().finite().min(0).max(10).default(0.5),
  background_blur: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  ...CanvasShape,
  ...CommonShape,
};

const AddSubtitleShape = {
  draft_id: DraftIdSchema,
  srt: z
    .string()
    .min(1, 'Subtitle content or reference is required')
    .max(1_000_000, 'Subtitle content is too large')
    .describe(
      'Inline SRT text, an https:// URL to an .srt file, or an absolute path inside an ' +
        'approved media directory'
    ),
  time_offset: z.number().finite().min(-86_400).max(86_400).default(0)
    .describe('Shift every cue by this many seconds'),
  font: AssetNameSchema.optional(),
  font_size: z.number().finite().min(1).max(100).default(5)
    .describe("CapCut's own font scale (not points); 5 is the subtitle default"),
  font_color: HexColorSchema.default('#FFFFFF'),
  bold: z.boolean().default(false),
  italic: z.boolean().default(false),
  underline: z.boolean().default(false),
  alpha: UnitIntervalSchema.default(1).describe('Text opacity'),
  vertical: z.boolean().default(false),
  border_color: HexColorSchema.default('#000000'),
  border_alpha: UnitIntervalSchema.default(1),
  border_width: z.number().finite().min(0).max(100).default(0),
  background_color: HexColorSchema.default('#000000'),
  background_alpha: UnitIntervalSchema.default(0)
    .describe('Background opacity; 0 means no background is drawn'),
  background_style: z.number().int().min(1).max(2).default(1)
    .describe('Subtitle background style: 1 or 2 (CapCut offers no others)'),
  transform_x: TransformSchema.default(0),
  transform_y: TransformSchema.default(-0.8).describe('Vertical offset; -0.8 sits near the bottom'),
  scale_x: ScaleSchema.default(1),
  scale_y: ScaleSchema.default(1),
  rotation: z.number().finite().min(-360).max(360).default(0),
  track_name: TrackNameSchema.default('subtitle'),
  ...CanvasShape,
  ...CommonShape,
};

const AddKeyframeShape = {
  draft_id: DraftIdSchema,
  track_name: TrackNameSchema.default('video_main'),
  // VectCutAPI requires len(property_types) == len(times) == len(values): these
  // are parallel arrays of (property, time, value) triples, NOT a cross-product
  // of properties over times. Animating one property at two times therefore
  // needs that property repeated twice.
  property_types: z
    .array(
      z.enum([
        'position_x', 'position_y', 'rotation', 'scale_x', 'scale_y',
        'uniform_scale', 'alpha', 'saturation', 'contrast', 'brightness', 'volume',
      ])
    )
    .min(2)
    .max(256)
    .describe('Property animated by each keyframe; one entry per keyframe'),
  times: z.array(SecondsSchema).min(2).max(256)
    .describe('Time of each keyframe in seconds; one entry per keyframe'),
  values: z.array(z.string().min(1).max(64).regex(/^-?\d+(\.\d+)?$/, 'Each value must be numeric'))
    .min(2)
    .max(256)
    .describe('Value at each keyframe, as numeric strings; one entry per keyframe'),
  ...CommonShape,
};

const AddEffectShape = {
  draft_id: DraftIdSchema,
  effect_type: AssetNameSchema.describe(
    'Effect name from capcut_list_asset_types(category="video_scene_effect" or "video_character_effect")'
  ),
  effect_category: z.enum(['scene', 'character']).default('scene'),
  start: SecondsSchema.default(0).describe('Timeline start, in seconds'),
  end: SecondsSchema.default(3).describe('Timeline end, in seconds'),
  // VectCutAPI reverses this list unconditionally (`params[::-1]`), so sending
  // no value at all makes the backend raise. Default to an empty list, which it
  // handles correctly and which means "use every effect default".
  params: z.array(z.number().finite().min(0).max(100)).max(16).default([])
    .describe('Effect parameters, each 0-100; an empty list uses the effect defaults'),
  track_name: TrackNameSchema.default('effect_01'),
  ...CanvasShape,
  ...CommonShape,
};

const AddStickerShape = {
  draft_id: DraftIdSchema,
  sticker_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{4,64}$/, 'Sticker ID must be 4-64 characters of letters, digits, - or _')
    .describe("CapCut sticker resource ID (not a URL); found in CapCut's own sticker metadata"),
  start: SecondsSchema.default(0).describe('Timeline start, in seconds'),
  end: SecondsSchema.default(5).describe('Timeline end, in seconds'),
  transform_x: TransformSchema.default(0),
  transform_y: TransformSchema.default(0),
  scale_x: ScaleSchema.default(1),
  scale_y: ScaleSchema.default(1),
  rotation: z.number().finite().min(-360).max(360).default(0),
  alpha: UnitIntervalSchema.default(1),
  flip_horizontal: z.boolean().default(false),
  flip_vertical: z.boolean().default(false),
  track_name: TrackNameSchema.default('sticker_main'),
  relative_index: z.number().int().min(-100).max(100).default(0),
  ...CanvasShape,
  ...CommonShape,
};

const SaveDraftShape = {
  draft_id: DraftIdSchema,
  ...CommonShape,
};

const ListAssetTypesShape = {
  category: z.enum(Object.keys(ASSET_CATALOGUES) as [string, ...string[]])
    .describe('Which CapCut asset catalogue to list'),
  ...CommonShape,
};

const RestoreBackupShape = {
  draft_id: DraftIdSchema,
  version: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(_\d+)?$/,
      'Version must look like 2026-09-07_14-31-05'
    )
    .optional()
    .describe('Backup to restore. Omit to list the available versions without changing anything.'),
  ...CommonShape,
};

// Strict objects, used for standalone parsing and by the test-suite.
export const CreateDraftSchema = z.object(CreateDraftShape).strict();
export const AddVideoSchema = z.object(AddVideoShape).strict();
export const AddAudioSchema = z.object(AddAudioShape).strict();
export const AddTextSchema = z.object(AddTextShape).strict();
export const AddImageSchema = z.object(AddImageShape).strict();
export const AddSubtitleSchema = z.object(AddSubtitleShape).strict();
export const AddKeyframeSchema = z.object(AddKeyframeShape).strict();
export const AddEffectSchema = z.object(AddEffectShape).strict();
export const AddStickerSchema = z.object(AddStickerShape).strict();
export const SaveDraftSchema = z.object(SaveDraftShape).strict();
export const ListAssetTypesSchema = z.object(ListAssetTypesShape).strict();
export const RestoreBackupSchema = z.object(RestoreBackupShape).strict();

export type CreateDraftInput = z.infer<typeof CreateDraftSchema>;
export type AddVideoInput = z.infer<typeof AddVideoSchema>;
export type AddAudioInput = z.infer<typeof AddAudioSchema>;
export type AddTextInput = z.infer<typeof AddTextSchema>;
export type AddImageInput = z.infer<typeof AddImageSchema>;
export type AddSubtitleInput = z.infer<typeof AddSubtitleSchema>;
export type AddKeyframeInput = z.infer<typeof AddKeyframeSchema>;
export type AddEffectInput = z.infer<typeof AddEffectSchema>;
export type AddStickerInput = z.infer<typeof AddStickerSchema>;
export type SaveDraftInput = z.infer<typeof SaveDraftSchema>;
export type ListAssetTypesInput = z.infer<typeof ListAssetTypesSchema>;
export type RestoreBackupInput = z.infer<typeof RestoreBackupSchema>;
