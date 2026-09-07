#!/usr/bin/env node
/**
 * Manual smoke test against a RUNNING VectCutAPI.
 *
 * The automated suite (`npm test`) stubs the backend so it can run anywhere.
 * This script is the other half: it spawns the real built server over stdio and
 * drives it against a live loopback VectCutAPI, so you can confirm on your own
 * machine that the request payloads still match your VectCutAPI checkout.
 *
 * It is NOT part of `npm test` and never runs automatically.
 *
 * Usage:
 *   # 1. start the backend (see vectcutapi/bind-localhost.patch)
 *   python capcut_server.py --host 127.0.0.1 --port 9000
 *
 *   # 2. in another shell
 *   npm run build
 *   CAPCUT_DRAFT_DIR=/tmp/capcut-smoke-drafts \
 *   CAPCUT_MEDIA_DIRS=/tmp/capcut-smoke-media \
 *     node scripts/smoke.mjs
 *
 * Everything it writes goes under the two directories above. Point them at
 * scratch locations, NOT at your real CapCut projects folder.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.CAPCUT_API_URL ?? 'http://127.0.0.1:9000';
const DRAFTS = process.env.CAPCUT_DRAFT_DIR ?? '/tmp/capcut-smoke-drafts';
const MEDIA = process.env.CAPCUT_MEDIA_DIRS ?? '/tmp/capcut-smoke-media';

let failures = 0;
const report = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? ' ok  ' : 'FAIL '} ${label}${detail ? `\n        ${detail}` : ''}`);
};
const textOf = r => r.content.map(c => c.text).join('\n');

await mkdir(DRAFTS, { recursive: true });
await mkdir(MEDIA, { recursive: true });

// A tiny real WAV, so add_audio exercises a genuine decode.
const sampleRate = 8000;
const pcm = Buffer.alloc(sampleRate * 2);
const header = Buffer.concat([
  Buffer.from('RIFF'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(36 + pcm.length); return b; })(),
  Buffer.from('WAVEfmt '), (() => {
    const b = Buffer.alloc(20);
    b.writeUInt32LE(16, 0); b.writeUInt16LE(1, 4); b.writeUInt16LE(1, 6);
    b.writeUInt32LE(sampleRate, 8); b.writeUInt32LE(sampleRate * 2, 12);
    b.writeUInt16LE(2, 16); b.writeUInt16LE(16, 18); return b;
  })(),
  Buffer.from('data'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(pcm.length); return b; })(),
  pcm,
]);
const audioPath = path.join(MEDIA, 'smoke-tone.wav');
await writeFile(audioPath, header);

// Probe the backend first. Without it every subsequent check fails for the same
// single reason, and eight cascading failures bury the one line that matters.
try {
  const probe = await fetch(`${API}/get_transition_types`, {
    method: 'GET',
    signal: AbortSignal.timeout(4000),
  });
  if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
} catch (error) {
  const why = error?.name === 'TimeoutError' ? 'it did not respond in time' : 'nothing is listening';
  console.error(
    `\nVectCutAPI is not reachable at ${API} (${why}).\n\n` +
      'Start it in another terminal, and leave it running:\n\n' +
      '    cd ~/VectCutAPI\n' +
      '    python3 capcut_server.py --host 127.0.0.1 --port 9000\n\n' +
      'If that fails with "unsupported operand type(s) for |", apply\n' +
      'vectcutapi/python39-compat.patch or use Python 3.10+.\n' +
      `If it is listening on another port, set CAPCUT_API_URL (currently ${API}).\n`
  );
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, 'dist', 'index.js')],
  env: {
    PATH: process.env.PATH,
    CAPCUT_API_URL: API,
    CAPCUT_DRAFT_DIR: DRAFTS,
    CAPCUT_MEDIA_DIRS: MEDIA,
    // Media here is local, so the network preflight has nothing to check.
    CAPCUT_MEDIA_PREFLIGHT: '0',
    CAPCUT_BACKUP_COALESCE_SECONDS: '0',
  },
  stderr: 'pipe',
});
const client = new Client({ name: 'capcut-smoke', version: '1.0.0' });
await client.connect(transport);

console.log(`\nBackend: ${API}\nDrafts:  ${DRAFTS}\nMedia:   ${MEDIA}\n`);

const { tools } = await client.listTools();
report(tools.length === 12, `12 tools registered (got ${tools.length})`);

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  report(!result.isError, name, result.isError ? textOf(result).replace(/\n/g, ' ').slice(0, 200) : '');
  return result;
};

console.log('\n-- editing tools --');
const draft = await call('capcut_create_draft', { width: 1080, height: 1920 });
const draftId = draft.structuredContent?.draft_id;
report(Boolean(draftId), `draft_id returned from the backend's "output" field`, String(draftId));

if (!draftId) {
  // Everything below needs a draft. Continuing would report the same root cause
  // a dozen more times and then crash on an undefined path.
  console.error('\nNo draft was created, so the remaining checks cannot run.');
  console.error(textOf(draft));
  await client.close();
  process.exit(1);
}

const effects = await client.callTool({
  name: 'capcut_list_asset_types',
  arguments: { category: 'video_scene_effect', response_format: 'json' },
});
const effectNames = effects.isError ? [] : JSON.parse(textOf(effects)).map(e => e.name);
report(effectNames.length > 0, `capcut_list_asset_types (${effectNames.length} scene effects)`);

await call('capcut_add_text', { draft_id: draftId, text: 'Smoke', start: 0, end: 2, transform_y: -0.6 });
await call('capcut_add_audio', { draft_id: draftId, audio_url: audioPath, start: 0, end: 1 });
await call('capcut_add_subtitle', {
  draft_id: draftId,
  srt: '1\n00:00:01,000 --> 00:00:03,000\nSmoke test\n',
});
await call('capcut_add_keyframe', {
  draft_id: draftId,
  track_name: 'text_main',
  property_types: ['alpha', 'alpha'],
  times: [0, 2],
  values: ['0.0', '1.0'],
});
if (effectNames.length > 0) {
  await call('capcut_add_effect', { draft_id: draftId, effect_type: effectNames[0], start: 0, end: 2 });
}

console.log('\n-- guards (every one of these MUST be rejected) --');
for (const [label, url] of [
  ['file:// scheme', 'file:///etc/passwd'],
  ['plain http', 'http://example.com/clip.mp4'],
  ['loopback host', 'https://127.0.0.1/clip.mp4'],
  ['LAN address', 'https://192.168.1.5/clip.mp4'],
  ['cloud metadata', 'https://169.254.169.254/latest/meta-data/'],
  ['unapproved local path', '/etc/passwd'],
]) {
  const r = await client.callTool({
    name: 'capcut_add_video',
    arguments: { draft_id: draftId, video_url: url },
  });
  report(r.isError === true, `rejected: ${label}`);
}

console.log('\n-- backup and restore --');
// First save creates the project; the second must snapshot it beforehand,
// because the backend deletes the project directory when it saves.
await call('capcut_save_draft', { draft_id: draftId });
const infoPath = path.join(DRAFTS, draftId, 'draft_info.json');
const original = await readFile(infoPath, 'utf8').catch(() => null);
report(original !== null, 'project written into the approved draft directory');

const second = await call('capcut_save_draft', { draft_id: draftId });
report(
  second.structuredContent?.backup?.created === true,
  'a backup was taken before the destructive re-save',
  JSON.stringify(second.structuredContent?.backup)
);

const listed = await call('capcut_restore_backup', { draft_id: draftId });
const version = listed.structuredContent?.versions?.[0]?.version;
report(Boolean(version), `backup listed (${version})`);

if (version && original !== null) {
  await writeFile(infoPath, '{"CORRUPTED":true}');
  const restored = await call('capcut_restore_backup', { draft_id: draftId, version });
  report(
    restored.structuredContent?.pre_restore_backup != null,
    'restore took its own pre-restore snapshot'
  );
  report((await readFile(infoPath, 'utf8')) === original, 'project restored byte-identically');
}

await client.close();
console.log(`\n${failures === 0 ? 'SMOKE TEST PASSED' : `SMOKE TEST FAILED (${failures} check(s))`}`);
process.exit(failures === 0 ? 0 : 1);
