/**
 * Requirement 2/3: the MCP may only ever talk to a loopback VectCutAPI.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { loadConfig, ConfigError } from '../src/config.js';
import {
  assertLoopbackBackendUrl,
  BackendUrlError,
  isLoopbackBackendUrl,
} from '../src/security/backend-url.js';
import { CapCutApiClient } from '../src/services/api-client.js';

describe('backend URL validation', () => {
  test('accepts loopback hosts', () => {
    assert.equal(assertLoopbackBackendUrl('http://127.0.0.1:9000'), 'http://127.0.0.1:9000');
    assert.equal(assertLoopbackBackendUrl('http://localhost:9000'), 'http://localhost:9000');
    assert.equal(assertLoopbackBackendUrl('http://[::1]:9000'), 'http://[::1]:9000');
    assert.equal(assertLoopbackBackendUrl('http://127.0.0.1'), 'http://127.0.0.1');
    // A trailing slash is normalised away rather than rejected.
    assert.equal(assertLoopbackBackendUrl('http://127.0.0.1:9000/'), 'http://127.0.0.1:9000');
  });

  test('rejects remote hosts', () => {
    for (const url of [
      'https://api.example.com',
      'http://example.com:9000',
      'http://capcut-api.internal:9000',
      'https://127.0.0.1:9000', // TLS is not accepted even to loopback
      'http://8.8.8.8:9000',
    ]) {
      assert.throws(() => assertLoopbackBackendUrl(url), BackendUrlError, `expected ${url} to fail`);
    }
  });

  test('rejects LAN and private ranges', () => {
    for (const url of [
      'http://192.168.1.50:9000',
      'http://192.168.0.1',
      'http://10.0.0.5:9000',
      'http://10.255.255.255:9000',
      'http://172.16.0.1:9000',
      'http://172.20.10.4:9000',
      'http://172.31.255.254:9000',
      'http://169.254.169.254:9000',
      'http://0.0.0.0:9000',
    ]) {
      assert.throws(() => assertLoopbackBackendUrl(url), BackendUrlError, `expected ${url} to fail`);
    }
  });

  test('rejects external IPv6 while allowing ::1', () => {
    assert.ok(isLoopbackBackendUrl('http://[::1]:9000'));
    for (const url of [
      'http://[2606:4700:4700::1111]:9000',
      'http://[fd00::1]:9000',
      'http://[fe80::1]:9000',
      'http://[::ffff:127.0.0.1]:9000', // obfuscated loopback: not on the allowlist
    ]) {
      assert.equal(isLoopbackBackendUrl(url), false, `expected ${url} to fail`);
    }
  });

  test('obfuscated spellings that really are loopback normalise to loopback', () => {
    // The WHATWG parser canonicalises integer, hex and short-form IPv4 before we
    // see it, so these resolve to a genuine 127.0.0.1 and are correctly allowed.
    // The allowlist is applied to the *normalised* host, which is what makes
    // enumerating every spelling unnecessary.
    for (const url of [
      'http://2130706433:9000',
      'http://0x7f.0.0.1:9000',
      'http://127.1:9000',
      'http://0177.0.0.1:9000',
    ]) {
      assert.equal(
        assertLoopbackBackendUrl(url),
        'http://127.0.0.1:9000',
        `expected ${url} to normalise to loopback`
      );
    }
  });

  test('rejects hosts that only look like loopback, and credentialed URLs', () => {
    for (const url of [
      'http://127.0.0.1@evil.example.com:9000', // the real host is evil.example.com
      'http://127.0.0.1.evil.example.com:9000',
      'http://user:pass@127.0.0.1:9000',
      'http://127.0.0.1:9000?x=1',
      'http://127.0.0.1:9000#frag',
      'http://127.0.0.1:99999',
    ]) {
      assert.equal(isLoopbackBackendUrl(url), false, `expected ${url} to fail`);
    }
  });

  test('rejects non-http schemes and malformed values', () => {
    for (const url of ['file:///etc/passwd', 'ftp://127.0.0.1', '127.0.0.1:9000', '', '   ']) {
      assert.equal(isLoopbackBackendUrl(url), false, `expected ${JSON.stringify(url)} to fail`);
    }
  });

  test('the API client re-validates its own base URL', () => {
    assert.throws(
      () => new CapCutApiClient({ baseUrl: 'https://evil.example.com', timeoutMs: 1000 }),
      BackendUrlError
    );
    assert.doesNotThrow(
      () => new CapCutApiClient({ baseUrl: 'http://127.0.0.1:9000', timeoutMs: 1000 })
    );
  });

  test('loadConfig refuses to start against a remote backend', async () => {
    await assert.rejects(
      loadConfig({ CAPCUT_API_URL: 'http://192.168.1.10:9000' } as NodeJS.ProcessEnv),
      BackendUrlError
    );
    await assert.rejects(
      loadConfig({ CAPCUT_API_URL: 'https://capcut.example.com' } as NodeJS.ProcessEnv),
      BackendUrlError
    );
  });

  test('loadConfig defaults to loopback and disables cloud upload', async () => {
    const config = await loadConfig({} as NodeJS.ProcessEnv);
    assert.equal(config.backendUrl, 'http://127.0.0.1:9000');
    assert.equal(config.allowCloudUpload, false);
    assert.equal(config.draftDir, null);
    assert.deepEqual(config.mediaDirs, []);
  });

  test('loadConfig rejects nonsense numeric settings instead of falling back', async () => {
    await assert.rejects(
      loadConfig({ CAPCUT_MAX_DOWNLOAD_BYTES: 'lots' } as NodeJS.ProcessEnv),
      ConfigError
    );
    await assert.rejects(
      loadConfig({ CAPCUT_REQUEST_TIMEOUT_MS: '-5' } as NodeJS.ProcessEnv),
      ConfigError
    );
  });
});
