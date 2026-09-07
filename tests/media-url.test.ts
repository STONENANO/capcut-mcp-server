/**
 * Requirement 5: media URLs must not be usable to reach the local machine,
 * the LAN, or cloud metadata; and downloads must be bounded.
 */

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { describe } from 'node:test';
import { classifyAddress } from '../src/security/ip-ranges.js';
import {
  MediaUrlError,
  validateMediaReference,
  type MediaGuardOptions,
} from '../src/security/media-url.js';

/** Guard options that never touch the network: DNS and fetch are both stubbed. */
function offlineOptions(overrides: Partial<MediaGuardOptions> = {}): MediaGuardOptions {
  return {
    approvedMediaDirs: [],
    maxDownloadBytes: 1024,
    requestTimeoutMs: 1000,
    preflight: false,
    maxRedirects: 5,
    resolveHost: async () => ['93.184.216.34'], // a public address
    ...overrides,
  };
}

describe('IP classification', () => {
  test('blocks every private and special-purpose IPv4 range', () => {
    for (const address of [
      '0.0.0.0', '10.1.2.3', '127.0.0.1', '127.1.2.3', '100.64.0.1',
      '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '192.0.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    ]) {
      assert.equal(classifyAddress(address).blocked, true, `${address} should be blocked`);
    }
  });

  test('allows public IPv4', () => {
    for (const address of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '172.32.0.1', '11.0.0.1']) {
      assert.equal(classifyAddress(address).blocked, false, `${address} should be allowed`);
    }
  });

  test('blocks private IPv6 and IPv4-in-IPv6 smuggling', () => {
    for (const address of [
      '::1', '::', 'fd00::1', 'fe80::1', 'ff02::1',
      '::ffff:127.0.0.1', '::ffff:192.168.1.1', '::ffff:169.254.169.254',
      '64:ff9b::127.0.0.1', '2002:c0a8:0101::1', '2001:db8::1',
    ]) {
      assert.equal(classifyAddress(address).blocked, true, `${address} should be blocked`);
    }
  });

  test('allows public IPv6', () => {
    assert.equal(classifyAddress('2606:4700:4700::1111').blocked, false);
    assert.equal(classifyAddress('::ffff:8.8.8.8').blocked, false);
  });
});

describe('media reference validation', () => {
  test('accepts a public https URL', async () => {
    const reference = await validateMediaReference(
      'https://cdn.example.com/clip.mp4',
      offlineOptions()
    );
    assert.deepEqual(reference, { kind: 'url', value: 'https://cdn.example.com/clip.mp4' });
  });

  test('rejects non-https schemes', async () => {
    for (const url of [
      'http://cdn.example.com/clip.mp4',
      'file:///etc/passwd',
      'ftp://files.example.com/clip.mp4',
      'data:video/mp4;base64,AAAA',
      'gopher://example.com/',
    ]) {
      await assert.rejects(
        validateMediaReference(url, offlineOptions()),
        MediaUrlError,
        `expected ${url} to be rejected`
      );
    }
  });

  test('rejects loopback, private and metadata destinations by literal', async () => {
    for (const url of [
      'https://127.0.0.1/clip.mp4',
      'https://localhost/clip.mp4',
      'https://192.168.1.10/clip.mp4',
      'https://10.0.0.4/clip.mp4',
      'https://172.16.4.2/clip.mp4',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/clip.mp4',
      'https://[fd00::1]/clip.mp4',
    ]) {
      await assert.rejects(
        validateMediaReference(url, offlineOptions()),
        MediaUrlError,
        `expected ${url} to be rejected`
      );
    }
  });

  test('rejects a public-looking host that resolves into private space', async () => {
    await assert.rejects(
      validateMediaReference(
        'https://rebind.example.com/clip.mp4',
        offlineOptions({ resolveHost: async () => ['192.168.1.50'] })
      ),
      /resolves to 192\.168\.1\.50/
    );
  });

  test('rejects when any one of several answers is private', async () => {
    await assert.rejects(
      validateMediaReference(
        'https://mixed.example.com/clip.mp4',
        offlineOptions({ resolveHost: async () => ['93.184.216.34', '10.0.0.9'] })
      ),
      /10\.0\.0\.9/
    );
  });

  test('rejects private-network hostname suffixes and metadata names', async () => {
    for (const url of [
      'https://nas.local/clip.mp4',
      'https://build.internal/clip.mp4',
      'https://metadata.google.internal/computeMetadata/v1/',
    ]) {
      await assert.rejects(validateMediaReference(url, offlineOptions()), MediaUrlError);
    }
  });

  test('rejects credentials embedded in a media URL', async () => {
    await assert.rejects(
      validateMediaReference('https://user:pw@cdn.example.com/clip.mp4', offlineOptions()),
      MediaUrlError
    );
  });

  describe('preflight', () => {
    const publicResponse = (headers: Record<string, string> = {}): Response =>
      new Response(null, { status: 200, headers });

    test('follows redirects and rejects one landing on a private address', async () => {
      const hops: string[] = [];
      const options = offlineOptions({
        preflight: true,
        maxDownloadBytes: 1024 * 1024,
        resolveHost: async hostname =>
          hostname === 'cdn.example.com' ? ['93.184.216.34'] : ['10.1.2.3'],
        fetchImpl: (async (input: string | URL | Request) => {
          const url = String(input);
          hops.push(url);
          if (url.startsWith('https://cdn.example.com')) {
            return new Response(null, {
              status: 302,
              headers: { location: 'https://internal.example.com/clip.mp4' },
            });
          }
          return publicResponse();
        }) as typeof fetch,
      });

      await assert.rejects(
        validateMediaReference('https://cdn.example.com/clip.mp4', options),
        /10\.1\.2\.3/
      );
      assert.deepEqual(hops, ['https://cdn.example.com/clip.mp4']);
    });

    test('rejects a redirect to a non-https scheme', async () => {
      const options = offlineOptions({
        preflight: true,
        fetchImpl: (async () =>
          new Response(null, {
            status: 301,
            headers: { location: 'file:///etc/passwd' },
          })) as typeof fetch,
      });
      await assert.rejects(
        validateMediaReference('https://cdn.example.com/clip.mp4', options),
        MediaUrlError
      );
    });

    test('enforces the maximum download size', async () => {
      const options = offlineOptions({
        preflight: true,
        maxDownloadBytes: 1000,
        fetchImpl: (async () => publicResponse({ 'content-length': '5000' })) as typeof fetch,
      });
      await assert.rejects(
        validateMediaReference('https://cdn.example.com/big.mp4', options),
        /over the 1000-byte limit/
      );
    });

    test('accepts a within-limit response', async () => {
      const options = offlineOptions({
        preflight: true,
        maxDownloadBytes: 10_000,
        fetchImpl: (async () => publicResponse({ 'content-length': '900' })) as typeof fetch,
      });
      const reference = await validateMediaReference(
        'https://cdn.example.com/small.mp4',
        options
      );
      assert.equal(reference.kind, 'url');
    });

    test('stops after the redirect limit', async () => {
      let hop = 0;
      const options = offlineOptions({
        preflight: true,
        maxRedirects: 2,
        fetchImpl: (async () =>
          new Response(null, {
            status: 302,
            headers: { location: `https://cdn.example.com/hop-${hop++}` },
          })) as typeof fetch,
      });
      await assert.rejects(
        validateMediaReference('https://cdn.example.com/start', options),
        /redirect limit/
      );
    });
  });

  test('local files are only accepted from approved directories', async () => {
    const approved = await mkdtemp(path.join(os.tmpdir(), 'capcut-media-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'capcut-other-'));
    await writeFile(path.join(approved, 'clip.mp4'), 'x');
    await writeFile(path.join(outside, 'secret.mp4'), 'x');

    const options = offlineOptions({ approvedMediaDirs: [approved] });

    const reference = await validateMediaReference(path.join(approved, 'clip.mp4'), options);
    assert.deepEqual(reference, { kind: 'file', value: path.join(approved, 'clip.mp4') });

    await assert.rejects(validateMediaReference(path.join(outside, 'secret.mp4'), options));
    await assert.rejects(validateMediaReference('/etc/passwd', options));
  });

  test('local files are refused entirely when no media directory is approved', async () => {
    await assert.rejects(
      validateMediaReference('/etc/passwd', offlineOptions()),
      /No approved directories are configured/
    );
  });
});
