/**
 * VectCutAPI HTTP client.
 *
 * Talks only to the validated loopback backend. Uses the platform fetch rather
 * than an HTTP library so there is one fewer dependency in the supply chain and
 * no chance of a client-level feature (proxy env vars, automatic redirects to
 * other hosts) reintroducing egress we just spent effort removing.
 *
 * Response shape note: VectCutAPI returns `{success, output, error}`. The
 * payload lives in `output`, not `result`.
 */

import { ConfigError } from '../config.js';
import { assertLoopbackBackendUrl } from '../security/backend-url.js';

export class BackendError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'BackendError';
    this.status = status;
  }
}

/** The envelope every VectCutAPI route returns. */
interface BackendEnvelope {
  success?: boolean;
  output?: unknown;
  error?: unknown;
}

export interface ApiClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** Endpoints this fork is allowed to call, verified against capcut_server.py. */
export const BACKEND_ENDPOINTS = {
  createDraft: '/create_draft',
  addVideo: '/add_video',
  addAudio: '/add_audio',
  addText: '/add_text',
  addImage: '/add_image',
  addSubtitle: '/add_subtitle',
  /** Not /add_keyframe: that route does not exist. */
  addKeyframe: '/add_video_keyframe',
  addEffect: '/add_effect',
  addSticker: '/add_sticker',
  saveDraft: '/save_draft',
  queryDraftStatus: '/query_draft_status',
  listIntroAnimations: '/get_intro_animation_types',
  listOutroAnimations: '/get_outro_animation_types',
  listComboAnimations: '/get_combo_animation_types',
  listTransitions: '/get_transition_types',
  listMasks: '/get_mask_types',
  listAudioEffects: '/get_audio_effect_types',
  listFonts: '/get_font_types',
  listTextIntro: '/get_text_intro_types',
  listTextOutro: '/get_text_outro_types',
  listTextLoop: '/get_text_loop_anim_types',
  listSceneEffects: '/get_video_scene_effect_types',
  listCharacterEffects: '/get_video_character_effect_types',
} as const;

export type BackendEndpoint = (typeof BACKEND_ENDPOINTS)[keyof typeof BACKEND_ENDPOINTS];

export class CapCutApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions) {
    // Re-validate at construction: this class is the only thing that opens a
    // socket, so it is the last place a non-loopback target could slip in.
    this.baseUrl = assertLoopbackBackendUrl(options.baseUrl);
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new ConfigError('The backend request timeout must be a positive number of milliseconds');
    }
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * POST a JSON body to a known endpoint and unwrap the envelope.
   *
   * @returns the `output` payload on success.
   * @throws {BackendError} with the backend's own message on failure.
   */
  async post<T = unknown>(endpoint: BackendEndpoint, body: Record<string, unknown>): Promise<T> {
    return this.send<T>(endpoint, 'POST', body);
  }

  /** GET a known endpoint and unwrap the envelope. */
  async get<T = unknown>(endpoint: BackendEndpoint): Promise<T> {
    return this.send<T>(endpoint, 'GET');
  }

  private async send<T>(
    endpoint: BackendEndpoint,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new BackendError(
          `VectCutAPI did not respond within ${this.timeoutMs}ms (${method} ${endpoint})`
        );
      }
      throw new BackendError(
        `Could not reach VectCutAPI at ${this.baseUrl} (${method} ${endpoint}). ` +
          'Start it with: python capcut_server.py --host 127.0.0.1'
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new BackendError(
        `VectCutAPI returned HTTP ${response.status} for ${method} ${endpoint}`,
        response.status
      );
    }

    let envelope: BackendEnvelope;
    try {
      envelope = (await response.json()) as BackendEnvelope;
    } catch {
      throw new BackendError(`VectCutAPI returned a non-JSON body for ${method} ${endpoint}`);
    }

    if (envelope.success !== true) {
      const detail =
        typeof envelope.error === 'string' && envelope.error.trim() !== ''
          ? envelope.error.trim()
          : 'the backend reported failure without a message';
      throw new BackendError(`${method} ${endpoint} failed: ${detail}`);
    }

    return envelope.output as T;
  }

  /** The loopback origin this client is pinned to. */
  get origin(): string {
    return this.baseUrl;
  }
}
