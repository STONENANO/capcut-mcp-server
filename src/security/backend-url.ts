/**
 * Backend (VectCutAPI) URL validation.
 *
 * This fork is LOCAL-ONLY by design: the MCP server may only ever talk to a
 * VectCutAPI instance listening on the loopback interface of this machine.
 * Anything else (public IPs, LAN/RFC1918 addresses, arbitrary domains, HTTPS
 * remotes, external IPv6) is rejected at startup and fails closed.
 *
 * The check is an allowlist, not a denylist. Obfuscated loopback spellings
 * (`http://2130706433`, `http://0x7f.1`, `http://[::ffff:127.0.0.1]`) are
 * normalised by the WHATWG URL parser into a hostname that is simply not on
 * the allowlist, so they are rejected rather than needing to be enumerated.
 */

/** Hostnames accepted as "the local machine". */
const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export class BackendUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackendUrlError';
  }
}

function reject(raw: string, reason: string): never {
  throw new BackendUrlError(
    `Refusing to use CAPCUT_API_URL ${JSON.stringify(raw)}: ${reason}. ` +
      'This build only talks to a VectCutAPI bound to loopback, e.g. ' +
      '"http://127.0.0.1:9000". Start VectCutAPI with --host 127.0.0.1 and point ' +
      'CAPCUT_API_URL at it.'
  );
}

/**
 * Validate a VectCutAPI base URL, returning the normalised origin.
 * Throws {@link BackendUrlError} for anything that is not plain-HTTP loopback.
 */
export function assertLoopbackBackendUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    reject(String(raw), 'the value is empty');
  }

  const trimmed = raw.trim();

  // A bare "127.0.0.1:9000" has no scheme; require an explicit one so we never
  // guess at the caller's intent.
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    reject(trimmed, 'it is not a valid absolute URL (an "http://" scheme is required)');
  }

  if (url.protocol !== 'http:') {
    reject(
      trimmed,
      `the scheme "${url.protocol}" is not allowed (only plain "http:" to loopback is permitted; ` +
        'a loopback backend does not need, and this build does not accept, TLS or any other protocol)'
    );
  }

  if (url.username !== '' || url.password !== '') {
    reject(trimmed, 'credentials in the URL are not allowed (they can disguise the real host)');
  }

  if (!ALLOWED_HOSTNAMES.has(url.hostname)) {
    reject(
      trimmed,
      `the host "${url.hostname}" is not loopback (allowed: ${[...ALLOWED_HOSTNAMES].join(', ')})`
    );
  }

  if (url.port !== '') {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      reject(trimmed, `the port "${url.port}" is not a valid TCP port`);
    }
  }

  if (url.search !== '' || url.hash !== '') {
    reject(trimmed, 'query strings and fragments are not allowed on a base URL');
  }

  // Preserve an explicit base path (some users reverse-proxy VectCutAPI under a
  // prefix on loopback) but drop a bare trailing slash so endpoint joining is
  // predictable.
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${basePath}`;
}

/** Non-throwing variant, handy for validation surfaces and tests. */
export function isLoopbackBackendUrl(raw: string): boolean {
  try {
    assertLoopbackBackendUrl(raw);
    return true;
  } catch {
    return false;
  }
}
