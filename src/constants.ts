// Shared constants for the CapCut MCP server.

/** Cap on the size of a single tool response, to keep transcripts bounded. */
export const CHARACTER_LIMIT = 15_000;

/** Canvas defaults, matching VectCutAPI's own defaults. */
export const DEFAULT_CANVAS = { width: 1080, height: 1920 } as const;

/**
 * Asset catalogues VectCutAPI exposes over GET. Exposing one discovery tool
 * over this map is what lets the editing tools take free-form CapCut asset
 * names (effects, transitions, fonts, animations) without either hard-coding
 * hundreds of enum members or guessing at names that do not exist.
 */
export const ASSET_CATALOGUES = {
  intro_animation: '/get_intro_animation_types',
  outro_animation: '/get_outro_animation_types',
  combo_animation: '/get_combo_animation_types',
  transition: '/get_transition_types',
  mask: '/get_mask_types',
  audio_effect: '/get_audio_effect_types',
  font: '/get_font_types',
  text_intro: '/get_text_intro_types',
  text_outro: '/get_text_outro_types',
  text_loop: '/get_text_loop_anim_types',
  video_scene_effect: '/get_video_scene_effect_types',
  video_character_effect: '/get_video_character_effect_types',
} as const;

export type AssetCatalogue = keyof typeof ASSET_CATALOGUES;
