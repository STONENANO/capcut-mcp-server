#!/usr/bin/env node

/**
 * CapCut MCP Server -- local-only build.
 *
 * Transport is stdio and only stdio. This process never opens a listening
 * socket: the MCP client spawns it, talks to it over the pipe, and it talks
 * outward only to a VectCutAPI on loopback. An HTTP transport was removed
 * rather than gated, because a gate is something that can be flipped on by a
 * stray environment variable and a removed code path is not.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, type ServerConfig } from './config.js';
import { CapCutApiClient } from './services/api-client.js';
import { registerTools } from './tools/index.js';

const VERSION = '2.0.0-local';

const HELP = `CapCut MCP Server (local-only fork) v${VERSION}

USAGE:
  capcut-mcp-server [--help] [--version]

TRANSPORT:
  stdio only. This build has no HTTP transport and never listens on a port.

ENVIRONMENT:
  CAPCUT_API_URL                VectCutAPI base URL. Must be loopback plain HTTP,
                                e.g. http://127.0.0.1:9000 (the default).
                                Anything else is refused at startup.
  CAPCUT_DRAFT_DIR              Your CapCut "Draft Content" directory. Required for
                                capcut_save_draft and capcut_restore_backup.
  CAPCUT_MEDIA_DIRS             Colon-separated directories from which local media
                                files may be read. Unset means: remote https only.
  CAPCUT_MAX_DOWNLOAD_BYTES     Media size cap (default 536870912 = 512 MiB).
  CAPCUT_REQUEST_TIMEOUT_MS     Network timeout in ms (default 120000).
  CAPCUT_MEDIA_PREFLIGHT        Check media URLs and their redirects before use
                                (default on; set 0 to skip the network check).
  CAPCUT_MAX_REDIRECTS          Redirect hops allowed during preflight (default 5).
  CAPCUT_BACKUP_COALESCE_SECONDS
                                Suppress a new project backup if one is newer than
                                this (default 300).
  CAPCUT_ALLOW_CLOUD_UPLOAD     Must stay unset/0. Cloud upload is disabled.

CONFIGURATION (Claude Code / Codex):
  {
    "mcpServers": {
      "capcut": {
        "command": "node",
        "args": ["/absolute/path/to/capcut-mcp-server/dist/index.js"],
        "env": {
          "CAPCUT_API_URL": "http://127.0.0.1:9000",
          "CAPCUT_DRAFT_DIR": "/Users/you/Movies/CapCut/User Data/Projects/com.lveditor.draft",
          "CAPCUT_MEDIA_DIRS": "/Users/you/Movies/capcut-media"
        }
      }
    }
  }

PREREQUISITE:
  VectCutAPI must be running and bound to loopback:
    python capcut_server.py --host 127.0.0.1
`;

/** Log to stderr. stdout is the MCP transport and must carry only protocol. */
function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Report the effective configuration without disclosing secrets.
 * Directory paths are reported as counts, not values, so a shared terminal
 * transcript does not spell out where the user's files live.
 */
function describeConfig(config: ServerConfig): string {
  return [
    `backend=${config.backendUrl}`,
    `draftDir=${config.draftDir ? 'configured' : 'unset'}`,
    `mediaDirs=${config.mediaDirs.length}`,
    `mediaPreflight=${config.mediaPreflight ? 'on' : 'off'}`,
    `maxDownloadBytes=${config.maxDownloadBytes}`,
    `cloudUpload=disabled`,
  ].join(' ');
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    process.stdout.write(`capcut-mcp-server v${VERSION}\n`);
    return;
  }

  const config = await loadConfig();

  if (config.allowCloudUpload) {
    throw new Error(
      'CAPCUT_ALLOW_CLOUD_UPLOAD is set, but this fork has no cloud upload path. ' +
        'Unset it, and make sure "is_upload_draft" is false in VectCutAPI\'s config.json ' +
        'so drafts are never uploaded to object storage.'
    );
  }

  const client = new CapCutApiClient({
    baseUrl: config.backendUrl,
    timeoutMs: config.requestTimeoutMs,
  });

  const server = new McpServer({ name: 'capcut-mcp-server', version: VERSION });
  registerTools(server, { client, config });

  await server.connect(new StdioServerTransport());
  log(`CapCut MCP server v${VERSION} ready on stdio (${describeConfig(config)})`);
}

main().catch((error: unknown) => {
  log(`Startup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
