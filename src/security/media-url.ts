/**
 * Media reference validation (SSRF guard).
 *
 * VectCutAPI hands media URLs straight to ffmpeg, which happily speaks file://,
 * concat:, rtmp: and friends and will follow HTTP redirects. So the MCP is the
 * only place a media reference can be vetted before it becomes a fetch on the
 * user's machine. Two shapes are accepted and nothing else:
 *
 *   1. An `https://` URL whose host resolves entirely to public addresses.
 *   2. An absolute local path inside an operator-approved media directory.
 */

import { lookup } from 'node:dns/promises';
import { classifyAddress } from './ip-ranges.js';
import { assertWithinApprovedDirs } from './paths.js';

export class MediaUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaUrlError';
  }
}

/** Host names that must never be reached regardless of what DNS says. */
const DENIED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

/** Suffixes that denote names only meaningful inside a private network. */
const DENIED_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa'];

export interface MediaGuardOptions {
  /** Canonicalized directories from which local media files may be read. */
  approvedMediaDirs: readonly string[];
  /** Largest media file the pipeline will accept, in bytes. */
  maxDownloadBytes: number;
  /** Per-request network timeout for the preflight, in milliseconds. */
  requestTimeoutMs: number;
  /** When false, skip the network preflight and validate the URL structurally. */
  preflight: boolean;
  /** Maximum redirect hops to follow during preflight. */
  maxRedirects: number;
  /** Injection seam for tests: resolve a hostname to IP literals. */
  resolveHost?: (hostname: string) => Promise<string[]>;
  /** Injection seam for tests: perform a single non-following request. */
  fetchImpl?: typeof fetch;
}

export type MediaReference =
  | { kind: 'url'; value: string }
  | { kind: 'file'; value: string };

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map(record => record.address);
}

function looksLikeUrl(input: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input);
}

/**
 * Structural checks on a single URL: scheme, credentials, and host shape.
 * Applied to the original URL and to every redirect target.
 */
function assertUrlShape(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MediaUrlError(`${JSON.stringify(raw)} is not a valid URL`);
  }

  if (url.protocol !== 'https:') {
    throw new MediaUrlError(
      `${JSON.stringify(raw)} uses the "${url.protocol}" scheme, which is not allowed. ` +
        'Remote media must be served over "https:". ' +
        'file:, ftp:, http:, data: and every other scheme are rejected; ' +
        'to use a file already on this machine, pass its absolute path and add its ' +
        'directory to CAPCUT_MEDIA_DIRS.'
    );
  }

  if (url.username !== '' || url.password !== '') {
    throw new MediaUrlError(
      `${JSON.stringify(raw)} embeds credentials in the URL, which is not allowed`
    );
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === '') {
    throw new MediaUrlError(`${JSON.stringify(raw)} has no host`);
  }
  if (DENIED_HOSTNAMES.has(hostname)) {
    throw new MediaUrlError(
      `${JSON.stringify(raw)} points at "${hostname}", which is a local or metadata host`
    );
  }
  for (const suffix of DENIED_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      throw new MediaUrlError(
        `${JSON.stringify(raw)} points at "${hostname}", whose "${suffix}" suffix denotes a private network name`
      );
    }
  }

  return url;
}

/** Reject a URL whose host is, or resolves to, a non-public address. */
async function assertPublicHost(
  url: URL,
  resolveHost: (hostname: string) => Promise<string[]>
): Promise<void> {
  const hostname = url.hostname;

  // Bracketed IPv6 literal or bare IPv4 literal: judge it directly, no DNS.
  const literal = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : /^[\d.]+$/.test(hostname)
      ? hostname
      : null;

  if (literal !== null) {
    const verdict = classifyAddress(literal);
    if (verdict.blocked) {
      throw new MediaUrlError(`${url.href} is blocked: ${verdict.reason}`);
    }
    return;
  }

  let addresses: string[];
  try {
    addresses = await resolveHost(hostname);
  } catch {
    throw new MediaUrlError(
      `Could not resolve the host "${hostname}"; the media reference is rejected because ` +
        'its destination cannot be verified'
    );
  }

  if (addresses.length === 0) {
    throw new MediaUrlError(`The host "${hostname}" resolved to no addresses`);
  }

  // Every answer must be public: one private A record is enough to make this a
  // DNS-rebinding style route into the LAN.
  for (const address of addresses) {
    const verdict = classifyAddress(address);
    if (verdict.blocked) {
      throw new MediaUrlError(
        `The host "${hostname}" resolves to ${address}, which is blocked: ${verdict.reason}`
      );
    }
  }
}

/**
 * Walk the redirect chain without following it automatically, validating each
 * hop, and enforce the size cap from the advertised Content-Length.
 */
async function preflight(url: URL, options: MediaGuardOptions): Promise<void> {
  const doFetch = options.fetchImpl ?? fetch;
  const resolveHost = options.resolveHost ?? defaultResolveHost;

  let current = url;
  for (let hop = 0; hop <= options.maxRedirects; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.requestTimeoutMs);

    let response: Response;
    try {
      response = await doFetch(current.href, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      const detail = error instanceof Error && error.name === 'AbortError'
        ? `timed out after ${options.requestTimeoutMs}ms`
        : 'the request failed';
      throw new MediaUrlError(`Could not reach ${current.href}: ${detail}`);
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new MediaUrlError(
          `${current.href} returned a ${response.status} redirect without a Location header`
        );
      }
      const next = assertUrlShape(new URL(location, current).href);
      await assertPublicHost(next, resolveHost);
      current = next;
      continue;
    }

    if (response.status >= 400) {
      throw new MediaUrlError(
        `${current.href} is not retrievable (HTTP ${response.status})`
      );
    }

    const declared = response.headers.get('content-length');
    if (declared !== null) {
      const size = Number(declared);
      if (Number.isFinite(size) && size > options.maxDownloadBytes) {
        throw new MediaUrlError(
          `${current.href} advertises ${size} bytes, over the ${options.maxDownloadBytes}-byte limit ` +
            '(raise CAPCUT_MAX_DOWNLOAD_BYTES if this is intentional)'
        );
      }
    }
    return;
  }

  throw new MediaUrlError(
    `${url.href} exceeded the redirect limit of ${options.maxRedirects} hops`
  );
}

/**
 * Validate an agent-supplied media reference.
 *
 * @returns The reference to hand to VectCutAPI: the original URL, or the
 *          canonical on-disk path for an approved local file.
 */
export async function validateMediaReference(
  input: string,
  options: MediaGuardOptions
): Promise<MediaReference> {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new MediaUrlError('The media reference is empty');
  }
  const value = input.trim();

  if (!looksLikeUrl(value)) {
    // Not a URL, so it must be an approved local file.
    const resolved = await assertWithinApprovedDirs(
      value,
      options.approvedMediaDirs,
      'media path'
    );
    return { kind: 'file', value: resolved };
  }

  const url = assertUrlShape(value);
  await assertPublicHost(url, options.resolveHost ?? defaultResolveHost);

  if (options.preflight) {
    await preflight(url, options);
  }

  return { kind: 'url', value: url.href };
}
