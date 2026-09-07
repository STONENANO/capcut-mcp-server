/**
 * Runtime configuration, loaded once and validated up front.
 *
 * Everything security-relevant is decided here so the tool layer never has to
 * re-derive policy: the backend must be loopback, local paths must sit inside
 * approved roots, cloud upload is off unless explicitly opted into.
 */

import * as path from 'node:path';
import { assertLoopbackBackendUrl } from './security/backend-url.js';
import { canonicalizeRoot } from './security/paths.js';

export const DEFAULT_BACKEND_URL = 'http://127.0.0.1:9000';
export const DEFAULT_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024; // 512 MiB
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const DEFAULT_BACKUP_COALESCE_SECONDS = 300;
export const DEFAULT_MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
export const DEFAULT_MAX_REDIRECTS = 5;

export interface ServerConfig {
  /** Validated loopback origin of the VectCutAPI backend. */
  backendUrl: string;
  /** Canonical CapCut "Draft Content" directory, or null when unconfigured. */
  draftDir: string | null;
  /** Canonical directories from which local media files may be read. */
  mediaDirs: string[];
  maxDownloadBytes: number;
  requestTimeoutMs: number;
  mediaPreflight: boolean;
  maxRedirects: number;
  backupCoalesceSeconds: number;
  /** Ceiling on the bytes copied into one project snapshot. */
  maxBackupBytes: number;
  /** Cloud/OSS upload opt-in. Off unless CAPCUT_ALLOW_CLOUD_UPLOAD=1. */
  allowCloudUpload: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigError(
      `${name} must be an integer >= ${min}, got ${JSON.stringify(raw)}`
    );
  }
  return value;
}

function readBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new ConfigError(`${name} must be a boolean-ish value, got ${JSON.stringify(raw)}`);
}

/**
 * Build the server configuration from the environment.
 *
 * Throws on any invalid setting rather than falling back to a permissive
 * default, so a misconfigured server refuses to start instead of quietly
 * talking to the wrong place.
 */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<ServerConfig> {
  const backendUrl = assertLoopbackBackendUrl(env.CAPCUT_API_URL ?? DEFAULT_BACKEND_URL);

  const draftDirRaw = env.CAPCUT_DRAFT_DIR?.trim();
  const draftDir = draftDirRaw ? await canonicalizeRoot(draftDirRaw) : null;

  const mediaDirsRaw = (env.CAPCUT_MEDIA_DIRS ?? '')
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(entry => entry !== '');
  const mediaDirs: string[] = [];
  for (const dir of mediaDirsRaw) {
    mediaDirs.push(await canonicalizeRoot(dir));
  }

  const allowCloudUpload = readBool(env, 'CAPCUT_ALLOW_CLOUD_UPLOAD', false);

  return {
    backendUrl,
    draftDir,
    mediaDirs,
    maxDownloadBytes: readInt(env, 'CAPCUT_MAX_DOWNLOAD_BYTES', DEFAULT_MAX_DOWNLOAD_BYTES, 1),
    requestTimeoutMs: readInt(env, 'CAPCUT_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS, 1000),
    mediaPreflight: readBool(env, 'CAPCUT_MEDIA_PREFLIGHT', true),
    maxRedirects: readInt(env, 'CAPCUT_MAX_REDIRECTS', DEFAULT_MAX_REDIRECTS, 0),
    backupCoalesceSeconds: readInt(
      env,
      'CAPCUT_BACKUP_COALESCE_SECONDS',
      DEFAULT_BACKUP_COALESCE_SECONDS,
      0
    ),
    maxBackupBytes: readInt(env, 'CAPCUT_MAX_BACKUP_BYTES', DEFAULT_MAX_BACKUP_BYTES, 1),
    allowCloudUpload,
  };
}
