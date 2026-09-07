# Security model and audit findings

This fork exists to make the CapCut MCP safe to run locally alongside Claude
Code and Codex. This document records what the audit found and what the code now
guarantees.

## Intended architecture

```
Claude Code / Codex
   |  stdio only (no socket, no port)
   v
capcut-mcp-server            <- this repo: validation, backups, guards
   |  HTTP to 127.0.0.1 only
   v
VectCutAPI (loopback)        <- external, patched via vectcutapi/
   |
   v
CapCut draft files on disk
```

The MCP process never listens on a network interface. It is spawned by the MCP
client, speaks the protocol over stdin/stdout, and makes outbound requests to
exactly one place: a loopback VectCutAPI.

## Findings

Severity reflects the risk when running this MCP locally with an agent driving
it. "Wrapper" is this repository; "backend" is sun-guannan/VectCutAPI.

### 1. Destructive save with no backup — CRITICAL (wrapper + backend)

`save_draft_impl.py` does:

```python
if os.path.exists(draft_dir):
    shutil.rmtree(draft_dir)
shutil.copytree(template_source_dir, draft_dir)
```

Saving to a `draft_id` that already exists **deletes the entire existing project
directory**, assets included, and rebuilds it from a template. There is no
prompt, no versioning, and CapCut keeps no history of its own. An agent that
reuses a draft id destroys the user's work irrecoverably.

Fixed by snapshotting the whole project before every save. Because the save
deletes the project directory, snapshots **cannot** live inside it; they are
written to `<CAPCUT_DRAFT_DIR>/.smartcut_backups/<draft_id>/<timestamp>/`, a
sibling tree. If a complete snapshot cannot be taken (for example the project
exceeds `CAPCUT_MAX_BACKUP_BYTES`), the save is refused rather than performed
with a partial backup.

### 2. HTTP transport on a network interface — HIGH (wrapper)

`TRANSPORT=http` started an Express server via
`StreamableHTTPServerTransport`, with `app.listen(port)` bound to every
interface and no authentication. Anyone able to reach the port could drive every
editing tool.

The HTTP path is removed, not gated. `express` is gone from `dependencies`,
`TRANSPORT`/`PORT` are no longer read, and a test asserts the source imports no
HTTP server and connects exactly one transport.

### 3. Backend URL was an unvalidated environment variable — HIGH (wrapper)

`CAPCUT_API_URL` was passed straight to `axios.create({ baseURL })`. Any value
was accepted, so a stray or hostile config could aim every draft, media URL and
project path at a remote server.

`assertLoopbackBackendUrl` now allowlists `http://localhost`, `http://127.0.0.1`
and `http://[::1]`, rejects credentials, query strings and non-HTTP schemes, and
runs both at startup and again in the API client constructor. Obfuscated
spellings (`http://2130706433`, `http://0x7f.0.0.1`) are normalised by the URL
parser to `127.0.0.1` before the check, so they are correctly treated as
loopback; anything that normalises elsewhere fails the allowlist.

### 4. Media URLs were an SSRF primitive — HIGH (wrapper + backend)

Media references were validated only with Zod's `.url()`, then handed to the
backend, which passes them to `ffmpeg -i <url>` (`downloader.py`) and, for
subtitles, to `requests.get` (`add_subtitle_impl.py`). ffmpeg speaks `file:`,
`concat:`, `rtmp:` and more, and both fetchers follow redirects. An agent could
therefore read local files or reach the LAN and cloud metadata endpoints through
the backend.

Media references are now either an `https:` URL or an absolute path inside
`CAPCUT_MEDIA_DIRS`. URLs are rejected for non-HTTPS schemes, embedded
credentials, local/metadata hostnames, and any DNS answer in a private,
loopback, link-local, CGNAT, multicast or reserved range — including IPv4
smuggled inside IPv6 (`::ffff:`, NAT64, 6to4). The optional preflight walks the
redirect chain with `redirect: 'manual'`, re-validating each hop, and enforces
`CAPCUT_MAX_DOWNLOAD_BYTES` against the advertised `Content-Length`.

### 5. Unrestricted filesystem reach — HIGH (wrapper)

Nothing constrained which paths could be referenced. Local paths are now
resolved through `realpath` and must land inside an approved root; the resolve
happens **before** the containment check, which is what defeats `../`, symlink
escapes and alternate spellings in one step. Draft ids and backup versions are
validated as single safe path segments.

### 6. Cloud upload was one config flag away — MEDIUM (backend)

`save_draft_impl.py` imports `oss.upload_to_oss` at module scope; `oss.py`
imports `oss2` at module scope. So the Alibaba OSS SDK was a hard install
requirement (the server will not even start without it), the upload code was
always loaded, and `is_upload_draft: true` in a copied config would silently
upload a zip of the whole project to third-party object storage.

`vectcutapi/disable-cloud-upload.patch` makes the import lazy and requires both
`is_upload_draft: true` **and** `CAPCUT_ALLOW_CLOUD_UPLOAD=1`. With `oss2`
uninstalled (see `vectcutapi/requirements-pinned.txt`) the path fails closed.
The MCP additionally refuses to start if `CAPCUT_ALLOW_CLOUD_UPLOAD` is set.

Upstream also defaults `draft_domain` to a third-party host
(`https://www.install-ai-guider.top`). Nothing is sent there — it only builds a
returned URL string — but `vectcutapi/config.json` pins it to loopback so no
off-box address is handed back to an agent.

### 7. Backend bound to 0.0.0.0 — HIGH (backend)

`capcut_server.py` ends with `app.run(host='0.0.0.0', port=PORT)`. Every
unauthenticated editing route was reachable from the whole network.
`vectcutapi/bind-localhost.patch` defaults the bind to `127.0.0.1` and refuses
any non-loopback `--host`.

### 8. Unpinned dependencies — MEDIUM (both)

`package-lock.json` was in `.gitignore`, and every dependency used a caret
range, so two installs could resolve differently. The lockfile is now committed,
every version is exact, and a test asserts both. VectCutAPI's `requirements.txt`
is entirely unpinned; `vectcutapi/requirements-pinned.txt` pins it.

### 9. Weak input validation — MEDIUM (wrapper)

Schemas accepted values the backend cannot use and omitted cross-field checks
(for example `times` and `values` of different lengths). All numerics are now
bounded, all objects are `.strict()` so unknown keys are rejected rather than
stripped, and cross-field invariants are enforced before any request is made.

### 10. No command execution — verified clean (wrapper)

The audit found no `child_process`, `exec`, `spawn`, `eval` or `new Function`
anywhere in the wrapper, and no tool exposing a command, script or executable
path. A test asserts this over the whole source tree so it stays true.

The backend does shell out to `ffmpeg`/`ffprobe`, but always with an argv array
and never `shell=True`, so there is no shell metacharacter injection. The
argument that *is* attacker-influenced is the media URL, which is why the SSRF
guard above matters.

## What is enforced, and where

| Control | Enforced in |
| --- | --- |
| stdio-only transport | `src/index.ts` |
| loopback-only backend | `src/security/backend-url.ts`, re-checked in `src/services/api-client.ts` |
| media URL / SSRF policy | `src/security/media-url.ts`, `src/security/ip-ranges.ts` |
| path containment | `src/security/paths.ts` |
| backups, atomic writes, restore | `src/services/backup.ts` |
| input validation | `src/schemas/index.ts` |
| fail-closed configuration | `src/config.ts` |

## Residual risks

- **The backend is still unauthenticated on loopback.** Any local process or any
  other local agent can call it directly, bypassing this MCP and all of its
  guards. Loopback-only binding limits this to code already running as you.
- **Backend-side validation is unchanged.** This MCP validates what it sends;
  it cannot stop something else from sending the backend something worse.
- **The media preflight is advisory.** The backend performs the real download
  with its own resolver, so a hostile DNS server could answer differently for
  the preflight and the fetch (a classic TOCTOU rebind). Turning the preflight
  off (`CAPCUT_MEDIA_PREFLIGHT=0`) leaves the structural and DNS checks intact
  but drops redirect and size validation.
- **Backups are on the same disk** as the projects they protect. They survive a
  bad save; they do not survive a failed disk. They are not a substitute for
  a real backup of your CapCut library.
- **Backups accumulate.** Nothing prunes `.smartcut_backups`. Clear it manually
  when it grows.
- **The `vectcutapi/` patches are not applied automatically.** Until you apply
  them, the backend still binds `0.0.0.0` and still needs `oss2` installed.
