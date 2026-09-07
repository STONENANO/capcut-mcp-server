/**
 * End-to-end tool tests over a real in-memory MCP session.
 *
 * Covers: the core tools still work (requirement 12), request payloads match
 * the current VectCutAPI routes and field names (13), a backup precedes the
 * one tool that writes CapCut files (10), and no tool executes commands (14).
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { describe } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadConfig, type ServerConfig } from '../src/config.js';
import { CapCutApiClient } from '../src/services/api-client.js';
import { BACKUP_DIR_NAME } from '../src/services/backup.js';
import { registerTools } from '../src/tools/index.js';

interface RecordedRequest {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** A fake VectCutAPI that records requests and answers in the real envelope. */
function fakeBackend(output: unknown = { ok: true }): {
  requests: RecordedRequest[];
  fetchImpl: typeof fetch;
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    });
    return new Response(JSON.stringify({ success: true, output, error: '' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { requests, fetchImpl };
}

async function connect(
  config: ServerConfig,
  fetchImpl: typeof fetch
): Promise<Client> {
  const server = new McpServer({ name: 'capcut-mcp-server', version: 'test' });
  registerTools(server, {
    client: new CapCutApiClient({ baseUrl: config.backendUrl, timeoutMs: 5000, fetchImpl }),
    config,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

/** Base config: preflight off so media validation never touches the network. */
async function testConfig(overrides: Partial<ServerConfig> = {}): Promise<ServerConfig> {
  const config = await loadConfig({ CAPCUT_MEDIA_PREFLIGHT: '0' } as NodeJS.ProcessEnv);
  return { ...config, ...overrides };
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ text: string }> }).content;
  return content.map(c => c.text).join('\n');
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

describe('tool surface', () => {
  test('exposes only the expected tools, each labelled READ-ONLY or MUTATING', async () => {
    const { fetchImpl } = fakeBackend();
    const client = await connect(await testConfig(), fetchImpl);
    const { tools } = await client.listTools();

    assert.deepEqual(
      tools.map(t => t.name).sort(),
      [
        'capcut_add_audio',
        'capcut_add_effect',
        'capcut_add_image',
        'capcut_add_keyframe',
        'capcut_add_sticker',
        'capcut_add_subtitle',
        'capcut_add_text',
        'capcut_add_video',
        'capcut_create_draft',
        'capcut_list_asset_types',
        'capcut_restore_backup',
        'capcut_save_draft',
      ]
    );

    for (const tool of tools) {
      assert.match(
        tool.description ?? '',
        /^\[(READ-ONLY|MUTATING)\]/,
        `${tool.name} must declare whether it mutates`
      );
    }

    const readOnly = tools.filter(t => t.annotations?.readOnlyHint === true).map(t => t.name);
    assert.deepEqual(readOnly, ['capcut_list_asset_types']);

    for (const name of ['capcut_save_draft', 'capcut_restore_backup']) {
      const tool = tools.find(t => t.name === name);
      assert.equal(tool?.annotations?.destructiveHint, true, `${name} must be flagged destructive`);
    }
  });

  test('no tool offers command, shell, script or arbitrary-path execution', async () => {
    const { fetchImpl } = fakeBackend();
    const client = await connect(await testConfig(), fetchImpl);
    const { tools } = await client.listTools();

    const forbidden = /\b(exec|shell|command|spawn|eval|script|bash|sh|run_|terminal|subprocess)\b/i;
    for (const tool of tools) {
      assert.doesNotMatch(tool.name, forbidden, `${tool.name} looks like an execution tool`);
      const properties = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
      );
      for (const property of properties) {
        assert.doesNotMatch(
          property,
          forbidden,
          `${tool.name}.${property} looks like an execution parameter`
        );
      }
    }
  });
});

describe('VectCutAPI request compatibility', () => {
  test('create_draft posts width/height and returns the backend output field', async () => {
    const { requests, fetchImpl } = fakeBackend({ draft_id: 'dfd_1', draft_url: 'http://x/y' });
    const client = await connect(await testConfig(), fetchImpl);

    const result = await client.callTool({
      name: 'capcut_create_draft',
      arguments: { width: 1080, height: 1920 },
    });

    assert.equal(isError(result), false, textOf(result));
    assert.equal(requests[0].url, 'http://127.0.0.1:9000/create_draft');
    assert.deepEqual(requests[0].body, { width: 1080, height: 1920 });
    // The payload lives under `output`, not `result`.
    assert.match(textOf(result), /dfd_1/);
  });

  test('add_video posts the trim/placement fields the backend actually reads', async () => {
    const { requests, fetchImpl } = fakeBackend();
    const client = await connect(await testConfig(), fetchImpl);

    const result = await client.callTool({
      name: 'capcut_add_video',
      arguments: {
        draft_id: 'dfd_1',
        video_url: 'https://93.184.216.34/clip.mp4',
        start: 0,
        end: 5,
        target_start: 2,
        transform_x: 0.1,
        scale_x: 1.5,
      },
    });

    assert.equal(isError(result), false, textOf(result));
    assert.equal(requests[0].url, 'http://127.0.0.1:9000/add_video');
    const body = requests[0].body!;
    assert.equal(body.video_url, 'https://93.184.216.34/clip.mp4');
    assert.equal(body.target_start, 2);
    assert.equal(body.transform_x, 0.1);
    assert.equal(body.scale_x, 1.5);
    // response_format is ours, not the backend's.
    assert.equal('response_format' in body, false);
    // Fields the old wrapper invented must not be sent.
    for (const stale of ['position_x', 'position_y', 'rotation', 'fps']) {
      assert.equal(stale in body, false, `${stale} must not be sent to /add_video`);
    }
  });

  test('add_subtitle posts "srt", not "srt_content"', async () => {
    const { requests, fetchImpl } = fakeBackend();
    const client = await connect(await testConfig(), fetchImpl);

    const srt = '1\n00:00:01,000 --> 00:00:03,000\nHello\n';
    const result = await client.callTool({
      name: 'capcut_add_subtitle',
      arguments: { draft_id: 'dfd_1', srt },
    });

    assert.equal(isError(result), false, textOf(result));
    assert.equal(requests[0].url, 'http://127.0.0.1:9000/add_subtitle');
    assert.equal(requests[0].body!.srt, srt);
    assert.equal('srt_content' in requests[0].body!, false);
  });

  test('add_keyframe targets /add_video_keyframe, not /add_keyframe', async () => {
    const { requests, fetchImpl } = fakeBackend();
    const client = await connect(await testConfig(), fetchImpl);

    const result = await client.callTool({
      name: 'capcut_add_keyframe',
      arguments: {
        draft_id: 'dfd_1',
        track_name: 'video_main',
        // Parallel arrays: one entry per keyframe, all three the same length.
        property_types: ['alpha', 'alpha'],
        times: [0, 2],
        values: ['0.0', '1.0'],
      },
    });

    assert.equal(isError(result), false, textOf(result));
    assert.equal(requests[0].url, 'http://127.0.0.1:9000/add_video_keyframe');
  });

  test('add_keyframe refuses ragged parallel arrays instead of letting the backend fail', async () => {
    const { requests, fetchImpl } = fakeBackend();
    const client = await connect(await testConfig(), fetchImpl);

    // VectCutAPI requires len(property_types) == len(times) == len(values).
    // Each of these violates that in a different position.
    for (const args of [
      { property_types: ['alpha', 'alpha'], times: [0, 1, 2], values: ['0.0', '1.0'] },
      { property_types: ['alpha', 'alpha'], times: [0, 1], values: ['0.0', '1.0', '0.5'] },
      { property_types: ['alpha', 'alpha', 'alpha'], times: [0, 1], values: ['0.0', '1.0'] },
    ]) {
      const result = await client.callTool({
        name: 'capcut_add_keyframe',
        arguments: { draft_id: 'dfd_1', ...args },
      });
      assert.equal(isError(result), true, `${JSON.stringify(args)} should be rejected`);
    }
    assert.equal(requests.length, 0, 'nothing should reach the backend');
  });

  test('add_effect always sends params, because the backend reverses it unguarded', async () => {
    const { requests, fetchImpl } = fakeBackend();
    const client = await connect(await testConfig(), fetchImpl);

    // VectCutAPI does `params[::-1]`, so omitting params raises TypeError there.
    const result = await client.callTool({
      name: 'capcut_add_effect',
      arguments: { draft_id: 'dfd_1', effect_type: 'Blur', start: 0, end: 2 },
    });

    assert.equal(isError(result), false, textOf(result));
    assert.deepEqual(requests[0].body!.params, []);
  });

  test('add_effect posts "effect_type" and "params", not "effect_name"/"intensity"', async () => {
    const { requests, fetchImpl } = fakeBackend();
    const client = await connect(await testConfig(), fetchImpl);

    const result = await client.callTool({
      name: 'capcut_add_effect',
      arguments: {
        draft_id: 'dfd_1',
        effect_type: 'Blur',
        effect_category: 'scene',
        start: 0,
        end: 2,
        params: [70],
      },
    });

    assert.equal(isError(result), false, textOf(result));
    const body = requests[0].body!;
    assert.equal(body.effect_type, 'Blur');
    assert.equal(body.effect_category, 'scene');
    assert.deepEqual(body.params, [70]);
    assert.equal('effect_name' in body, false);
    assert.equal('intensity' in body, false);
  });

  test('add_sticker posts "sticker_id" and rejects a URL', async () => {
    const { requests, fetchImpl } = fakeBackend();
    const client = await connect(await testConfig(), fetchImpl);

    const good = await client.callTool({
      name: 'capcut_add_sticker',
      arguments: { draft_id: 'dfd_1', sticker_id: 'abc123XYZ', start: 0, end: 2 },
    });
    assert.equal(isError(good), false, textOf(good));
    assert.equal(requests[0].body!.sticker_id, 'abc123XYZ');
    assert.equal('sticker_url' in requests[0].body!, false);

    const bad = await client.callTool({
      name: 'capcut_add_sticker',
      arguments: { draft_id: 'dfd_1', sticker_id: 'https://example.com/emoji.png' },
    });
    assert.equal(isError(bad), true);
  });

  test('add_text posts transform_x/transform_y, not position_x/position_y', async () => {
    const { requests, fetchImpl } = fakeBackend();
    const client = await connect(await testConfig(), fetchImpl);

    const result = await client.callTool({
      name: 'capcut_add_text',
      arguments: { draft_id: 'dfd_1', text: 'Hi', start: 0, end: 2, transform_y: -0.5 },
    });

    assert.equal(isError(result), false, textOf(result));
    const body = requests[0].body!;
    assert.equal(body.transform_y, -0.5);
    assert.equal('position_x' in body, false);
    assert.equal('position_y' in body, false);
  });

  test('add_audio does not offer fade parameters the backend ignores', async () => {
    const { fetchImpl } = fakeBackend();
    const client = await connect(await testConfig(), fetchImpl);
    const { tools } = await client.listTools();
    const properties = Object.keys(
      (tools.find(t => t.name === 'capcut_add_audio')!.inputSchema as {
        properties?: Record<string, unknown>;
      }).properties ?? {}
    );
    assert.equal(properties.includes('fade_in'), false);
    assert.equal(properties.includes('fade_out'), false);
    assert.equal(properties.includes('audio_url'), true);
  });

  test('list_asset_types is a GET against a real catalogue route', async () => {
    const { requests, fetchImpl } = fakeBackend([{ name: 'Blur' }]);
    const client = await connect(await testConfig(), fetchImpl);

    const result = await client.callTool({
      name: 'capcut_list_asset_types',
      arguments: { category: 'video_scene_effect' },
    });

    assert.equal(isError(result), false, textOf(result));
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].url, 'http://127.0.0.1:9000/get_video_scene_effect_types');
  });

  test('a backend failure envelope surfaces as a tool error', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ success: false, output: '', error: "'srt' is missing" }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const client = await connect(await testConfig(), fetchImpl);

    const result = await client.callTool({
      name: 'capcut_create_draft',
      arguments: { width: 1080, height: 1920 },
    });
    assert.equal(isError(result), true);
    assert.match(textOf(result), /'srt' is missing/);
  });
});

describe('media guards at the tool boundary', () => {
  test('blocked media URLs never reach the backend', async () => {
    const { requests, fetchImpl } = fakeBackend();
    const client = await connect(await testConfig(), fetchImpl);

    for (const url of [
      'http://93.184.216.34/clip.mp4',
      'file:///etc/passwd',
      'https://127.0.0.1/clip.mp4',
      'https://192.168.1.9/clip.mp4',
      'https://169.254.169.254/latest/meta-data/',
      '/etc/passwd',
    ]) {
      const result = await client.callTool({
        name: 'capcut_add_video',
        arguments: { draft_id: 'dfd_1', video_url: url, start: 0, end: 1 },
      });
      assert.equal(isError(result), true, `${url} should be rejected`);
    }
    assert.equal(requests.length, 0, 'no blocked URL may reach the backend');
  });

  test('a public https media URL is accepted', async () => {
    const { requests, fetchImpl } = fakeBackend();
    const client = await connect(await testConfig(), fetchImpl);

    const result = await client.callTool({
      name: 'capcut_add_image',
      arguments: { draft_id: 'dfd_1', image_url: 'https://93.184.216.34/logo.png' },
    });
    assert.equal(isError(result), false, textOf(result));
    assert.equal(requests.length, 1);
  });

  test('local media is accepted only from an approved directory', async () => {
    const approved = await mkdtemp(path.join(os.tmpdir(), 'capcut-tool-media-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'capcut-tool-other-'));
    await writeFile(path.join(approved, 'clip.mp4'), 'x');
    await writeFile(path.join(outside, 'clip.mp4'), 'x');

    const { requests, fetchImpl } = fakeBackend();
    const client = await connect(await testConfig({ mediaDirs: [approved] }), fetchImpl);

    const allowed = await client.callTool({
      name: 'capcut_add_video',
      arguments: { draft_id: 'dfd_1', video_url: path.join(approved, 'clip.mp4') },
    });
    assert.equal(isError(allowed), false, textOf(allowed));

    const denied = await client.callTool({
      name: 'capcut_add_video',
      arguments: { draft_id: 'dfd_1', video_url: path.join(outside, 'clip.mp4') },
    });
    assert.equal(isError(denied), true);
    assert.equal(requests.length, 1);
  });

  test('unknown parameters are rejected rather than forwarded', async () => {
    const { requests, fetchImpl } = fakeBackend();
    const client = await connect(await testConfig(), fetchImpl);

    const result = await client.callTool({
      name: 'capcut_create_draft',
      arguments: { width: 1080, height: 1920, draft_folder: '/etc' },
    });
    assert.equal(isError(result), true);
    assert.equal(requests.length, 0);
  });

  test('out-of-range numerics are rejected, not coerced', async () => {
    const { requests, fetchImpl } = fakeBackend();
    const client = await connect(await testConfig(), fetchImpl);

    const cases: Array<[string, Record<string, unknown>]> = [
      ['capcut_create_draft', { width: 99999, height: 1080 }],
      ['capcut_add_text', { draft_id: 'd', text: 'x', start: 0, end: 1, font_alpha: 4 }],
      ['capcut_add_text', { draft_id: 'd', text: 'x', start: 0, end: 1, font_color: 'red' }],
      ['capcut_add_video', { draft_id: 'd', video_url: 'https://93.184.216.34/v.mp4', speed: 500 }],
      ['capcut_add_effect', { draft_id: 'd', effect_type: 'Blur', params: [900] }],
      ['capcut_add_image', { draft_id: 'd', image_url: 'https://93.184.216.34/i.png', scale_x: 0 }],
    ];

    for (const [name, args] of cases) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(isError(result), true, `${name} ${JSON.stringify(args)} should be rejected`);
    }
    assert.equal(requests.length, 0);
  });
});

describe('save_draft backups', () => {
  async function draftDirWithProject(): Promise<{ draftDir: string; projectDir: string }> {
    const draftDir = await mkdtemp(path.join(os.tmpdir(), 'capcut-save-'));
    const projectDir = path.join(draftDir, 'dfd_project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'draft_content.json'), '{"v":1}');
    return { draftDir, projectDir };
  }

  test('a backup is written before the backend is asked to save', async () => {
    const { draftDir, projectDir } = await draftDirWithProject();
    const { requests, fetchImpl } = fakeBackend({ draft_url: '/tmp/x' });
    const client = await connect(
      await testConfig({ draftDir, backupCoalesceSeconds: 0 }),
      fetchImpl
    );

    const result = await client.callTool({
      name: 'capcut_save_draft',
      arguments: { draft_id: 'dfd_project' },
    });

    assert.equal(isError(result), false, textOf(result));
    // The snapshot sits beside the project, not inside it: VectCutAPI removes
    // the project directory as part of saving.
    const backupRoot = path.join(draftDir, BACKUP_DIR_NAME, 'dfd_project');
    const versions = await readdir(backupRoot);
    assert.equal(versions.length, 1, 'exactly one snapshot should exist');
    assert.deepEqual(await readdir(path.join(backupRoot, versions[0])), ['draft_content.json']);

    // The backend is told where to write, and it is the approved directory.
    assert.equal(requests[0].url, 'http://127.0.0.1:9000/save_draft');
    assert.equal(requests[0].body!.draft_folder, draftDir);
    assert.equal(requests[0].body!.draft_id, 'dfd_project');
  });

  test('repeated saves in one session coalesce to a single snapshot', async () => {
    const { draftDir } = await draftDirWithProject();
    const { fetchImpl } = fakeBackend();
    const client = await connect(
      await testConfig({ draftDir, backupCoalesceSeconds: 300 }),
      fetchImpl
    );

    for (let i = 0; i < 4; i++) {
      await client.callTool({ name: 'capcut_save_draft', arguments: { draft_id: 'dfd_project' } });
    }
    const versions = await readdir(path.join(draftDir, BACKUP_DIR_NAME, 'dfd_project'));
    assert.equal(versions.length, 1, 'four saves in one session should leave one snapshot');
  });

  test('save_draft aborts when a complete backup cannot be taken', async () => {
    const { draftDir, projectDir } = await draftDirWithProject();
    await writeFile(path.join(projectDir, 'big.bin'), Buffer.alloc(4096));

    const { requests, fetchImpl } = fakeBackend();
    const client = await connect(
      await testConfig({ draftDir, backupCoalesceSeconds: 0, maxBackupBytes: 1024 }),
      fetchImpl
    );

    const result = await client.callTool({
      name: 'capcut_save_draft',
      arguments: { draft_id: 'dfd_project' },
    });

    // Fail closed: the backend deletes the project when it saves, so no backup
    // must mean no save.
    assert.equal(isError(result), true);
    assert.match(textOf(result), /Refusing to save/);
    assert.equal(requests.length, 0, 'the destructive save must not be attempted');
  });

  test('save_draft refuses a draft id that escapes the approved draft directory', async () => {
    const { draftDir } = await draftDirWithProject();
    const { requests, fetchImpl } = fakeBackend();
    const client = await connect(await testConfig({ draftDir }), fetchImpl);

    for (const draftId of ['../escape', 'a/b']) {
      const result = await client.callTool({
        name: 'capcut_save_draft',
        arguments: { draft_id: draftId },
      });
      assert.equal(isError(result), true, `${draftId} should be rejected`);
    }
    assert.equal(requests.length, 0);
  });

  test('save_draft explains itself when no draft directory is configured', async () => {
    const { requests, fetchImpl } = fakeBackend();
    const client = await connect(await testConfig({ draftDir: null }), fetchImpl);

    const result = await client.callTool({
      name: 'capcut_save_draft',
      arguments: { draft_id: 'dfd_project' },
    });
    assert.equal(isError(result), true);
    assert.match(textOf(result), /CAPCUT_DRAFT_DIR/);
    assert.equal(requests.length, 0);
  });
});

describe('restore tool', () => {
  test('lists versions without changing anything, then restores one', async () => {
    const draftDir = await mkdtemp(path.join(os.tmpdir(), 'capcut-restore-'));
    const projectDir = path.join(draftDir, 'dfd_project');
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'draft_content.json'), '{"v":1}');

    const { fetchImpl } = fakeBackend();
    const client = await connect(
      await testConfig({ draftDir, backupCoalesceSeconds: 0 }),
      fetchImpl
    );

    // No backups yet.
    const empty = await client.callTool({
      name: 'capcut_restore_backup',
      arguments: { draft_id: 'dfd_project' },
    });
    assert.equal(isError(empty), false, textOf(empty));
    assert.match(textOf(empty), /No backups/);

    // A save creates one.
    await client.callTool({ name: 'capcut_save_draft', arguments: { draft_id: 'dfd_project' } });
    const listed = await client.callTool({
      name: 'capcut_restore_backup',
      arguments: { draft_id: 'dfd_project' },
    });
    assert.equal(isError(listed), false, textOf(listed));
    const version = (
      listed as unknown as { structuredContent: { versions: Array<{ version: string }> } }
    ).structuredContent.versions[0].version;

    const restored = await client.callTool({
      name: 'capcut_restore_backup',
      arguments: { draft_id: 'dfd_project', version },
    });
    assert.equal(isError(restored), false, textOf(restored));
    assert.match(textOf(restored), new RegExp(version));
  });

  test('rejects arbitrary source and destination paths', async () => {
    const draftDir = await mkdtemp(path.join(os.tmpdir(), 'capcut-restore2-'));
    await mkdir(path.join(draftDir, 'dfd_project'), { recursive: true });

    const { fetchImpl } = fakeBackend();
    const client = await connect(await testConfig({ draftDir }), fetchImpl);

    for (const args of [
      { draft_id: '../elsewhere', version: '2026-01-01_00-00-00' },
      { draft_id: 'dfd_project', version: '../../etc' },
      { draft_id: 'dfd_project', version: '/etc/passwd' },
      { draft_id: 'dfd_project', version: 'latest' },
    ]) {
      const result = await client.callTool({ name: 'capcut_restore_backup', arguments: args });
      assert.equal(isError(result), true, `${JSON.stringify(args)} should be rejected`);
    }
  });
});
